use crate::js;
use crate::manifest;
use crate::ops::OpCtx;
use crate::rt::Runtime;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Clone)]
enum Cp {
    Empty,
    Utf8(String),
    Int(i32),
    Float(u32),
    Long(i64),
    Double(u64),
    Class(u16),
    Str(u16),
    Ref(u16, u16),
    Nat(u16, u16),
    Handle(u8, u16),
    MethodType(u16),
    Dynamic(u16, u16),
    Named(u16),
}

pub struct Member {
    pub access: u16,
    pub name: String,
    pub desc: String,
    pub code: Option<String>,
    pub calls: Vec<(String, String)>,
}

pub struct ClassFile {
    pub name: String,
    pub access: u16,
    pub super_name: Option<String>,
    pub interfaces: Vec<String>,
    pub fields: Vec<Member>,
    pub methods: Vec<Member>,
    pub nest: Vec<String>,
    pub mixin: bool,
}

struct Reader<'a> {
    b: &'a [u8],
    p: usize,
}

const BAD: &str = "is not a valid class file";

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        if self.p + n > self.b.len() {
            return Err(BAD.into());
        }
        let s = &self.b[self.p..self.p + n];
        self.p += n;
        Ok(s)
    }
    fn u1(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }
    fn u2(&mut self) -> Result<u16, String> {
        let s = self.take(2)?;
        Ok(u16::from_be_bytes([s[0], s[1]]))
    }
    fn u4(&mut self) -> Result<u32, String> {
        let s = self.take(4)?;
        Ok(u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
    }
}

fn be_i32(b: &[u8], at: usize) -> Result<i32, String> {
    b.get(at..at + 4).map(|s| i32::from_be_bytes([s[0], s[1], s[2], s[3]])).ok_or_else(|| BAD.to_string())
}

struct Pool(Vec<Cp>);

impl Pool {
    fn get(&self, i: u16) -> Result<&Cp, String> {
        self.0.get(i as usize).ok_or_else(|| BAD.to_string())
    }
    fn utf8(&self, i: u16) -> Result<String, String> {
        match self.get(i)? {
            Cp::Utf8(s) => Ok(s.clone()),
            _ => Err(BAD.into()),
        }
    }
    fn class(&self, i: u16) -> Result<String, String> {
        match self.get(i)? {
            Cp::Class(n) => self.utf8(*n),
            _ => Err(BAD.into()),
        }
    }
    fn text(&self, i: u16) -> Result<String, String> {
        Ok(match self.get(i)? {
            Cp::Empty => String::new(),
            Cp::Utf8(s) => s.clone(),
            Cp::Int(v) => format!("i{v}"),
            Cp::Float(v) => format!("f{v}"),
            Cp::Long(v) => format!("l{v}"),
            Cp::Double(v) => format!("d{v}"),
            Cp::Class(n) => format!("C{}", self.utf8(*n)?),
            Cp::Str(n) => format!("S{:?}", self.utf8(*n)?),
            Cp::Ref(c, nat) => format!("{}.{}", self.class(*c)?, self.text(*nat)?),
            Cp::Nat(n, d) => format!("{}:{}", self.utf8(*n)?, self.utf8(*d)?),
            Cp::Handle(k, r) => format!("H{k}:{}", self.text(*r)?),
            Cp::MethodType(d) => format!("T{}", self.utf8(*d)?),
            Cp::Dynamic(b, nat) => format!("Y{b}:{}", self.text(*nat)?),
            Cp::Named(n) => self.utf8(*n)?,
        })
    }
    fn call(&self, i: u16) -> Option<(String, String)> {
        match self.get(i).ok()? {
            Cp::Ref(c, nat) => {
                let owner = self.class(*c).ok()?;
                match self.get(*nat).ok()? {
                    Cp::Nat(n, _) => Some((owner, self.utf8(*n).ok()?)),
                    _ => None,
                }
            }
            _ => None,
        }
    }
}

fn normalize_code(code: &[u8], pool: &Pool, calls: &mut Vec<(String, String)>) -> Result<String, String> {
    let mut out = Vec::new();
    let mut pc = 0usize;
    let u2 = |at: usize| -> Result<u16, String> { code.get(at..at + 2).map(|s| u16::from_be_bytes([s[0], s[1]])).ok_or_else(|| BAD.to_string()) };
    while pc < code.len() {
        let op = code[pc];
        let mut tok = format!("{op}");
        let len = match op {
            0x10 | 0x15..=0x19 | 0x36..=0x3a | 0xa9 | 0xbc => {
                tok.push_str(&format!(" {}", code.get(pc + 1).ok_or(BAD)?));
                2
            }
            0x12 => {
                tok.push_str(&format!(" {}", pool.text(*code.get(pc + 1).ok_or(BAD)? as u16)?));
                2
            }
            0x11 | 0x84 | 0x99..=0xa8 | 0xc6 | 0xc7 => {
                tok.push_str(&format!(" {}", u2(pc + 1)?));
                3
            }
            0x13 | 0x14 | 0xb2..=0xb8 | 0xbb | 0xbd | 0xc0 | 0xc1 => {
                let i = u2(pc + 1)?;
                if (0xb6..=0xb8).contains(&op) {
                    if let Some(c) = pool.call(i) {
                        calls.push(c);
                    }
                }
                tok.push_str(&format!(" {}", pool.text(i)?));
                3
            }
            0xc5 => {
                tok.push_str(&format!(" {} {}", pool.text(u2(pc + 1)?)?, code.get(pc + 3).ok_or(BAD)?));
                4
            }
            0xb9 | 0xba => {
                let i = u2(pc + 1)?;
                if op == 0xb9 {
                    if let Some(c) = pool.call(i) {
                        calls.push(c);
                    }
                }
                tok.push_str(&format!(" {}", pool.text(i)?));
                5
            }
            0xc8 | 0xc9 => {
                tok.push_str(&format!(" {}", be_i32(code, pc + 1)?));
                5
            }
            0xc4 => {
                let inner = *code.get(pc + 1).ok_or(BAD)?;
                if inner == 0x84 {
                    tok.push_str(&format!(" {} {}", u2(pc + 2)?, u2(pc + 4)?));
                    6
                } else {
                    tok.push_str(&format!(" {inner} {}", u2(pc + 2)?));
                    4
                }
            }
            0xaa | 0xab => {
                let start = (pc + 4) & !3;
                let default = be_i32(code, start)?;
                if op == 0xaa {
                    let low = be_i32(code, start + 4)?;
                    let high = be_i32(code, start + 8)?;
                    if high < low {
                        return Err(BAD.into());
                    }
                    let n = (high - low + 1) as usize;
                    let mut targets = Vec::with_capacity(n);
                    for k in 0..n {
                        targets.push(be_i32(code, start + 12 + 4 * k)?.to_string());
                    }
                    tok.push_str(&format!(" {default} {low} {high} {}", targets.join(",")));
                    start + 12 + 4 * n - pc
                } else {
                    let n = be_i32(code, start + 4)?;
                    if n < 0 {
                        return Err(BAD.into());
                    }
                    let mut pairs = Vec::new();
                    for k in 0..n as usize {
                        pairs.push(format!("{}={}", be_i32(code, start + 8 + 8 * k)?, be_i32(code, start + 12 + 8 * k)?));
                    }
                    tok.push_str(&format!(" {default} {}", pairs.join(",")));
                    start + 8 + 8 * n as usize - pc
                }
            }
            _ => 1,
        };
        out.push(tok);
        pc += len;
    }
    Ok(out.join(";"))
}

fn read_members(r: &mut Reader, pool: &Pool, methods: bool) -> Result<Vec<Member>, String> {
    let n = r.u2()?;
    let mut out = Vec::new();
    for _ in 0..n {
        let access = r.u2()?;
        let name = pool.utf8(r.u2()?)?;
        let desc = pool.utf8(r.u2()?)?;
        let mut code = None;
        let mut calls = Vec::new();
        for _ in 0..r.u2()? {
            let attr = pool.utf8(r.u2()?)?;
            let len = r.u4()? as usize;
            let body = r.take(len)?;
            if methods && attr == "Code" {
                let mut c = Reader { b: body, p: 4 };
                let code_len = c.u4()? as usize;
                let bytes = c.take(code_len)?;
                let mut text = normalize_code(bytes, pool, &mut calls)?;
                for _ in 0..c.u2()? {
                    let (a, b, h, t) = (c.u2()?, c.u2()?, c.u2()?, c.u2()?);
                    text.push_str(&format!("|{a},{b},{h},{}", if t == 0 { String::new() } else { pool.class(t)? }));
                }
                code = Some(text);
            }
        }
        out.push(Member { access, name, desc, code, calls });
    }
    Ok(out)
}

pub fn parse_class(bytes: &[u8]) -> Result<ClassFile, String> {
    let mut r = Reader { b: bytes, p: 0 };
    if r.u4()? != 0xCAFE_BABE {
        return Err(BAD.into());
    }
    r.u2()?;
    r.u2()?;
    let count = r.u2()?;
    let mut entries = vec![Cp::Empty];
    let mut i = 1;
    while i < count {
        let tag = r.u1()?;
        let e = match tag {
            1 => {
                let len = r.u2()? as usize;
                Cp::Utf8(String::from_utf8_lossy(r.take(len)?).to_string())
            }
            3 => Cp::Int(r.u4()? as i32),
            4 => Cp::Float(r.u4()?),
            5 => Cp::Long(((r.u4()? as u64) << 32 | r.u4()? as u64) as i64),
            6 => Cp::Double((r.u4()? as u64) << 32 | r.u4()? as u64),
            7 => Cp::Class(r.u2()?),
            8 => Cp::Str(r.u2()?),
            9..=11 => Cp::Ref(r.u2()?, r.u2()?),
            12 => Cp::Nat(r.u2()?, r.u2()?),
            15 => Cp::Handle(r.u1()?, r.u2()?),
            16 => Cp::MethodType(r.u2()?),
            17 | 18 => Cp::Dynamic(r.u2()?, r.u2()?),
            19 | 20 => Cp::Named(r.u2()?),
            _ => return Err(BAD.into()),
        };
        entries.push(e);
        i += 1;
        if tag == 5 || tag == 6 {
            entries.push(Cp::Empty);
            i += 1;
        }
    }
    let pool = Pool(entries);
    let access = r.u2()?;
    let name = pool.class(r.u2()?)?;
    let sup = r.u2()?;
    let super_name = if sup == 0 { None } else { Some(pool.class(sup)?) };
    let mut interfaces = Vec::new();
    for _ in 0..r.u2()? {
        interfaces.push(pool.class(r.u2()?)?);
    }
    let fields = read_members(&mut r, &pool, false)?;
    let methods = read_members(&mut r, &pool, true)?;
    let mut nest = Vec::new();
    let mut mixin = false;
    for _ in 0..r.u2()? {
        let attr = pool.utf8(r.u2()?)?;
        let len = r.u4()? as usize;
        let body = r.take(len)?;
        let mut a = Reader { b: body, p: 0 };
        match attr.as_str() {
            "NestHost" => nest.push(format!("host {}", pool.class(a.u2()?)?)),
            "NestMembers" | "PermittedSubclasses" => {
                let mut names = Vec::new();
                for _ in 0..a.u2()? {
                    names.push(pool.class(a.u2()?)?);
                }
                names.sort();
                nest.push(format!("{attr} {}", names.join(",")));
            }
            "Record" => {
                let mut comps = Vec::new();
                for _ in 0..a.u2()? {
                    comps.push(format!("{}:{}", pool.utf8(a.u2()?)?, pool.utf8(a.u2()?)?));
                    for _ in 0..a.u2()? {
                        a.u2()?;
                        let l = a.u4()? as usize;
                        a.take(l)?;
                    }
                }
                nest.push(format!("record {}", comps.join(",")));
            }
            "RuntimeInvisibleAnnotations" | "RuntimeVisibleAnnotations" => {
                mixin |= pool.0.iter().any(|c| matches!(c, Cp::Utf8(t) if t == "Lorg/spongepowered/asm/mixin/Mixin;"));
            }
            _ => {}
        }
    }
    Ok(ClassFile { name, access, super_name, interfaces, fields, methods, nest, mixin })
}

fn java_type(desc: &str, i: &mut usize) -> String {
    let b = desc.as_bytes();
    let mut dims = 0;
    while *i < b.len() && b[*i] == b'[' {
        dims += 1;
        *i += 1;
    }
    let base = match b.get(*i).copied() {
        Some(b'L') => {
            let end = desc[*i..].find(';').map(|e| *i + e).unwrap_or(desc.len());
            let full = &desc[*i + 1..end];
            *i = end + 1;
            full.rsplit('/').next().unwrap_or(full).replace('$', ".")
        }
        Some(c) => {
            *i += 1;
            match c {
                b'B' => "byte",
                b'C' => "char",
                b'D' => "double",
                b'F' => "float",
                b'I' => "int",
                b'J' => "long",
                b'S' => "short",
                b'Z' => "boolean",
                b'V' => "void",
                _ => "?",
            }
            .to_string()
        }
        None => "?".to_string(),
    };
    format!("{base}{}", "[]".repeat(dims))
}

pub fn describe_member(name: &str, desc: &str) -> String {
    if !desc.starts_with('(') {
        let mut i = 0;
        return format!("{} {name}", java_type(desc, &mut i));
    }
    let mut i = 1;
    let mut params = Vec::new();
    while i < desc.len() && desc.as_bytes()[i] != b')' {
        params.push(java_type(desc, &mut i));
    }
    i += 1;
    let ret = java_type(desc, &mut i);
    match name {
        "<init>" => format!("constructor({})", params.join(", ")),
        "<clinit>" => "static initializer".into(),
        _ => format!("{ret} {name}({})", params.join(", ")),
    }
}

fn is_registration(owner: &str, name: &str) -> bool {
    let simple = owner.rsplit('/').next().unwrap_or(owner);
    name.starts_with("register") && (simple == "Registry" || simple.starts_with("DeferredRegister") || simple == "Registries" || simple.ends_with("RegistryHelper"))
}

pub fn dotted(internal: &str) -> String {
    internal.replace('/', ".")
}

pub fn classify(old: Option<&ClassFile>, new: Option<&ClassFile>) -> Value {
    let (name, change) = match (old, new) {
        (None, Some(n)) => (n.name.clone(), "added"),
        (Some(o), None) => (o.name.clone(), "removed"),
        (Some(o), Some(_)) => (o.name.clone(), "modified"),
        (None, None) => return json!(null),
    };
    let mut reasons: Vec<String> = Vec::new();
    let mut methods: Vec<String> = Vec::new();
    if let (Some(o), None) = (old, new) {
        if o.mixin {
            reasons.push("Mixin class removed (mixins are applied when the game starts)".into());
        } else {
            reasons.push("Class removed (the running game still has it)".into());
        }
    }
    if let (None, Some(n)) = (old, new) {
        if n.mixin {
            reasons.push("New mixin class (mixins are applied when the game starts)".into());
        }
    }
    if let (Some(o), Some(n)) = (old, new) {
        if o.super_name != n.super_name {
            reasons.push(format!(
                "Superclass changed from {} to {}",
                o.super_name.as_deref().map(dotted).unwrap_or_default(),
                n.super_name.as_deref().map(dotted).unwrap_or_default()
            ));
        }
        let (oi, ni): (BTreeSet<&String>, BTreeSet<&String>) = (o.interfaces.iter().collect(), n.interfaces.iter().collect());
        if oi != ni {
            reasons.push("Implemented interfaces changed".into());
        }
        if (o.access & !0x0020) != (n.access & !0x0020) {
            reasons.push("Class modifiers changed".into());
        }
        let (on, nn): (BTreeSet<&String>, BTreeSet<&String>) = (o.nest.iter().collect(), n.nest.iter().collect());
        if on != nn {
            reasons.push("Nested, permitted or record classes changed".into());
        }
        let key = |m: &Member| format!("{}{}", m.name, m.desc);
        for f in &n.fields {
            match o.fields.iter().find(|x| x.name == f.name && x.desc == f.desc) {
                None => reasons.push(format!("Field added: {}", describe_member(&f.name, &f.desc))),
                Some(x) if x.access != f.access => reasons.push(format!("Field modifiers changed: {}", describe_member(&f.name, &f.desc))),
                _ => {}
            }
        }
        for f in &o.fields {
            if !n.fields.iter().any(|x| x.name == f.name && x.desc == f.desc) {
                reasons.push(format!("Field removed: {}", describe_member(&f.name, &f.desc)));
            }
        }
        for m in &n.methods {
            match o.methods.iter().find(|x| key(x) == key(m)) {
                None => {
                    if m.name == "<clinit>" {
                        reasons.push("Static initializer added (it would not run in the running game)".into());
                    } else {
                        reasons.push(format!("Method added: {}", describe_member(&m.name, &m.desc)));
                    }
                }
                Some(x) => {
                    if x.access != m.access {
                        reasons.push(format!("Method modifiers changed: {}", describe_member(&m.name, &m.desc)));
                    }
                    if x.code != m.code {
                        if m.name == "<clinit>" {
                            reasons.push("Static initializer changed (it already ran when the class loaded)".into());
                        } else {
                            methods.push(describe_member(&m.name, &m.desc));
                            let regs: BTreeSet<String> = m.calls.iter().chain(x.calls.iter()).filter(|(c, n)| is_registration(c, n)).map(|(c, n)| format!("{}.{n}", c.rsplit('/').next().unwrap_or(c))).collect();
                            if !regs.is_empty() {
                                reasons.push(format!(
                                    "{} registers game content ({}); registration only runs at startup",
                                    describe_member(&m.name, &m.desc),
                                    regs.into_iter().collect::<Vec<_>>().join(", ")
                                ));
                            }
                        }
                    }
                }
            }
        }
        for m in &o.methods {
            if !n.methods.iter().any(|x| key(x) == key(m)) {
                reasons.push(if m.name == "<clinit>" { "Static initializer removed".into() } else { format!("Method removed: {}", describe_member(&m.name, &m.desc)) });
            }
        }
        if (o.mixin || n.mixin) && reasons.iter().all(|r| !r.starts_with("Mixin")) {
            reasons.insert(0, "Mixin class (mixins are applied when the game starts)".into());
        }
    }
    json!({ "class": dotted(&name), "change": change, "hotswap": reasons.is_empty(), "methods": methods, "reasons": reasons })
}

fn walk_classes(root: &Path, dir: &Path, out: &mut BTreeMap<String, PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk_classes(root, &p, out);
        } else if p.extension().is_some_and(|x| x == "class") {
            if let Ok(rel) = p.strip_prefix(root) {
                out.insert(rel.to_string_lossy().replace('\\', "/"), p);
            }
        }
    }
}

pub fn class_dirs(project: &Path, classpath: &[String]) -> Vec<PathBuf> {
    let root = js::absolute(&project.to_string_lossy()).to_string_lossy().replace('\\', "/").to_lowercase();
    let mut out: Vec<PathBuf> = Vec::new();
    for entry in classpath {
        let p = PathBuf::from(entry);
        if !p.is_dir() {
            continue;
        }
        let norm = js::absolute(entry).to_string_lossy().replace('\\', "/").to_lowercase();
        let inside = norm.starts_with(&format!("{root}/"));
        let classes = norm.split('/').any(|s| s == "classes");
        if inside && classes && !out.contains(&p) {
            out.push(p);
        }
    }
    out
}

pub fn state_path(project: &Path, profile: &str, side: &str) -> PathBuf {
    manifest::state_dir(project).join("hotswap").join(format!("{profile}-{side}"))
}

pub fn snapshot(state: &Path, instance: &str, dirs: &[PathBuf]) -> Result<usize, String> {
    let _ = fs::remove_dir_all(state);
    let mut count = 0;
    for (i, d) in dirs.iter().enumerate() {
        let mut files = BTreeMap::new();
        walk_classes(d, d, &mut files);
        for (rel, src) in files {
            let dest = state.join("baseline").join(i.to_string()).join(&rel);
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent).map_err(|e| js::fs_error(&e, "mkdir", parent))?;
            }
            fs::copy(&src, &dest).map_err(|e| js::fs_error(&e, "copyfile", &src))?;
            count += 1;
        }
    }
    fs::create_dir_all(state).map_err(|e| js::fs_error(&e, "mkdir", state))?;
    let info = json!({ "instance": instance, "dirs": dirs.iter().map(|d| d.to_string_lossy().to_string()).collect::<Vec<_>>() });
    fs::write(state.join("state.json"), info.to_string()).map_err(|e| js::fs_error(&e, "open", &state.join("state.json")))?;
    Ok(count)
}

pub struct Changed {
    pub dir: usize,
    pub rel: String,
    pub old: Option<Vec<u8>>,
    pub new: Option<Vec<u8>>,
}

pub fn changed_classes(state: &Path, dirs: &[PathBuf]) -> Vec<Changed> {
    let mut out = Vec::new();
    for (i, d) in dirs.iter().enumerate() {
        let base = state.join("baseline").join(i.to_string());
        let (mut now, mut before) = (BTreeMap::new(), BTreeMap::new());
        walk_classes(d, d, &mut now);
        walk_classes(&base, &base, &mut before);
        let keys: BTreeSet<&String> = now.keys().chain(before.keys()).collect();
        for rel in keys {
            let new = now.get(rel).and_then(|p| fs::read(p).ok());
            let old = before.get(rel).and_then(|p| fs::read(p).ok());
            if new != old {
                out.push(Changed { dir: i, rel: rel.clone(), old, new });
            }
        }
    }
    out
}

pub fn accept(state: &Path, changes: &[Changed]) {
    for c in changes {
        let dest = state.join("baseline").join(c.dir.to_string()).join(&c.rel);
        match &c.new {
            Some(bytes) => {
                if let Some(p) = dest.parent() {
                    let _ = fs::create_dir_all(p);
                }
                let _ = fs::write(&dest, bytes);
            }
            None => {
                let _ = fs::remove_file(&dest);
            }
        }
    }
}

pub fn port_free(port: u16) -> bool {
    TcpListener::bind((Ipv4Addr::LOCALHOST, port)).is_ok()
}

pub struct Jdwp {
    s: TcpStream,
    id: u32,
    ref_size: usize,
}

pub enum JdwpError {
    Io(String),
    Code(u16),
}

pub fn jdwp_error_text(code: u16) -> String {
    match code {
        21 => "the class is not loaded".into(),
        60 => "the class file is invalid".into(),
        61 => "the class hierarchy would become circular".into(),
        62 => "the new bytecode does not pass verification".into(),
        63 => "it adds a method".into(),
        64 => "it adds, removes or changes fields".into(),
        66 => "it changes the class hierarchy".into(),
        67 => "it removes a method".into(),
        68 => "the class was compiled for a newer Java version than the game runs on".into(),
        69 => "the class name does not match".into(),
        70 => "it changes class modifiers".into(),
        71 => "it changes method modifiers".into(),
        72 => "it changes nested classes or other class attributes".into(),
        99 => "this Java runtime cannot redefine classes".into(),
        112 => "the debugger connection is not available".into(),
        c => format!("the JVM reported error {c}"),
    }
}

impl Jdwp {
    pub fn connect(port: u16) -> Result<Jdwp, String> {
        let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
        let mut s = TcpStream::connect_timeout(&addr, Duration::from_secs(3)).map_err(|e| format!("Could not connect to the debug port {port}: {e}"))?;
        let _ = s.set_read_timeout(Some(Duration::from_secs(60)));
        let _ = s.set_write_timeout(Some(Duration::from_secs(30)));
        let _ = s.set_nodelay(true);
        let busy = || format!("The debug port {port} did not answer. Another debugger may be attached; only one can connect at a time.");
        s.write_all(b"JDWP-Handshake").map_err(|_| busy())?;
        let mut hs = [0u8; 14];
        s.read_exact(&mut hs).map_err(|_| busy())?;
        if &hs != b"JDWP-Handshake" {
            return Err(busy());
        }
        let mut j = Jdwp { s, id: 0, ref_size: 8 };
        let sizes = j.command(1, 7, &[]).map_err(|e| j.describe(e))?;
        j.ref_size = be_i32(&sizes, 12).map_err(|_| "The debugger sent an invalid reply".to_string())? as usize;
        Ok(j)
    }

    pub fn describe(&self, e: JdwpError) -> String {
        match e {
            JdwpError::Io(m) => format!("The debugger connection failed: {m}"),
            JdwpError::Code(c) => jdwp_error_text(c),
        }
    }

    fn command(&mut self, set: u8, cmd: u8, data: &[u8]) -> Result<Vec<u8>, JdwpError> {
        self.id += 1;
        let id = self.id;
        let mut packet = Vec::with_capacity(11 + data.len());
        packet.extend_from_slice(&((11 + data.len()) as u32).to_be_bytes());
        packet.extend_from_slice(&id.to_be_bytes());
        packet.push(0);
        packet.push(set);
        packet.push(cmd);
        packet.extend_from_slice(data);
        self.s.write_all(&packet).map_err(|e| JdwpError::Io(e.to_string()))?;
        loop {
            let mut head = [0u8; 11];
            self.s.read_exact(&mut head).map_err(|e| JdwpError::Io(e.to_string()))?;
            let len = u32::from_be_bytes([head[0], head[1], head[2], head[3]]) as usize;
            if len < 11 {
                return Err(JdwpError::Io("invalid packet".into()));
            }
            let mut body = vec![0u8; len - 11];
            self.s.read_exact(&mut body).map_err(|e| JdwpError::Io(e.to_string()))?;
            let rid = u32::from_be_bytes([head[4], head[5], head[6], head[7]]);
            if head[8] & 0x80 == 0 || rid != id {
                continue;
            }
            let code = u16::from_be_bytes([head[9], head[10]]);
            if code != 0 {
                return Err(JdwpError::Code(code));
            }
            return Ok(body);
        }
    }

    pub fn can_redefine(&mut self) -> Result<bool, String> {
        let caps = self.command(1, 17, &[]).map_err(|e| self.describe(e))?;
        Ok(caps.get(7).copied().unwrap_or(0) != 0)
    }

    pub fn classes_by_signature(&mut self, sig: &str) -> Result<Vec<Vec<u8>>, String> {
        let mut data = (sig.len() as u32).to_be_bytes().to_vec();
        data.extend_from_slice(sig.as_bytes());
        let body = self.command(1, 2, &data).map_err(|e| self.describe(e))?;
        let n = be_i32(&body, 0).map_err(|_| "The debugger sent an invalid reply".to_string())? as usize;
        let mut out = Vec::new();
        let step = 1 + self.ref_size + 4;
        for k in 0..n {
            let at = 4 + k * step;
            let r = body.get(at + 1..at + 1 + self.ref_size).ok_or("The debugger sent an invalid reply")?;
            out.push(r.to_vec());
        }
        Ok(out)
    }

    pub fn redefine(&mut self, classes: &[(Vec<u8>, Vec<u8>)]) -> Result<(), u16> {
        let mut data = (classes.len() as u32).to_be_bytes().to_vec();
        for (r, bytes) in classes {
            data.extend_from_slice(r);
            data.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
            data.extend_from_slice(bytes);
        }
        match self.command(1, 18, &data) {
            Ok(_) => Ok(()),
            Err(JdwpError::Code(c)) => Err(c),
            Err(JdwpError::Io(_)) => Err(112),
        }
    }

    pub fn dispose(mut self) {
        let _ = self.command(1, 6, &[]);
    }
}

pub struct Redefinition {
    pub sig: String,
    pub bytes: Vec<u8>,
}

pub fn redefine_all(port: u16, classes: &[Redefinition]) -> Result<(Vec<bool>, Option<String>), String> {
    let mut j = Jdwp::connect(port)?;
    if !j.can_redefine()? {
        j.dispose();
        return Err("This Java runtime cannot redefine classes".into());
    }
    let mut loaded = Vec::new();
    let mut batch = Vec::new();
    for c in classes {
        let refs = j.classes_by_signature(&c.sig)?;
        loaded.push(!refs.is_empty());
        for r in refs {
            batch.push((r, c.bytes.clone()));
        }
    }
    let err = if batch.is_empty() { None } else { j.redefine(&batch).err().map(jdwp_error_text) };
    j.dispose();
    Ok((loaded, err))
}

impl Runtime {
    pub fn debug_port_check(&self, port: u16) -> Value {
        let free = port_free(port);
        let suggested = if free { Some(port) } else { (port.saturating_add(1)..port.saturating_add(50)).find(|p| port_free(*p)) };
        json!({ "port": port, "free": free, "suggested": suggested })
    }

    pub fn hotswap(self: &std::sync::Arc<Self>, id: &str) -> Result<Value, String> {
        let info = self.instance_or_err(id)?;
        if !["running", "starting"].contains(&info["status"].as_str().unwrap_or("")) {
            return Err(format!("Instance {id} is not running"));
        }
        if info["mode"] != "development" {
            return Err("Hot reload works on development runs. This run uses the built JAR, so rebuild and restart instead".into());
        }
        let port = info["debugPort"].as_u64().ok_or("Hot reload needs the debug port. Turn on hot reload for this profile and restart the game")? as u16;
        let dir = PathBuf::from(js::string(&info["workspace"]));
        let slot = info["slot"].as_u64().filter(|n| *n > 1).map(|n| format!("-{n}")).unwrap_or_default();
        let state = state_path(&dir, &js::string(&info["profileId"]), &format!("{}{slot}", js::string(&info["side"])));
        let saved: Value = fs::read_to_string(state.join("state.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
        if saved["instance"] != id {
            return Err("This run has no class snapshot for hot reload. Restart it to use hot reload".into());
        }
        let dirs: Vec<PathBuf> = saved["dirs"].as_array().map(|a| a.iter().filter_map(|d| d.as_str().map(PathBuf::from)).collect()).unwrap_or_default();
        let me = self.clone();
        let title = format!("Hot reload {}", js::string(&info["profileId"]));
        let id = id.to_string();
        Ok(self.ops.start("instance.hotswap", &title, Some(js::string(&info["workspace"])), move |ctx| me.run_hotswap(&id, &dir, &state, &dirs, port, ctx).map(Some)))
    }

    fn run_hotswap(&self, id: &str, dir: &Path, state: &Path, dirs: &[PathBuf], port: u16, ctx: &OpCtx) -> Result<Value, String> {
        let mut tasks: Vec<String> = Vec::new();
        for d in dirs {
            let set = d.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            let task = if set == "main" { "classes".to_string() } else { format!("{set}Classes") };
            if !tasks.contains(&task) {
                tasks.push(task);
            }
        }
        if tasks.is_empty() {
            tasks.push("classes".into());
        }
        ctx.progress(Some(0.05), Some("Compiling changed sources"));
        self.run_build(dir, false, &tasks, ctx).map_err(|e| format!("{e}. Nothing was applied to the running game"))?;
        ctx.check()?;
        ctx.progress(Some(0.7), Some("Comparing classes with the running game"));
        let changes = changed_classes(state, dirs);
        let mut classes = Vec::new();
        let mut parsed = Vec::new();
        for c in &changes {
            let old = match &c.old {
                Some(b) => Some(parse_class(b).map_err(|e| format!("{} {e}", c.rel))?),
                None => None,
            };
            let new = match &c.new {
                Some(b) => Some(parse_class(b).map_err(|e| format!("{} {e}", c.rel))?),
                None => None,
            };
            classes.push(classify(old.as_ref(), new.as_ref()));
            parsed.push(new.map(|n| n.name));
        }
        if classes.is_empty() {
            ctx.log("No compiled classes changed since the game started or since the last hot reload");
            return Ok(json!({ "instance": id, "applied": false, "restartRequired": false, "redefined": 0, "classes": [] }));
        }
        let blocked: Vec<&Value> = classes.iter().filter(|c| c["hotswap"] != true).collect();
        if !blocked.is_empty() {
            for c in &blocked {
                for r in c["reasons"].as_array().into_iter().flatten() {
                    ctx.log(&format!("{}: {}", js::string(&c["class"]), js::string(r)));
                }
            }
            ctx.log("Nothing was applied. Restart the game to use these changes");
            let classes: Vec<Value> = classes.into_iter().map(|mut c| {
                let status = if c["hotswap"] == true { "skipped" } else { "restart" };
                c["status"] = json!(status);
                c
            }).collect();
            ctx.progress(Some(1.0), Some("Restart needed"));
            return Ok(json!({ "instance": id, "applied": false, "restartRequired": true, "redefined": 0, "classes": classes }));
        }
        ctx.progress(Some(0.8), Some("Redefining classes in the running game"));
        let mut targets = Vec::new();
        let mut index = Vec::new();
        for (k, c) in changes.iter().enumerate() {
            if classes[k]["change"] == "modified" {
                if let (Some(name), Some(bytes)) = (&parsed[k], &c.new) {
                    targets.push(Redefinition { sig: format!("L{name};"), bytes: bytes.clone() });
                    index.push(k);
                }
            }
        }
        let (loaded, err) = if targets.is_empty() { (vec![], None) } else { redefine_all(port, &targets)? };
        if let Some(e) = err {
            ctx.log(&format!("The game rejected the new classes: {e}. Nothing was applied"));
            for c in classes.iter_mut() {
                c["status"] = json!("rejected");
            }
            return Ok(json!({ "instance": id, "applied": false, "restartRequired": true, "redefined": 0, "error": format!("The game rejected the new classes because {e}. Nothing was applied; restart to use these changes"), "classes": classes }));
        }
        let mut redefined = 0;
        for c in classes.iter_mut() {
            if c["change"] == "added" {
                c["status"] = json!("added");
            }
        }
        for (n, k) in index.iter().enumerate() {
            if loaded.get(n).copied().unwrap_or(false) {
                classes[*k]["status"] = json!("redefined");
                redefined += 1;
            } else {
                classes[*k]["status"] = json!("not-loaded");
            }
        }
        accept(state, &changes);
        for c in &classes {
            let what = match c["status"].as_str().unwrap_or("") {
                "redefined" => {
                    let m: Vec<String> = c["methods"].as_array().into_iter().flatten().map(js::string).collect();
                    if m.is_empty() { "redefined".to_string() } else { format!("redefined ({})", m.join(", ")) }
                }
                "not-loaded" => "not loaded yet; the new version loads when first used".into(),
                "added" => "new class; loads when first used".into(),
                s => s.to_string(),
            };
            ctx.log(&format!("{}: {what}", js::string(&c["class"])));
        }
        ctx.progress(Some(1.0), Some(&format!("Redefined {redefined} class{}", if redefined == 1 { "" } else { "es" })));
        Ok(json!({ "instance": id, "applied": true, "restartRequired": false, "redefined": redefined, "classes": classes }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(variant: &str, class: &str) -> Option<Vec<u8>> {
        let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/hotswap").join(variant).join("demo").join(format!("{class}.class"));
        fs::read(p).ok()
    }

    fn check(variant: &str, class: &str) -> Value {
        let old = fixture("base", class).map(|b| parse_class(&b).unwrap());
        let new = fixture(variant, class).map(|b| parse_class(&b).unwrap());
        classify(old.as_ref(), new.as_ref())
    }

    fn reasons(v: &Value) -> Vec<String> {
        v["reasons"].as_array().unwrap().iter().map(js::string).collect()
    }

    #[test]
    fn method_bodies_and_lambdas_can_be_swapped() {
        let body = check("body", "Foo");
        assert_eq!(body["hotswap"], true);
        assert_eq!(body["methods"], json!(["int value()"]));
        let lambda = check("lambda", "Foo");
        assert_eq!(lambda["hotswap"], true);
        assert_eq!(lambda["methods"], json!(["String lambda$run$0()"]));
        assert_eq!(check("safeitems", "ModItems")["hotswap"], true);
        assert_eq!(check("base", "Foo")["methods"], json!([]));
    }

    #[test]
    fn schema_and_hierarchy_changes_need_a_restart() {
        assert_eq!(reasons(&check("field", "Foo")), vec!["Field added: int extra"]);
        assert_eq!(reasons(&check("method", "Foo")), vec!["Method added: int twice()"]);
        assert_eq!(reasons(&check("removed", "Foo")), vec!["Method removed: int helper()"]);
        assert_eq!(reasons(&check("signature", "Foo")), vec!["Method added: long value()", "Method removed: int value()"]);
        assert_eq!(reasons(&check("modifiers", "Foo")), vec!["Method modifiers changed: int helper()"]);
        assert_eq!(reasons(&check("super", "Foo")), vec!["Superclass changed from demo.Base to demo.Other"]);
        assert_eq!(reasons(&check("iface", "Foo")), vec!["Implemented interfaces changed"]);
        assert_eq!(reasons(&check("clinit", "Foo")), vec!["Static initializer changed (it already ran when the class loaded)"]);
        assert_eq!(reasons(&check("nested", "Foo")), vec!["Nested, permitted or record classes changed"]);
        assert_eq!(check("nested", "Foo$Inner")["change"], "added");
    }

    #[test]
    fn mixins_and_registration_need_a_restart() {
        assert_eq!(reasons(&check("mixin", "FooMixin")), vec!["Mixin class (mixins are applied when the game starts)"]);
        assert_eq!(reasons(&check("registry", "ModItems")), vec!["void register() registers game content (Registry.register); registration only runs at startup"]);
    }

    #[test]
    fn added_and_removed_classes() {
        let added = check("added", "Extra");
        assert_eq!((added["change"].clone(), added["hotswap"].clone()), (json!("added"), json!(true)));
        let old = parse_class(&fixture("added", "Extra").unwrap()).unwrap();
        let removed = classify(Some(&old), None);
        assert_eq!(removed["hotswap"], false);
        assert_eq!(removed["class"], "demo.Extra");
    }

    #[test]
    fn rejects_files_that_are_not_classes() {
        assert!(parse_class(b"not a class").is_err());
        let mut b = fixture("base", "Foo").unwrap();
        b.truncate(b.len() / 2);
        assert!(parse_class(&b).is_err());
    }

    #[test]
    fn describes_members_like_java() {
        assert_eq!(describe_member("go", "(I[Ljava/lang/String;Ljava/util/Map$Entry;)V"), "void go(int, String[], Map.Entry)");
        assert_eq!(describe_member("<init>", "(J)V"), "constructor(long)");
        assert_eq!(describe_member("x", "[[D"), "double[][] x");
    }

    fn javas() -> Vec<PathBuf> {
        let exe = if cfg!(windows) { "java.exe" } else { "java" };
        let mut homes: Vec<PathBuf> = std::env::var_os("JAVA_HOME").map(PathBuf::from).into_iter().collect();
        for root in ["C:/Program Files/Java", "C:/Program Files/Eclipse Adoptium", "/usr/lib/jvm"] {
            if let Ok(rd) = fs::read_dir(root) {
                homes.extend(rd.flatten().map(|e| e.path()));
            }
        }
        let mut out: Vec<PathBuf> = homes.into_iter().map(|h| h.join("bin").join(exe)).filter(|p| p.exists() && p.parent().is_some_and(|b| b.join(if cfg!(windows) { "javac.exe" } else { "javac" }).exists())).collect();
        out.sort();
        out.dedup();
        out
    }

    fn wait_for(lines: &std::sync::Arc<std::sync::Mutex<Vec<String>>>, text: &str, after: usize) -> usize {
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        loop {
            {
                let l = lines.lock().unwrap();
                if l.iter().skip(after).any(|x| x == text) {
                    return l.len();
                }
            }
            assert!(std::time::Instant::now() < deadline, "timed out waiting for {text}");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    fn redefines_classes_in_a_running_jvm() {
        for java in javas() {
            let dir = std::env::temp_dir().join(format!("mwb-hotswap-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(dir.join("demo")).unwrap();
            let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/hotswap/base/demo");
            for e in fs::read_dir(&base).unwrap().flatten() {
                fs::copy(e.path(), dir.join("demo").join(e.file_name())).unwrap();
            }
            let port = TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port();
            let mut child = std::process::Command::new(&java)
                .args([format!("-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:{port}"), "-cp".into(), dir.to_string_lossy().to_string(), "demo.Loop".into()])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap();
            let lines = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
            let sink = lines.clone();
            let out = child.stdout.take().unwrap();
            std::thread::spawn(move || {
                use std::io::BufRead;
                for l in std::io::BufReader::new(out).lines().map_while(Result::ok) {
                    sink.lock().unwrap().push(l.trim().to_string());
                }
            });
            let mark = wait_for(&lines, "value 3", 0);
            let body = Redefinition { sig: "Ldemo/Foo;".into(), bytes: fixture("body", "Foo").unwrap() };
            assert_eq!(redefine_all(port, &[body]).unwrap(), (vec![true], None), "{}", java.display());
            let mark = wait_for(&lines, "value 4", mark);
            let both = [Redefinition { sig: "Ldemo/ModItems;".into(), bytes: fixture("safeitems", "ModItems").unwrap() }, Redefinition { sig: "Ldemo/Foo;".into(), bytes: fixture("field", "Foo").unwrap() }];
            assert_eq!(redefine_all(port, &both).unwrap(), (vec![false, true], Some("it adds, removes or changes fields".to_string())));
            let mark = wait_for(&lines, "value 4", mark);
            let back = Redefinition { sig: "Ldemo/Foo;".into(), bytes: fixture("base", "Foo").unwrap() };
            assert_eq!(redefine_all(port, &[back]).unwrap().1, None);
            wait_for(&lines, "value 3", mark);
            let _ = child.kill();
            let _ = child.wait();
            let _ = fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn explains_a_closed_debug_port() {
        let port = TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port();
        let err = redefine_all(port, &[]).err().unwrap();
        assert!(err.starts_with(&format!("Could not connect to the debug port {port}")), "{err}");
    }
}
