use regex::Regex;
use std::sync::OnceLock;

#[derive(Clone, Debug, PartialEq)]
enum Part {
    Num(f64),
    Str(String),
}

struct Parts {
    core: Vec<Part>,
    pre: Vec<Part>,
}

fn split(s: &str) -> Vec<Part> {
    s.split(['.', '-', '_']).filter(|p| !p.is_empty()).map(|p| if p.chars().all(|c| c.is_ascii_digit()) { Part::Num(p.parse::<f64>().unwrap_or(0.0)) } else { Part::Str(p.to_lowercase()) }).collect()
}

fn parts(v: &str) -> Parts {
    let t = v.trim();
    let t = if !t.is_empty() && (t.starts_with('v') || t.starts_with('V')) { &t[1..] } else { t };
    let clean = t.split('+').next().unwrap_or("");
    match clean.find('-') {
        Some(i) => Parts { core: split(&clean[..i]), pre: split(&clean[i + 1..]) },
        None => Parts { core: split(clean), pre: vec![] },
    }
}

fn js_less(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

fn cmp_part(a: Option<&Part>, b: Option<&Part>) -> f64 {
    match (a, b) {
        (None, None) => 0.0,
        (None, Some(Part::Num(n))) => {
            if *n == 0.0 {
                0.0
            } else {
                -1.0
            }
        }
        (None, Some(_)) => -1.0,
        (Some(Part::Num(n)), None) => {
            if *n == 0.0 {
                0.0
            } else {
                1.0
            }
        }
        (Some(_), None) => 1.0,
        (Some(Part::Num(x)), Some(Part::Num(y))) => x - y,
        (Some(Part::Num(_)), Some(Part::Str(_))) => 1.0,
        (Some(Part::Str(_)), Some(Part::Num(_))) => -1.0,
        (Some(Part::Str(x)), Some(Part::Str(y))) => match js_less(x, y) {
            std::cmp::Ordering::Less => -1.0,
            std::cmp::Ordering::Greater => 1.0,
            std::cmp::Ordering::Equal => 0.0,
        },
    }
}

pub fn compare_versions(a: &str, b: &str) -> f64 {
    let pa = parts(a);
    let pb = parts(b);
    for i in 0..pa.core.len().max(pb.core.len()) {
        let c = cmp_part(pa.core.get(i), pb.core.get(i));
        if c != 0.0 && !c.is_nan() {
            return c;
        }
    }
    if pa.pre.is_empty() && !pb.pre.is_empty() {
        return 1.0;
    }
    if !pa.pre.is_empty() && pb.pre.is_empty() {
        return -1.0;
    }
    for i in 0..pa.pre.len().max(pb.pre.len()) {
        let c = cmp_part(pa.pre.get(i), pb.pre.get(i));
        if c != 0.0 && !c.is_nan() {
            return c;
        }
    }
    0.0
}

fn bump(v: &str, index: usize) -> String {
    let mut nums: Vec<f64> = parts(v).core.iter().map(|p| if let Part::Num(n) = p { *n } else { 0.0 }).collect();
    while nums.len() <= index {
        nums.push(0.0);
    }
    nums[index] += 1.0;
    nums[..=index].iter().map(|n| crate::js::number_string(*n)).collect::<Vec<_>>().join(".")
}

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).unwrap()
}

fn comparator(term: &str, version: &str) -> Option<bool> {
    static TERM: OnceLock<Regex> = OnceLock::new();
    let m = TERM.get_or_init(|| re(r"^(>=|<=|>|<|=|~|\^)?\s*(.+)$")).captures(term.trim())?;
    let explicit = m.get(1).map(|x| x.as_str());
    let op = explicit.unwrap_or("=");
    let target = m.get(2).map(|x| x.as_str()).unwrap_or("");
    if target == "*" || target.eq_ignore_ascii_case("x") {
        return Some(true);
    }
    if re(r"(?i)[.\-]x$|[.\-]\*$").is_match(target) && (op == "=" || explicit.is_none()) {
        let prefix = re(r"(?i)[.\-](x|\*)$").replace(target, "").to_string();
        let v = parts(version).core;
        let p = parts(&prefix).core;
        return Some(p.iter().enumerate().all(|(i, x)| cmp_part(v.get(i), Some(x)) == 0.0));
    }
    if !target.chars().any(|c| c.is_ascii_digit()) {
        return None;
    }
    let c = compare_versions(version, target);
    Some(match op {
        ">=" => c >= 0.0,
        "<=" => c <= 0.0,
        ">" => c > 0.0,
        "<" => c < 0.0,
        "~" => {
            let len = parts(target).core.len();
            let upper = if len == 0 { String::new() } else { bump(target, (len - 1).min(1)) };
            c >= 0.0 && compare_versions(version, &upper) < 0.0
        }
        "^" => {
            let first = parts(target).core.iter().position(|p| *p != Part::Num(0.0)).map(|i| i as i64).unwrap_or(-1);
            c >= 0.0 && compare_versions(version, &bump(target, first.max(0) as usize)) < 0.0
        }
        _ => c == 0.0,
    })
}

fn maven_range(range: &str, version: &str) -> Option<bool> {
    let sets: Vec<&str> = re(r"[\[(][^\])]*[\])]").find_iter(range).map(|m| m.as_str()).collect();
    if sets.is_empty() {
        return None;
    }
    Some(sets.iter().any(|set| {
        let low_inc = set.starts_with('[');
        let high_inc = set.ends_with(']');
        let inner = &set[1..set.len() - 1];
        let mut pieces = inner.split(',').map(str::trim);
        let low = pieces.next().unwrap_or("");
        let high = pieces.next();
        let Some(high) = high else {
            return if !low.is_empty() { compare_versions(version, low) == 0.0 } else { true };
        };
        if !low.is_empty() && (if low_inc { compare_versions(version, low) < 0.0 } else { compare_versions(version, low) <= 0.0 }) {
            return false;
        }
        if !high.is_empty() && (if high_inc { compare_versions(version, high) > 0.0 } else { compare_versions(version, high) >= 0.0 }) {
            return false;
        }
        true
    }))
}

pub fn satisfies(version: &str, predicate: &str) -> Option<bool> {
    let p = predicate.trim();
    if p.is_empty() || p == "*" {
        return Some(true);
    }
    if version.is_empty() || !version.chars().any(|c| c.is_ascii_digit()) {
        return None;
    }
    if p.starts_with('[') || p.starts_with('(') {
        return maven_range(p, version);
    }
    let mut unknown = false;
    for alt in p.split("||") {
        let terms: Vec<&str> = alt.split_whitespace().collect();
        if terms.is_empty() {
            continue;
        }
        let mut all = true;
        for t in terms {
            let r = comparator(t, version);
            if r.is_none() {
                unknown = true;
            }
            if r != Some(true) {
                all = false;
            }
        }
        if all {
            return Some(true);
        }
    }
    if unknown {
        None
    } else {
        Some(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges() {
        assert_eq!(satisfies("1.21.1", ">=1.21"), Some(true));
        assert_eq!(satisfies("1.20.1", "~1.21"), Some(false));
        assert_eq!(satisfies("0.16.10", "^0.16.0"), Some(true));
        assert_eq!(satisfies("0.17.0", "^0.16.0"), Some(false));
        assert_eq!(satisfies("21.1.77", "[21.1,)"), Some(true));
        assert_eq!(satisfies("1.21.1", "1.21.x"), Some(true));
        assert_eq!(satisfies("1.0", "foo"), None);
        assert_eq!(satisfies("1.0-beta.2", ">=1.0"), Some(false));
        assert!(compare_versions("1.0.0", "1.0") == 0.0);
    }
}
