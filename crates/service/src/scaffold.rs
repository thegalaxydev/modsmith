use crate::js;
use crate::png::placeholder_texture;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::Path;

pub struct GeneratedFile {
    pub path: String,
    pub content: Vec<u8>,
}

pub struct Scaffold {
    pub project_name: String,
    pub mod_id: String,
    pub package_name: String,
    pub author: String,
    pub description: String,
    pub license: String,
    pub environment: String,
    pub starters: Vec<String>,
    pub dependencies: Vec<Value>,
    pub resolved_ids: HashMap<String, Vec<String>>,
    pub maven_coords: HashMap<String, String>,
}

const JAVA_KEYWORDS: &str = "abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null var record yield sealed permits";

fn keyword(s: &str) -> bool {
    JAVA_KEYWORDS.split(' ').any(|k| k == s)
}

pub fn validate_mod_id(id: &str) -> Option<String> {
    if id.is_empty() {
        return Some("Mod ID is required".into());
    }
    if !Regex::new(r"^[a-z][a-z0-9_]{1,63}$").expect("mod id regex").is_match(id) {
        return Some("Mod ID must be 2-64 characters: lowercase letters, digits and underscores, starting with a letter".into());
    }
    if ["minecraft", "java", "fabric", "fabricloader", "forge", "neoforge", "mixinextras"].contains(&id) {
        return Some(format!("Mod ID \"{id}\" is reserved"));
    }
    None
}

pub fn validate_package(pkg: &str) -> Option<String> {
    if pkg.is_empty() {
        return Some("Package is required".into());
    }
    let parts: Vec<&str> = pkg.split('.').collect();
    if parts.len() < 2 {
        return Some("Package should have at least two segments, for example com.example.mymod".into());
    }
    let seg = Regex::new(r"^[a-z_][a-z0-9_]*$").expect("segment regex");
    for p in parts {
        if !seg.is_match(p) {
            return Some(format!("Invalid package segment \"{p}\": use lowercase letters, digits and underscores"));
        }
        if keyword(p) {
            return Some(format!("Package segment \"{p}\" is a Java keyword"));
        }
    }
    if pkg.starts_with("net.minecraft") || pkg.starts_with("com.mojang") || pkg.starts_with("net.fabricmc") {
        return Some("Package must not use a Minecraft, Mojang or Fabric namespace".into());
    }
    None
}

fn writable(dir: &Path) -> bool {
    match std::fs::metadata(dir) {
        Ok(m) => !m.permissions().readonly() || cfg!(windows),
        Err(_) => false,
    }
}

pub fn validate_destination(dest: &str) -> Option<String> {
    if dest.is_empty() {
        return Some("Destination is required".into());
    }
    if !Path::new(dest).is_absolute() {
        return Some("Destination must be an absolute path".into());
    }
    let rest: String = dest.chars().skip(2).collect();
    if rest.chars().any(|c| "<>\"|?*".contains(c)) {
        return Some("Destination contains characters that are not allowed in Windows paths".into());
    }
    let p = Path::new(dest);
    if p.exists() {
        if !p.is_dir() {
            return Some("Destination exists and is a file".into());
        }
        let count = std::fs::read_dir(p).map(|d| d.count()).unwrap_or(0);
        if count > 0 {
            return Some(format!("Destination is not empty ({count} entries). Choose an empty or new directory; existing projects are never overwritten."));
        }
    } else {
        let mut parent = p.parent().map(Path::to_path_buf).unwrap_or_else(|| p.to_path_buf());
        while !parent.exists() {
            match parent.parent() {
                Some(next) if next != parent => parent = next.to_path_buf(),
                _ => return Some("Destination drive does not exist".into()),
            }
        }
        if !writable(&parent) {
            return Some(format!("Cannot write to {}", parent.display()));
        }
    }
    None
}

pub fn to_class_name(name: &str) -> String {
    let cleaned = Regex::new(r"[^A-Za-z0-9]+").expect("class regex").replace_all(name, " ").to_string();
    let words: Vec<&str> = cleaned.split_whitespace().collect();
    let mut cls: String = words
        .iter()
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        })
        .collect();
    if cls.is_empty() || cls.starts_with(|c: char| c.is_ascii_digit()) {
        cls = format!("Mod{cls}");
    }
    if keyword(&cls.to_lowercase()) {
        cls.push_str("Mod");
    }
    cls
}

pub fn validate_scaffold(input: &Value) -> Vec<Value> {
    let s = |k: &str| input[k].as_str().unwrap_or("").to_string();
    let mut issues = Vec::new();
    let mut push = |field: &str, message: String| issues.push(json!({ "field": field, "message": message }));
    if s("projectName").trim().is_empty() {
        push("projectName", "Project name is required".into());
    }
    if let Some(m) = validate_mod_id(&s("modId")) {
        push("modId", m);
    }
    if let Some(m) = validate_package(&s("packageName")) {
        push("packageName", m);
    }
    if let Some(m) = validate_destination(&s("destination")) {
        push("destination", m);
    }
    if s("license").trim().is_empty() {
        push("license", "License is required (for example MIT, CC0-1.0 or All-Rights-Reserved)".into());
    }
    issues
}

struct Starter(&'static str, &'static str, &'static str, &'static str, Option<&'static str>);

const FABRIC_STARTERS: [Starter; 9] = [
    Starter("empty", "Empty mod", "Main and client entrypoints, metadata, mixin configs and an icon.", "supported", None),
    Starter("item", "Example item", "Registers an item with model, texture, translation and creative tab entry.", "supported", None),
    Starter("block", "Example block", "Registers a block and block item with blockstate, models, texture and loot table.", "supported", None),
    Starter("command", "Command", "Registers a /<modid> hello command through Fabric API.", "supported", None),
    Starter("config", "Configuration", "JSON config file in the instance config directory, loaded at startup.", "supported", None),
    Starter("datagen", "Data generation", "Fabric data generation entrypoint with a language provider and the runDatagen task.", "supported", Some("client-environment")),
    Starter("networking", "Basic networking", "Custom payload registration. Not implemented yet.", "planned", None),
    Starter("bridge", "Runtime development bridge", "Adds the Modsmith companion mod to development instances only. Never included in the built JAR.", "supported", None),
    Starter("profiles", "Client and dedicated-server test profiles", "Creates isolated dev-client and dev-server profiles.", "supported", None),
];

const NEOFORGE_STARTERS: [Starter; 9] = [
    Starter("empty", "Empty mod", "A @Mod entrypoint, client entrypoint and neoforge.mods.toml generated from the MDK template.", "supported", None),
    Starter("item", "Example item", "DeferredRegister item with model, texture, translation and creative tab entry.", "supported", None),
    Starter("block", "Example block", "DeferredRegister block and block item with blockstate, models, texture and loot table.", "supported", None),
    Starter("command", "Command", "Registers a /<modid> hello command through RegisterCommandsEvent.", "supported", None),
    Starter("config", "Configuration", "ModConfigSpec common config with an in-game configuration screen.", "supported", None),
    Starter("datagen", "Data generation", "GatherDataEvent with a language provider; run it with the runData task.", "supported", None),
    Starter("networking", "Basic networking", "Custom payload registration. Not implemented yet.", "planned", None),
    Starter("bridge", "Runtime development bridge", "Adds the Modsmith companion mod to development instances only. Never included in the built JAR.", "supported", None),
    Starter("profiles", "Client and dedicated-server test profiles", "Creates isolated dev-client and dev-server profiles.", "supported", None),
];

pub fn implemented(loader: &str) -> bool {
    loader == "fabric" || loader == "neoforge"
}

pub fn display_name(loader: &str) -> &'static str {
    match loader {
        "fabric" => "Fabric",
        "neoforge" => "NeoForge",
        _ => "Forge",
    }
}

pub fn starter_options(entry: &Value) -> Vec<Value> {
    let list: &[Starter] = match entry["loader"].as_str() {
        Some("fabric") => &FABRIC_STARTERS,
        Some("neoforge") => &NEOFORGE_STARTERS,
        _ => &[],
    };
    let available: Vec<&str> = entry["starters"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    list.iter()
        .map(|s| {
            let mut o = Map::new();
            o.insert("id".into(), json!(s.0));
            o.insert("label".into(), json!(s.1));
            o.insert("description".into(), json!(s.2));
            o.insert("state".into(), json!(s.3));
            if let Some(r) = s.4 {
                o.insert("requires".into(), json!([r]));
            }
            if s.3 == "supported" && !available.contains(&s.0) {
                o.insert("state".into(), json!("planned"));
                o.insert("description".into(), json!(format!("{} Not available for {}.", s.2, js::string(&entry["id"]))));
            }
            Value::Object(o)
        })
        .collect()
}

fn cap(id: &str, label: &str, state: &str, detail: Option<&str>) -> Value {
    let mut o = Map::new();
    o.insert("id".into(), json!(id));
    o.insert("label".into(), json!(label));
    o.insert("state".into(), json!(state));
    if let Some(d) = detail {
        o.insert("detail".into(), json!(d));
    }
    Value::Object(o)
}

pub fn capabilities(loader: &str) -> Vec<Value> {
    match loader {
        "fabric" => vec![
            cap("project.generate", "Project generation", "supported", Some("Verified catalog entries only")),
            cap("project.detect", "Existing project detection", "supported", Some("Static inspection of Gradle files and fabric.mod.json")),
            cap("build", "Gradle build", "supported", None),
            cap("launch.dev.client", "Development client launch", "supported", Some("Uses Loom launch configuration through an init script")),
            cap("launch.dev.server", "Development dedicated server", "supported", Some("Requires explicit EULA acceptance per instance")),
            cap("launch.datagen", "Data generation run", "supported", Some("Runs the project runDatagen task when configured")),
            cap("launch.prod.server", "Production server validation", "supported", Some("Installs the Fabric server with the official installer and the remapped JAR")),
            cap("launch.prod.client", "Production client validation", "planned", Some("Requires Loom production run tasks with Microsoft authentication")),
            cap("bridge", "Runtime bridge", "supported", Some("Minecraft 1.21.1 only")),
            cap("reload.resources", "Resource reload", "supported", Some("Through the bridge")),
            cap("reload.datapacks", "Datapack reload", "supported", Some("Through the bridge (/reload)")),
            cap("reload.hotswap", "Debugger hotswap", "supported", Some("Attach a JDWP debugger; method-body changes only")),
            cap("mrpack", ".mrpack import/export", "supported", None),
        ],
        "neoforge" => vec![
            cap("project.generate", "Project generation", "supported", Some("ModDevGradle MDK layout; verified catalog entries only")),
            cap("project.detect", "Existing project detection", "supported", Some("Static inspection of Gradle files and neoforge.mods.toml")),
            cap("build", "Gradle build", "supported", None),
            cap("launch.dev.client", "Development client launch", "supported", Some("Uses the ModDevGradle run configuration through an init script")),
            cap("launch.dev.server", "Development dedicated server", "supported", Some("Requires explicit EULA acceptance per instance")),
            cap("launch.datagen", "Data generation run", "supported", Some("Runs the project runData task when configured")),
            cap("launch.prod.server", "Production server validation", "supported", Some("Installs the NeoForge server with the official installer and the built JAR")),
            cap("launch.prod.client", "Production client validation", "planned", Some("Requires Microsoft authentication")),
            cap("modpack.dev", "Modpack development launch without source", "planned", Some("Modpack workspaces need a ModDevGradle harness; not implemented yet")),
            cap("bridge", "Runtime bridge", "supported", Some("Minecraft 1.21.1 only")),
            cap("reload.resources", "Resource reload", "supported", Some("Through the bridge")),
            cap("reload.datapacks", "Datapack reload", "supported", Some("Through the bridge (/reload)")),
            cap("reload.hotswap", "Debugger hotswap", "supported", Some("Attach a JDWP debugger; method-body changes only")),
        ],
        _ => vec![
            cap("project.detect", "Existing project detection", "supported", Some("Static inspection only")),
            cap("project.generate", "Project generation", "planned", Some("Forge adapter is not implemented yet")),
            cap("build", "Gradle build", "planned", None),
            cap("launch.dev.client", "Development client launch", "planned", None),
            cap("bridge", "Runtime bridge", "planned", None),
        ],
    }
}

fn fill(template: &str, vars: &[(&str, &str)]) -> String {
    let mut out = template.replace("\\t", "\t");
    for (k, v) in vars {
        out = out.replace(&format!("@@{k}@@"), v);
    }
    out
}

pub fn java_file(pkg: &str, body: &str) -> String {
    format!("package {pkg};\n\n{}\n", body.trim())
}

pub fn json_tab(v: &Value) -> String {
    format!("{}\n", js::pretty_tab(v))
}

fn imports(list: &[String]) -> String {
    let mut l = list.to_vec();
    l.sort();
    l.iter().map(|i| format!("import {i};")).collect::<Vec<_>>().join("\n")
}

fn str_of<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}

fn mit_text(year: i32, author: &str) -> String {
    format!(
        r##"MIT License

Copyright (c) {year} {author}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"##
    )
}

fn license(opts: &Scaffold) -> String {
    let year = chrono::Datelike::year(&chrono::Local::now());
    let author = if opts.author.is_empty() { "the authors" } else { opts.author.as_str() };
    if opts.license == "MIT" {
        mit_text(year, author)
    } else {
        format!("SPDX-License-Identifier: {}\nCopyright (c) {year} {author}\n", opts.license)
    }
}

const MODRINTH_REPO: &str = r##"repositories {
\texclusiveContent {
\t\tforRepository {
\t\t\tmaven {
\t\t\t\tname = 'Modrinth'
\t\t\t\turl = 'https://api.modrinth.com/maven'
\t\t\t}
\t\t}
\t\tfilter {
\t\t\tincludeGroup 'maven.modrinth'
\t\t}
\t}
@@repos@@
}

dependencies {
@@lines@@
}
"##;

fn modrinth_coords(opts: &Scaffold, d: &Value) -> String {
    let pid = str_of(d, "projectId");
    opts.maven_coords.get(pid).cloned().unwrap_or_else(|| format!("maven.modrinth:{pid}:{}", d["versionId"].as_str().unwrap_or("")))
}

fn dependency_block(repos: Vec<String>, lines: Vec<String>) -> String {
    let repo_block = repos.iter().map(|r| format!("\tmaven {{\n\t\turl = '{r}'\n\t}}")).collect::<Vec<_>>().join("\n");
    fill(MODRINTH_REPO, &[("repos", &repo_block), ("lines", &lines.join("\n"))])
}

fn push_repo(repos: &mut Vec<String>, d: &Value) {
    if let Some(r) = d["repository"].as_str().filter(|r| !r.is_empty()) {
        if !repos.iter().any(|x| x == r) {
            repos.push(r.to_string());
        }
    }
}

pub struct FabricStyle {
    pub split: bool,
    pub log4j: bool,
    pub identifier: Option<String>,
}

pub fn fabric_style(entry: &Value) -> FabricStyle {
    let f = &entry["fabric"];
    if f.is_object() {
        return FabricStyle { split: f["splitSources"] == true, log4j: f["logger"] == "log4j", identifier: f["identifier"].as_str().map(str::to_string) };
    }
    FabricStyle { split: true, log4j: false, identifier: (entry["mappings"] == "mojang").then(|| "ResourceLocation.fromNamespaceAndPath".to_string()) }
}

pub fn fabric_dependency_gradle(opts: &Scaffold, entry: &Value) -> String {
    let remap = entry["remap"] == true;
    let split = fabric_style(entry).split;
    let mut lines = Vec::new();
    let mut repos = Vec::new();
    for d in &opts.dependencies {
        if d["source"] == "modrinth" && d["usage"] == "compile" {
            let conf = if d["environment"] == "client" && split {
                if remap {
                    "modClientImplementation"
                } else {
                    "clientImplementation"
                }
            } else if remap {
                "modImplementation"
            } else {
                "implementation"
            };
            lines.push(format!("\t{conf} '{}'", modrinth_coords(opts, d)));
        } else if d["source"] == "maven" {
            push_repo(&mut repos, d);
            let conf = if d["usage"] == "compile" {
                if remap {
                    "modImplementation"
                } else {
                    "implementation"
                }
            } else if remap {
                "modLocalRuntime"
            } else {
                "localRuntime"
            };
            lines.push(format!("\t{conf} '{}'", js::string(&d["coordinates"])));
        }
    }
    dependency_block(repos, lines)
}

pub fn neoforge_dependency_gradle(opts: &Scaffold) -> String {
    let mut lines = Vec::new();
    let mut repos = Vec::new();
    for d in &opts.dependencies {
        if d["source"] == "modrinth" && d["usage"] == "compile" {
            lines.push(format!("\timplementation '{}'", modrinth_coords(opts, d)));
        } else if d["source"] == "maven" {
            push_repo(&mut repos, d);
            lines.push(format!("\t{} '{}'", if d["usage"] == "compile" { "implementation" } else { "localRuntime" }, js::string(&d["coordinates"])));
        }
    }
    dependency_block(repos, lines)
}

fn dep_key(d: &Value) -> String {
    match d["source"].as_str() {
        Some("modrinth") | Some("curseforge") => js::string(&d["projectId"]),
        Some("local") => js::string(&d["path"]),
        _ => js::string(&d["coordinates"]),
    }
}

const WRAPPER_PROPS: &str = "distributionBase=GRADLE_USER_HOME\ndistributionPath=wrapper/dists\ndistributionUrl=https\\://services.gradle.org/distributions/gradle-@@gradle@@-bin.zip\nnetworkTimeout=10000\nvalidateDistributionUrl=true\nzipStoreBase=GRADLE_USER_HOME\nzipStorePath=wrapper/dists\n";

pub fn wrapper_properties(gradle: &str) -> String {
    WRAPPER_PROPS.replace("@@gradle@@", gradle)
}

struct Out(Vec<GeneratedFile>);

impl Out {
    fn add(&mut self, path: String, content: impl Into<Vec<u8>>) {
        self.0.push(GeneratedFile { path, content: content.into() });
    }
}

const FABRIC_SETTINGS: &str = r##"pluginManagement {
\trepositories {
\t\tmaven {
\t\t\tname = 'Fabric'
\t\t\turl = 'https://maven.fabricmc.net/'
\t\t}
\t\tmavenCentral()
\t\tgradlePluginPortal()
\t}
}

rootProject.name = '@@id@@'
"##;

const FABRIC_PROPERTIES: &str = r##"org.gradle.jvmargs=-Xmx2G
org.gradle.parallel=true
org.gradle.configuration-cache=true

minecraft_version=@@minecraft@@
loader_version=@@loader@@
loom_version=@@loom@@

version=0.1.0
group=@@pkg@@

fabric_api_version=@@fabricApi@@
"##;

const FABRIC_BUILD: &str = r##"plugins {
\tid '@@pluginId@@' version "${loom_version}"
\tid 'maven-publish'
}

repositories {
}

loom {
@@splitLine@@\tmods {
\t\t"@@id@@" {
\t\t\tsourceSet sourceSets.main
@@clientSourceSet@@\t\t}
\t}
}
@@datagenBlock@@
dependencies {
\tminecraft "com.mojang:minecraft:${project.minecraft_version}"
@@mappingsLine@@\t@@impl@@ "net.fabricmc:fabric-loader:${project.loader_version}"
\t@@impl@@ "net.fabricmc.fabric-api:fabric-api:${project.fabric_api_version}"
}

apply from: 'modsmith.dependencies.gradle'

processResources {
\tdef version = project.version
\tinputs.property "version", version

\tfilesMatching("fabric.mod.json") {
\t\texpand "version": version
\t}
}

tasks.withType(JavaCompile).configureEach {
\tit.options.release = @@java@@
}

java {
\twithSourcesJar()

\tsourceCompatibility = JavaVersion.VERSION_@@javaConst@@
\ttargetCompatibility = JavaVersion.VERSION_@@javaConst@@
}

jar {
\tdef projectName = project.name
\tinputs.property "projectName", projectName

\tfrom("LICENSE") {
\t\trename { "${it}_$projectName" }
\t}
}

publishing {
\tpublications {
\t\tcreate("mavenJava", MavenPublication) {
\t\t\tfrom components.java
\t\t}
\t}
}
"##;

const FABRIC_GITIGNORE: &str = ".gradle/\nbuild/\nout/\nclasses/\n*.launch\n.idea/\n*.iml\n*.ipr\n*.iws\n.settings/\n.eclipse/\n.vscode/\nbin/\n.classpath\n.project\n*.DS_Store\nrun/\nhs_err_*.log\nreplay_*.log\n*.hprof\n*.jfr\n.modsmith/\n";

const FABRIC_MAIN: &str = r##"
@@imports@@

public class @@cls@@ implements ModInitializer {
\tpublic static final String MOD_ID = "@@id@@";
\tpublic static final Logger LOGGER = @@loggerInit@@;

\t@Override
\tpublic void onInitialize() {
@@init@@\t\tLOGGER.info("{} initialized", MOD_ID);
\t}
@@idFn@@}
"##;

const FABRIC_CLIENT: &str = r##"
import net.fabricmc.api.ClientModInitializer;

public class @@cls@@Client implements ClientModInitializer {
\t@Override
\tpublic void onInitializeClient() {
\t}
}
"##;

const FABRIC_ITEMS: &str = r##"
import @@pkg@@.@@cls@@;
import net.fabricmc.fabric.api.itemgroup.v1.ItemGroupEvents;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.item.CreativeModeTabs;
import net.minecraft.world.item.Item;

public final class ModItems {
\tpublic static final Item EXAMPLE_ITEM = Registry.register(BuiltInRegistries.ITEM, @@cls@@.id("example_item"), new Item(new Item.Properties()));

\tprivate ModItems() {
\t}

\tpublic static void register() {
\t\tItemGroupEvents.modifyEntriesEvent(CreativeModeTabs.INGREDIENTS).register(entries -> entries.accept(EXAMPLE_ITEM));
\t}
}
"##;

const FABRIC_BLOCKS: &str = r##"
import @@pkg@@.@@cls@@;
import net.fabricmc.fabric.api.itemgroup.v1.ItemGroupEvents;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.CreativeModeTabs;
import net.minecraft.world.item.Item;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.SoundType;
import net.minecraft.world.level.block.state.BlockBehaviour;

public final class ModBlocks {
\tpublic static final Block EXAMPLE_BLOCK = Registry.register(BuiltInRegistries.BLOCK, @@cls@@.id("example_block"), new Block(BlockBehaviour.Properties.of().strength(1.5f, 6.0f).sound(SoundType.STONE)));
\tpublic static final Item EXAMPLE_BLOCK_ITEM = Registry.register(BuiltInRegistries.ITEM, @@cls@@.id("example_block"), new BlockItem(EXAMPLE_BLOCK, new Item.Properties()));

\tprivate ModBlocks() {
\t}

\tpublic static void register() {
\t\tItemGroupEvents.modifyEntriesEvent(CreativeModeTabs.BUILDING_BLOCKS).register(entries -> entries.accept(EXAMPLE_BLOCK_ITEM));
\t}
}
"##;

const FABRIC_COMMANDS: &str = r##"
import @@pkg@@.@@cls@@;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.Component;

public final class ModCommands {
\tprivate ModCommands() {
\t}

\tpublic static void register() {
\t\tCommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> dispatcher.register(
\t\t\tCommands.literal(@@cls@@.MOD_ID).then(Commands.literal("hello").executes(context -> {
\t\t\t\tcontext.getSource().sendSuccess(() -> Component.literal("Hello from " + @@cls@@.MOD_ID), false);
\t\t\t\treturn 1;
\t\t\t}))
\t\t));
\t}
}
"##;

const FABRIC_CONFIG: &str = r##"
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonParseException;
import @@pkg@@.@@cls@@;
import java.io.IOException;
import java.io.Reader;
import java.io.Writer;
import java.nio.file.Files;
import java.nio.file.Path;
import net.fabricmc.loader.api.FabricLoader;

public final class ModConfig {
\tprivate static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
\tprivate static ModConfig instance = new ModConfig();

\tpublic boolean exampleToggle = true;
\tpublic int exampleNumber = 5;

\tpublic static ModConfig get() {
\t\treturn instance;
\t}

\tpublic static Path path() {
\t\treturn FabricLoader.getInstance().getConfigDir().resolve(@@cls@@.MOD_ID + ".json");
\t}

\tpublic static void load() {
\t\tPath file = path();
\t\ttry {
\t\t\tif (Files.exists(file)) {
\t\t\t\ttry (Reader reader = Files.newBufferedReader(file)) {
\t\t\t\t\tModConfig loaded = GSON.fromJson(reader, ModConfig.class);
\t\t\t\t\tif (loaded != null) {
\t\t\t\t\t\tinstance = loaded;
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t\tsave();
\t\t} catch (IOException | JsonParseException e) {
\t\t\t@@cls@@.LOGGER.error("Failed to load config {}", file, e);
\t\t}
\t}

\tpublic static void save() throws IOException {
\t\tFiles.createDirectories(path().getParent());
\t\ttry (Writer writer = Files.newBufferedWriter(path())) {
\t\t\tGSON.toJson(instance, writer);
\t\t}
\t}
}
"##;

const FABRIC_DATAGEN: &str = r##"
import net.fabricmc.fabric.api.datagen.v1.DataGeneratorEntrypoint;
import net.fabricmc.fabric.api.datagen.v1.FabricDataGenerator;

public class @@cls@@DataGenerator implements DataGeneratorEntrypoint {
\t@Override
\tpublic void onInitializeDataGenerator(FabricDataGenerator generator) {
\t\tFabricDataGenerator.Pack pack = generator.createPack();
\t\tpack.addProvider(ModLanguageProvider::new);
\t}
}
"##;

const FABRIC_LANG: &str = r##"
@@imports@@

public class ModLanguageProvider extends FabricLanguageProvider {
\tpublic ModLanguageProvider(FabricDataOutput output, CompletableFuture<HolderLookup.Provider> registries) {
\t\tsuper(output, registries);
\t}

\t@Override
\tpublic void generateTranslations(HolderLookup.Provider registries, TranslationBuilder builder) {
@@lines@@\t\tbuilder.add("@@id@@.generated", "Generated by data generation");
\t}
}
"##;

fn shared_assets(out: &mut Out, id: &str, has: &dyn Fn(&str) -> bool) {
    if has("item") {
        out.add(
            format!("src/main/resources/assets/{id}/models/item/example_item.json"),
            json_tab(&json!({ "parent": "minecraft:item/generated", "textures": { "layer0": format!("{id}:item/example_item") } })),
        );
        out.add(format!("src/main/resources/assets/{id}/textures/item/example_item.png"), placeholder_texture(&format!("{id}:example_item"), true));
    }
}

fn block_assets(out: &mut Out, id: &str) {
    out.add(format!("src/main/resources/assets/{id}/blockstates/example_block.json"), json_tab(&json!({ "variants": { "": { "model": format!("{id}:block/example_block") } } })));
    out.add(
        format!("src/main/resources/assets/{id}/models/block/example_block.json"),
        json_tab(&json!({ "parent": "minecraft:block/cube_all", "textures": { "all": format!("{id}:block/example_block") } })),
    );
    out.add(format!("src/main/resources/assets/{id}/models/item/example_block.json"), json_tab(&json!({ "parent": format!("{id}:block/example_block") })));
    out.add(format!("src/main/resources/assets/{id}/textures/block/example_block.png"), placeholder_texture(&format!("{id}:example_block"), false));
    out.add(
        format!("src/main/resources/data/{id}/loot_table/blocks/example_block.json"),
        json_tab(&json!({ "type": "minecraft:block", "pools": [{ "rolls": 1, "entries": [{ "type": "minecraft:item", "name": format!("{id}:example_block") }], "conditions": [{ "condition": "minecraft:survives_explosion" }] }] })),
    );
}

pub fn generate_fabric(opts: &Scaffold, entry: &Value) -> Vec<GeneratedFile> {
    let mut out = Out(Vec::new());
    let id = opts.mod_id.as_str();
    let pkg = opts.package_name.as_str();
    let cls = to_class_name(&opts.project_name);
    let pkg_path = pkg.replace('.', "/");
    let has = |s: &str| opts.starters.iter().any(|x| x == s);
    let style = fabric_style(entry);
    let client_env = opts.environment != "server" && style.split;
    let datagen = has("datagen") && client_env;
    let remap = entry["remap"] == true;
    let mojang = entry["mappings"] == "mojang";
    let impl_ = if remap { "modImplementation" } else { "implementation" };
    let java = js::string(&entry["javaRelease"]);
    let java_level = format!("JAVA_{java}");
    let minecraft = js::string(&entry["minecraft"]);
    let loader = js::string(&entry["loaderVersion"]);
    let fabric_api = js::string(&entry["fabricApiVersion"]);

    out.add("settings.gradle".into(), fill(FABRIC_SETTINGS, &[("id", id)]));
    out.add(
        "gradle.properties".into(),
        fill(FABRIC_PROPERTIES, &[("minecraft", &minecraft), ("loader", &loader), ("loom", &js::string(&entry["plugin"]["version"])), ("pkg", pkg), ("fabricApi", &fabric_api)]),
    );
    let mappings_line = if mojang { "\tmappings loom.officialMojangMappings()\n" } else { "" };
    let datagen_block = if datagen { "\nfabricApi {\n\tconfigureDataGeneration {\n\t\tclient = true\n\t}\n}\n" } else { "" };
    out.add(
        "build.gradle".into(),
        fill(FABRIC_BUILD, &[("pluginId", &js::string(&entry["plugin"]["id"])), ("id", id), ("splitLine", if style.split { "\tsplitEnvironmentSourceSets()\n\n" } else { "" }), ("clientSourceSet", if style.split { "\t\t\tsourceSet sourceSets.client\n" } else { "" }), ("datagenBlock", datagen_block), ("mappingsLine", mappings_line), ("impl", impl_), ("java", &java), ("javaConst", if java == "8" { "1_8" } else { java.as_str() })]),
    );
    out.add("modsmith.dependencies.gradle".into(), fabric_dependency_gradle(opts, entry));
    out.add("gradle/wrapper/gradle-wrapper.properties".into(), wrapper_properties(&js::string(&entry["gradleVersion"])));
    out.add(".gitignore".into(), FABRIC_GITIGNORE);
    out.add("LICENSE".into(), license(opts));
    out.add(
        "README.md".into(),
        format!(
            "# {}\n\n{}\n\n- Minecraft {minecraft}\n- Fabric Loader {loader}\n- Fabric API {fabric_api}\n\nGenerated by Modsmith from catalog entry `{}` ({}).\n\nBuild with `./gradlew build`. Gradle must run on Java {} or newer; the mod targets Java {java}.\n",
            opts.project_name,
            opts.description,
            js::string(&entry["id"]),
            js::string(&entry["templateSource"]),
            js::string(&entry["gradleJavaMin"])
        ),
    );

    let mut init: Vec<&str> = Vec::new();
    let id_class = style.identifier.as_deref().map(|i| i.split('.').next().unwrap_or(i).to_string());
    let mut imps: Vec<String> = vec!["net.fabricmc.api.ModInitializer".into()];
    if let Some(c) = &id_class {
        imps.push(format!("net.minecraft.resources.{c}"));
    }
    if style.log4j {
        imps.push("org.apache.logging.log4j.LogManager".into());
        imps.push("org.apache.logging.log4j.Logger".into());
    } else {
        imps.push("org.slf4j.Logger".into());
        imps.push("org.slf4j.LoggerFactory".into());
    }
    if has("config") {
        imps.push(format!("{pkg}.config.ModConfig"));
        init.push("ModConfig.load();");
    }
    if has("item") {
        imps.push(format!("{pkg}.registry.ModItems"));
        init.push("ModItems.register();");
    }
    if has("block") {
        imps.push(format!("{pkg}.registry.ModBlocks"));
        init.push("ModBlocks.register();");
    }
    if has("command") {
        imps.push(format!("{pkg}.command.ModCommands"));
        init.push("ModCommands.register();");
    }
    let id_fn = match (&id_class, style.identifier.as_deref()) {
        (Some(_), Some("ResourceLocation.new")) => "\n\tpublic static ResourceLocation id(String path) {\n\t\treturn new ResourceLocation(MOD_ID, path);\n\t}\n".to_string(),
        (Some(c), _) => format!("\n\tpublic static {c} id(String path) {{\n\t\treturn {c}.fromNamespaceAndPath(MOD_ID, path);\n\t}}\n"),
        _ => String::new(),
    };
    let logger_init = if style.log4j { "LogManager.getLogger(MOD_ID)" } else { "LoggerFactory.getLogger(MOD_ID)" };
    let main_imports = imps;
    let init_text = init.iter().map(|c| format!("\t\t{c}\n")).collect::<String>();
    out.add(
        format!("src/main/java/{pkg_path}/{cls}.java"),
        java_file(pkg, &fill(FABRIC_MAIN, &[("imports", &imports(&main_imports)), ("cls", &cls), ("id", id), ("init", &init_text), ("idFn", &id_fn), ("loggerInit", logger_init)])),
    );
    if client_env {
        out.add(format!("src/client/java/{pkg_path}/client/{cls}Client.java"), java_file(&format!("{pkg}.client"), &fill(FABRIC_CLIENT, &[("cls", &cls)])));
    }
    let vars = [("pkg", pkg), ("cls", cls.as_str())];
    if has("item") {
        out.add(format!("src/main/java/{pkg_path}/registry/ModItems.java"), java_file(&format!("{pkg}.registry"), &fill(FABRIC_ITEMS, &vars)));
        shared_assets(&mut out, id, &has);
    }
    if has("block") {
        out.add(format!("src/main/java/{pkg_path}/registry/ModBlocks.java"), java_file(&format!("{pkg}.registry"), &fill(FABRIC_BLOCKS, &vars)));
        block_assets(&mut out, id);
    }
    if has("command") {
        out.add(format!("src/main/java/{pkg_path}/command/ModCommands.java"), java_file(&format!("{pkg}.command"), &fill(FABRIC_COMMANDS, &vars)));
    }
    if has("config") {
        out.add(format!("src/main/java/{pkg_path}/config/ModConfig.java"), java_file(&format!("{pkg}.config"), &fill(FABRIC_CONFIG, &vars)));
    }
    let mut translations = Map::new();
    if has("item") {
        translations.insert(format!("item.{id}.example_item"), json!("Example Item"));
    }
    if has("block") {
        translations.insert(format!("block.{id}.example_block"), json!("Example Block"));
    }
    if datagen {
        let mut dg: Vec<String> = vec![
            "java.util.concurrent.CompletableFuture".into(),
            "net.fabricmc.fabric.api.datagen.v1.FabricDataOutput".into(),
            "net.fabricmc.fabric.api.datagen.v1.provider.FabricLanguageProvider".into(),
            "net.minecraft.core.HolderLookup".into(),
        ];
        if has("item") {
            dg.push(format!("{pkg}.registry.ModItems"));
        }
        if has("block") {
            dg.push(format!("{pkg}.registry.ModBlocks"));
        }
        out.add(format!("src/client/java/{pkg_path}/client/datagen/{cls}DataGenerator.java"), java_file(&format!("{pkg}.client.datagen"), &fill(FABRIC_DATAGEN, &[("cls", &cls)])));
        let mut lines = String::new();
        if has("item") {
            lines.push_str("\t\tbuilder.add(ModItems.EXAMPLE_ITEM, \"Example Item\");\n");
        }
        if has("block") {
            lines.push_str("\t\tbuilder.add(ModBlocks.EXAMPLE_BLOCK, \"Example Block\");\n");
        }
        out.add(
            format!("src/client/java/{pkg_path}/client/datagen/ModLanguageProvider.java"),
            java_file(&format!("{pkg}.client.datagen"), &fill(FABRIC_LANG, &[("imports", &imports(&dg)), ("lines", &lines), ("id", id)])),
        );
    } else if !translations.is_empty() {
        out.add(format!("src/main/resources/assets/{id}/lang/en_us.json"), json_tab(&Value::Object(translations)));
    }
    out.add(format!("src/main/resources/assets/{id}/icon.png"), placeholder_texture(&format!("{id}:icon"), false));
    out.add(
        format!("src/main/resources/{id}.mixins.json"),
        json_tab(&json!({ "required": true, "package": format!("{pkg}.mixin"), "compatibilityLevel": java_level, "mixins": [], "injectors": { "defaultRequire": 1 }, "overwrites": { "requireAnnotations": true } })),
    );
    if client_env {
        out.add(
            format!("src/client/resources/{id}.client.mixins.json"),
            json_tab(&json!({ "required": true, "package": format!("{pkg}.client.mixin"), "compatibilityLevel": java_level, "client": [], "injectors": { "defaultRequire": 1 }, "overwrites": { "requireAnnotations": true } })),
        );
    }
    let mut depends = Map::new();
    depends.insert("fabricloader".into(), json!(format!(">={loader}")));
    depends.insert("minecraft".into(), json!(format!("~{minecraft}")));
    depends.insert("java".into(), json!(format!(">={java}")));
    depends.insert(entry["fabric"]["apiModId"].as_str().unwrap_or("fabric-api").into(), json!("*"));
    let mut recommends = Map::new();
    for d in &opts.dependencies {
        if let Some(modid) = opts.resolved_ids.get(&dep_key(d)).and_then(|ids| ids.first()) {
            if d["required"] == true {
                depends.insert(modid.clone(), json!("*"));
            } else {
                recommends.insert(modid.clone(), json!("*"));
            }
        }
    }
    let mut entrypoints = Map::new();
    entrypoints.insert("main".into(), json!([format!("{pkg}.{cls}")]));
    if client_env {
        entrypoints.insert("client".into(), json!([format!("{pkg}.client.{cls}Client")]));
    }
    if datagen {
        entrypoints.insert("fabric-datagen".into(), json!([format!("{pkg}.client.datagen.{cls}DataGenerator")]));
    }
    let mut mixins = vec![json!(format!("{id}.mixins.json"))];
    if client_env {
        mixins.push(json!({ "config": format!("{id}.client.mixins.json"), "environment": "client" }));
    }
    let mut fmj = Map::new();
    fmj.insert("schemaVersion".into(), json!(1));
    fmj.insert("id".into(), json!(id));
    fmj.insert("version".into(), json!("${version}"));
    fmj.insert("name".into(), json!(opts.project_name));
    fmj.insert("description".into(), json!(opts.description));
    fmj.insert("authors".into(), if opts.author.is_empty() { json!([]) } else { json!([opts.author]) });
    fmj.insert("contact".into(), json!({}));
    fmj.insert("license".into(), json!(opts.license));
    fmj.insert("icon".into(), json!(format!("assets/{id}/icon.png")));
    fmj.insert("environment".into(), json!(if opts.environment == "both" { "*" } else { opts.environment.as_str() }));
    fmj.insert("entrypoints".into(), Value::Object(entrypoints));
    fmj.insert("mixins".into(), Value::Array(mixins));
    fmj.insert("depends".into(), Value::Object(depends));
    if !recommends.is_empty() {
        fmj.insert("recommends".into(), Value::Object(recommends));
    }
    out.add("src/main/resources/fabric.mod.json".into(), json_tab(&Value::Object(fmj)));
    out.0
}

const NEO_SETTINGS: &str = r##"pluginManagement {
\trepositories {
\t\tgradlePluginPortal()
\t}
}

plugins {
\tid 'org.gradle.toolchains.foojay-resolver-convention' version '1.0.0'
}

rootProject.name = '@@id@@'
"##;

const NEO_PROPERTIES: &str = r##"org.gradle.jvmargs=-Xmx2G
org.gradle.daemon=true
org.gradle.parallel=true
org.gradle.caching=true
org.gradle.configuration-cache=true

parchment_minecraft_version=@@parchmentMc@@
parchment_mappings_version=@@parchment@@
minecraft_version=@@minecraft@@
minecraft_version_range=[@@minecraft@@]
neo_version=@@loader@@
loader_version_range=[1,)

mod_id=@@id@@
mod_name=@@name@@
mod_license=@@license@@
mod_version=0.1.0
mod_group_id=@@pkg@@
mod_authors=@@authors@@
"##;

const NEO_BUILD: &str = r##"plugins {
\tid 'java-library'
\tid 'maven-publish'
\tid '@@pluginId@@' version '@@pluginVersion@@'
\tid 'idea'
}

tasks.named('wrapper', Wrapper).configure {
\tdistributionType = Wrapper.DistributionType.BIN
}

version = mod_version
group = mod_group_id

sourceSets.main.resources {
\tsrcDir('src/generated/resources')
\texclude('**/*.bbmodel')
\texclude('src/generated/**/.cache')
}

base {
\tarchivesName = mod_id
}

java.toolchain.languageVersion = JavaLanguageVersion.of(@@java@@)

neoForge {
\tversion = project.neo_version

\tparchment {
\t\tmappingsVersion = project.parchment_mappings_version
\t\tminecraftVersion = project.parchment_minecraft_version
\t}

\truns {
\t\tclient {
\t\t\tclient()
\t\t\tsystemProperty 'neoforge.enabledGameTestNamespaces', project.mod_id
\t\t}
\t\tserver {
\t\t\tserver()
\t\t\tprogramArgument '--nogui'
\t\t\tsystemProperty 'neoforge.enabledGameTestNamespaces', project.mod_id
\t\t}
\t\tgameTestServer {
\t\t\ttype = 'gameTestServer'
\t\t\tsystemProperty 'neoforge.enabledGameTestNamespaces', project.mod_id
\t\t}
\t\tdata {
\t\t\tdata()
\t\t\tprogramArguments.addAll '--mod', project.mod_id, '--all', '--output', file('src/generated/resources/').getAbsolutePath(), '--existing', file('src/main/resources/').getAbsolutePath()
\t\t}
\t\tconfigureEach {
\t\t\tsystemProperty 'forge.logging.markers', 'REGISTRIES'
\t\t\tlogLevel = org.slf4j.event.Level.DEBUG
\t\t}
\t}

\tmods {
\t\t"${mod_id}" {
\t\t\tsourceSet(sourceSets.main)
\t\t}
\t}
}

configurations {
\truntimeClasspath.extendsFrom localRuntime
}

dependencies {
}

apply from: 'modsmith.dependencies.gradle'

var generateModMetadata = tasks.register('generateModMetadata', ProcessResources) {
\tvar replaceProperties = [
\t\tminecraft_version      : minecraft_version,
\t\tminecraft_version_range: minecraft_version_range,
\t\tneo_version            : neo_version,
\t\tloader_version_range   : loader_version_range,
\t\tmod_id                 : mod_id,
\t\tmod_name               : mod_name,
\t\tmod_license            : mod_license,
\t\tmod_version            : mod_version,
\t\tmod_authors            : mod_authors
\t]
\tinputs.properties replaceProperties
\texpand replaceProperties
\tfrom 'src/main/templates'
\tinto 'build/generated/sources/modMetadata'
}
sourceSets.main.resources.srcDir generateModMetadata
neoForge.ideSyncTask generateModMetadata

publishing {
\tpublications {
\t\tregister('mavenJava', MavenPublication) {
\t\t\tfrom components.java
\t\t}
\t}
}

tasks.withType(JavaCompile).configureEach {
\toptions.encoding = 'UTF-8'
}
"##;

const NEO_GITIGNORE: &str = ".gradle/\nbuild/\nout/\nclasses/\n.idea/\n*.iml\n*.ipr\n*.iws\n.settings/\n.eclipse/\n.vscode/\nbin/\n.classpath\n.project\nrun/\nruns/\nrun-data/\nrepo/\n.modsmith/\n";

const NEO_MODS_TOML: &str = r##"modLoader="javafml"
loaderVersion="${loader_version_range}"
license="${mod_license}"

[[mods]]
modId="${mod_id}"
version="${mod_version}"
displayName="${mod_name}"
authors="${mod_authors}"
description=@@description@@

@@neoDep@@
@@mcDep@@
@@extra@@"##;

const NEO_MAIN: &str = r##"
@@imports@@

@Mod(@@cls@@.MOD_ID)
public class @@cls@@ {
\tpublic static final String MOD_ID = "@@id@@";
\tpublic static final Logger LOGGER = LogUtils.getLogger();

\tpublic @@cls@@(IEventBus modEventBus, ModContainer modContainer) {
@@body@@\t\tLOGGER.info("{} initialized", MOD_ID);
\t}

\tpublic static ResourceLocation id(String path) {
\t\treturn ResourceLocation.fromNamespaceAndPath(MOD_ID, path);
\t}
}
"##;

const NEO_CLIENT: &str = r##"
@@imports@@

@Mod(value = @@cls@@.MOD_ID, dist = Dist.CLIENT)
public class @@cls@@Client {
\tpublic @@cls@@Client(ModContainer container) {
@@ctor@@\t}
}
"##;

const NEO_ITEMS: &str = r##"
import @@pkg@@.@@cls@@;
import net.minecraft.world.item.CreativeModeTabs;
import net.minecraft.world.item.Item;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.neoforge.event.BuildCreativeModeTabContentsEvent;
import net.neoforged.neoforge.registries.DeferredItem;
import net.neoforged.neoforge.registries.DeferredRegister;

public final class ModItems {
\tpublic static final DeferredRegister.Items ITEMS = DeferredRegister.createItems(@@cls@@.MOD_ID);
\tpublic static final DeferredItem<Item> EXAMPLE_ITEM = ITEMS.registerSimpleItem("example_item", new Item.Properties());

\tprivate ModItems() {
\t}

\tpublic static void register(IEventBus modEventBus) {
\t\tITEMS.register(modEventBus);
\t\tmodEventBus.addListener(ModItems::addToCreativeTabs);
\t}

\tprivate static void addToCreativeTabs(BuildCreativeModeTabContentsEvent event) {
\t\tif (event.getTabKey() == CreativeModeTabs.INGREDIENTS) {
\t\t\tevent.accept(EXAMPLE_ITEM);
\t\t}
\t}
}
"##;

const NEO_BLOCKS: &str = r##"
import @@pkg@@.@@cls@@;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.CreativeModeTabs;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.SoundType;
import net.minecraft.world.level.block.state.BlockBehaviour;
import net.minecraft.world.level.material.MapColor;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.neoforge.event.BuildCreativeModeTabContentsEvent;
import net.neoforged.neoforge.registries.DeferredBlock;
import net.neoforged.neoforge.registries.DeferredItem;
import net.neoforged.neoforge.registries.DeferredRegister;

public final class ModBlocks {
\tpublic static final DeferredRegister.Blocks BLOCKS = DeferredRegister.createBlocks(@@cls@@.MOD_ID);
\tpublic static final DeferredRegister.Items BLOCK_ITEMS = DeferredRegister.createItems(@@cls@@.MOD_ID);
\tpublic static final DeferredBlock<Block> EXAMPLE_BLOCK = BLOCKS.registerSimpleBlock("example_block", BlockBehaviour.Properties.of().mapColor(MapColor.STONE).strength(1.5f, 6.0f).sound(SoundType.STONE));
\tpublic static final DeferredItem<BlockItem> EXAMPLE_BLOCK_ITEM = BLOCK_ITEMS.registerSimpleBlockItem("example_block", EXAMPLE_BLOCK);

\tprivate ModBlocks() {
\t}

\tpublic static void register(IEventBus modEventBus) {
\t\tBLOCKS.register(modEventBus);
\t\tBLOCK_ITEMS.register(modEventBus);
\t\tmodEventBus.addListener(ModBlocks::addToCreativeTabs);
\t}

\tprivate static void addToCreativeTabs(BuildCreativeModeTabContentsEvent event) {
\t\tif (event.getTabKey() == CreativeModeTabs.BUILDING_BLOCKS) {
\t\t\tevent.accept(EXAMPLE_BLOCK_ITEM);
\t\t}
\t}
}
"##;

const NEO_COMMANDS: &str = r##"
import @@pkg@@.@@cls@@;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.Component;
import net.neoforged.neoforge.event.RegisterCommandsEvent;

public final class ModCommands {
\tprivate ModCommands() {
\t}

\tpublic static void register(RegisterCommandsEvent event) {
\t\tevent.getDispatcher().register(Commands.literal(@@cls@@.MOD_ID).then(Commands.literal("hello").executes(context -> {
\t\t\tcontext.getSource().sendSuccess(() -> Component.literal("Hello from " + @@cls@@.MOD_ID), false);
\t\t\treturn 1;
\t\t})));
\t}
}
"##;

const NEO_CONFIG: &str = r##"
import net.neoforged.neoforge.common.ModConfigSpec;

public final class Config {
\tprivate static final ModConfigSpec.Builder BUILDER = new ModConfigSpec.Builder();

\tpublic static final ModConfigSpec.BooleanValue EXAMPLE_TOGGLE = BUILDER.comment("An example toggle").define("exampleToggle", true);
\tpublic static final ModConfigSpec.IntValue EXAMPLE_NUMBER = BUILDER.comment("An example number").defineInRange("exampleNumber", 5, 0, 100);

\tpublic static final ModConfigSpec SPEC = BUILDER.build();

\tprivate Config() {
\t}
}
"##;

const NEO_LANG: &str = r##"
@@imports@@

public class ModLanguageProvider extends LanguageProvider {
\tpublic ModLanguageProvider(PackOutput output) {
\t\tsuper(output, @@cls@@.MOD_ID, "en_us");
\t}

\t@Override
\tprotected void addTranslations() {
@@lines@@\t\tadd("@@id@@.generated", "Generated by data generation");
\t}
}
"##;

const NEO_DATAGEN: &str = r##"
import @@pkg@@.@@cls@@;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;
import net.neoforged.neoforge.data.event.GatherDataEvent;

@EventBusSubscriber(modid = @@cls@@.MOD_ID, bus = EventBusSubscriber.Bus.MOD)
public final class ModDataGenerators {
\tprivate ModDataGenerators() {
\t}

\t@SubscribeEvent
\tpublic static void gatherData(GatherDataEvent event) {
\t\tevent.getGenerator().addProvider(event.includeClient(), new ModLanguageProvider(event.getGenerator().getPackOutput()));
\t}
}
"##;

fn toml_string(s: &str) -> String {
    format!("'''{}'''", s.replace("'''", "''"))
}

fn one_line(s: &str) -> String {
    s.replace(['\r', '\n'], " ")
}

pub fn generate_neoforge(opts: &Scaffold, entry: &Value) -> Vec<GeneratedFile> {
    let mut out = Out(Vec::new());
    let id = opts.mod_id.as_str();
    let pkg = opts.package_name.as_str();
    let cls = to_class_name(&opts.project_name);
    let pkg_path = pkg.replace('.', "/");
    let has = |s: &str| opts.starters.iter().any(|x| x == s);
    let client_env = opts.environment != "server";
    let datagen = has("datagen");
    let minecraft = js::string(&entry["minecraft"]);
    let loader = js::string(&entry["loaderVersion"]);
    let (parchment_mc, parchment) = match entry.get("parchment").filter(|p| p.is_object()) {
        Some(p) => (js::string(&p["minecraft"]), js::string(&p["version"])),
        None => (minecraft.clone(), String::new()),
    };
    let java = js::string(&entry["javaRelease"]);
    out.add("settings.gradle".into(), fill(NEO_SETTINGS, &[("id", id)]));
    out.add(
        "gradle.properties".into(),
        fill(
            NEO_PROPERTIES,
            &[
                ("parchmentMc", &parchment_mc),
                ("parchment", &parchment),
                ("minecraft", &minecraft),
                ("loader", &loader),
                ("id", id),
                ("name", &one_line(&opts.project_name)),
                ("license", &opts.license),
                ("pkg", pkg),
                ("authors", &one_line(&opts.author)),
            ],
        ),
    );
    out.add("build.gradle".into(), fill(NEO_BUILD, &[("pluginId", &js::string(&entry["plugin"]["id"])), ("pluginVersion", &js::string(&entry["plugin"]["version"])), ("java", &java)]));
    out.add("modsmith.dependencies.gradle".into(), neoforge_dependency_gradle(opts));
    out.add("gradle/wrapper/gradle-wrapper.properties".into(), wrapper_properties(&js::string(&entry["gradleVersion"])));
    out.add(".gitignore".into(), NEO_GITIGNORE);
    out.add("LICENSE".into(), license(opts));
    out.add(
        "README.md".into(),
        format!(
            "# {}\n\n{}\n\n- Minecraft {minecraft}\n- NeoForge {loader}\n- Parchment {parchment}\n\nGenerated by Modsmith from catalog entry `{}` ({}).\n\nBuild with `./gradlew build`. The Java {java} toolchain is selected by Gradle; the foojay resolver can download it when missing.\n",
            opts.project_name,
            opts.description,
            js::string(&entry["id"]),
            js::string(&entry["templateSource"])
        ),
    );
    let side_dep = |dep: &str, range: &str| format!("[[dependencies.${{mod_id}}]]\nmodId=\"{dep}\"\ntype=\"required\"\nversionRange=\"{range}\"\nordering=\"NONE\"\nside=\"BOTH\"\n");
    let mut extra: Vec<String> = Vec::new();
    for d in &opts.dependencies {
        if let Some(modid) = opts.resolved_ids.get(&dep_key(d)).and_then(|ids| ids.first()) {
            extra.push(format!(
                "[[dependencies.${{mod_id}}]]\nmodId=\"{modid}\"\ntype=\"{}\"\nversionRange=\"*\"\nordering=\"NONE\"\nside=\"BOTH\"\n",
                if d["required"] == true { "required" } else { "optional" }
            ));
        }
    }
    let description = if opts.description.is_empty() { opts.project_name.as_str() } else { opts.description.as_str() };
    out.add(
        "src/main/templates/META-INF/neoforge.mods.toml".into(),
        fill(
            NEO_MODS_TOML,
            &[
                ("description", &toml_string(description)),
                ("neoDep", &side_dep("neoforge", "[${neo_version},)")),
                ("mcDep", &side_dep("minecraft", "${minecraft_version_range}")),
                ("extra", &extra.join("\n")),
            ],
        ),
    );
    let mut imps: Vec<String> = [
        "com.mojang.logging.LogUtils",
        "net.minecraft.resources.ResourceLocation",
        "net.neoforged.bus.api.IEventBus",
        "net.neoforged.fml.ModContainer",
        "net.neoforged.fml.common.Mod",
        "org.slf4j.Logger",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let mut body: Vec<&str> = Vec::new();
    if has("item") {
        imps.push(format!("{pkg}.registry.ModItems"));
        body.push("ModItems.register(modEventBus);");
    }
    if has("block") {
        imps.push(format!("{pkg}.registry.ModBlocks"));
        body.push("ModBlocks.register(modEventBus);");
    }
    if has("command") {
        imps.push(format!("{pkg}.command.ModCommands"));
        imps.push("net.neoforged.neoforge.common.NeoForge".into());
        body.push("NeoForge.EVENT_BUS.addListener(ModCommands::register);");
    }
    if has("config") {
        imps.push(format!("{pkg}.config.Config"));
        imps.push("net.neoforged.fml.config.ModConfig".into());
        body.push("modContainer.registerConfig(ModConfig.Type.COMMON, Config.SPEC);");
    }
    let mut unique: Vec<String> = Vec::new();
    for i in imps {
        if !unique.contains(&i) {
            unique.push(i);
        }
    }
    let body_text = body.iter().map(|b| format!("\t\t{b}\n")).collect::<String>();
    out.add(format!("src/main/java/{pkg_path}/{cls}.java"), java_file(pkg, &fill(NEO_MAIN, &[("imports", &imports(&unique)), ("cls", &cls), ("id", id), ("body", &body_text)])));
    if client_env {
        let mut ci: Vec<String> = vec!["net.neoforged.api.distmarker.Dist".into(), "net.neoforged.fml.ModContainer".into(), "net.neoforged.fml.common.Mod".into(), format!("{pkg}.{cls}")];
        let mut ctor = "";
        if has("config") {
            ci.push("net.neoforged.neoforge.client.gui.ConfigurationScreen".into());
            ci.push("net.neoforged.neoforge.client.gui.IConfigScreenFactory".into());
            ctor = "\t\tcontainer.registerExtensionPoint(IConfigScreenFactory.class, ConfigurationScreen::new);\n";
        }
        out.add(format!("src/main/java/{pkg_path}/client/{cls}Client.java"), java_file(&format!("{pkg}.client"), &fill(NEO_CLIENT, &[("imports", &imports(&ci)), ("cls", &cls), ("ctor", ctor)])));
    }
    let vars = [("pkg", pkg), ("cls", cls.as_str())];
    if has("item") {
        out.add(format!("src/main/java/{pkg_path}/registry/ModItems.java"), java_file(&format!("{pkg}.registry"), &fill(NEO_ITEMS, &vars)));
        shared_assets(&mut out, id, &has);
    }
    if has("block") {
        out.add(format!("src/main/java/{pkg_path}/registry/ModBlocks.java"), java_file(&format!("{pkg}.registry"), &fill(NEO_BLOCKS, &vars)));
        block_assets(&mut out, id);
    }
    if has("command") {
        out.add(format!("src/main/java/{pkg_path}/command/ModCommands.java"), java_file(&format!("{pkg}.command"), &fill(NEO_COMMANDS, &vars)));
    }
    if has("config") {
        out.add(format!("src/main/java/{pkg_path}/config/Config.java"), java_file(&format!("{pkg}.config"), &fill(NEO_CONFIG, &[])));
    }
    let mut translations: Vec<(String, String)> = Vec::new();
    if has("item") {
        translations.push((format!("item.{id}.example_item"), "Example Item".into()));
    }
    if has("block") {
        translations.push((format!("block.{id}.example_block"), "Example Block".into()));
    }
    if has("config") {
        let title = format!("{} Configs", opts.project_name);
        translations.push((format!("{id}.configuration.title"), title.clone()));
        translations.push((format!("{id}.configuration.section.{id}.common.toml"), title.clone()));
        translations.push((format!("{id}.configuration.section.{id}.common.toml.title"), title));
        translations.push((format!("{id}.configuration.exampleToggle"), "Example toggle".into()));
        translations.push((format!("{id}.configuration.exampleNumber"), "Example number".into()));
    }
    if datagen {
        let mut lp: Vec<String> = vec!["net.minecraft.data.PackOutput".into(), "net.neoforged.neoforge.common.data.LanguageProvider".into(), format!("{pkg}.{cls}")];
        if has("item") {
            lp.push(format!("{pkg}.registry.ModItems"));
        }
        if has("block") {
            lp.push(format!("{pkg}.registry.ModBlocks"));
        }
        let lines: Vec<String> =
            translations.iter().filter(|(k, _)| !k.starts_with("item.") && !k.starts_with("block.")).map(|(k, v)| format!("\t\tadd(\"{k}\", \"{}\");", v.replace('"', "\\\""))).collect();
        let mut text = String::new();
        if has("item") {
            text.push_str("\t\taddItem(ModItems.EXAMPLE_ITEM, \"Example Item\");\n");
        }
        if has("block") {
            text.push_str("\t\taddBlock(ModBlocks.EXAMPLE_BLOCK, \"Example Block\");\n");
        }
        text.push_str(&lines.join("\n"));
        if !lines.is_empty() {
            text.push('\n');
        }
        out.add(
            format!("src/main/java/{pkg_path}/datagen/ModLanguageProvider.java"),
            java_file(&format!("{pkg}.datagen"), &fill(NEO_LANG, &[("imports", &imports(&lp)), ("cls", &cls), ("lines", &text), ("id", id)])),
        );
        out.add(format!("src/main/java/{pkg_path}/datagen/ModDataGenerators.java"), java_file(&format!("{pkg}.datagen"), &fill(NEO_DATAGEN, &vars)));
    } else if !translations.is_empty() {
        let mut m = Map::new();
        for (k, v) in translations {
            m.insert(k, json!(v));
        }
        out.add(format!("src/main/resources/assets/{id}/lang/en_us.json"), json_tab(&Value::Object(m)));
    }
    out.0
}

pub fn generate(opts: &Scaffold, entry: &Value) -> Result<Vec<GeneratedFile>, String> {
    match entry["loader"].as_str() {
        Some("fabric") => Ok(generate_fabric(opts, entry)),
        Some("neoforge") => Ok(generate_neoforge(opts, entry)),
        _ => Err("Forge project generation is not implemented".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn class_names() {
        assert_eq!(to_class_name("Starter Test"), "StarterTest");
        assert_eq!(to_class_name("3d things"), "Mod3dThings");
        assert_eq!(to_class_name("class"), "ClassMod");
        assert_eq!(to_class_name("my-cool_mod"), "MyCoolMod");
    }

    #[test]
    fn ids_and_packages() {
        assert!(validate_mod_id("ab").is_none());
        assert!(validate_mod_id("Ab").is_some());
        assert_eq!(validate_mod_id("fabric").unwrap(), "Mod ID \"fabric\" is reserved");
        assert!(validate_package("com.example.mod").is_none());
        assert!(validate_package("com.example.int").unwrap().contains("Java keyword"));
    }
}
