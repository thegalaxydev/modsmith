use std::fs;
use std::path::{Path, PathBuf};

pub const PRODUCT_NAME: &str = "Modsmith";
pub const PRODUCT_ID: &str = "modsmith";
const LEGACY_NAME: &str = "ModWorkbench";
const DATA_FILES: [&str; 3] = ["workbench.sqlite", "workbench.sqlite-wal", "workbench.sqlite-shm"];

pub struct Paths {
    pub data: PathBuf,
    pub cache: PathBuf,
}

impl Paths {
    pub fn service_file(&self) -> PathBuf {
        self.data.join("service.json")
    }

    pub fn lock_file(&self) -> PathBuf {
        self.data.join("service.json.lock")
    }

    pub fn log_file(&self) -> PathBuf {
        self.data.join("service.log")
    }
}

fn env_dir(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from)
}

fn home() -> PathBuf {
    env_dir("USERPROFILE").or_else(|| env_dir("HOME")).unwrap_or_default()
}

fn default_data_dir() -> PathBuf {
    if cfg!(windows) {
        env_dir("APPDATA").unwrap_or_else(|| home().join("AppData").join("Roaming")).join(PRODUCT_NAME)
    } else if cfg!(target_os = "macos") {
        home().join("Library").join("Application Support").join(PRODUCT_NAME)
    } else {
        env_dir("XDG_CONFIG_HOME").unwrap_or_else(|| home().join(".config")).join(PRODUCT_ID)
    }
}

fn default_cache_dir() -> PathBuf {
    if cfg!(windows) {
        env_dir("LOCALAPPDATA").unwrap_or_else(|| home().join("AppData").join("Local")).join(PRODUCT_NAME).join("cache")
    } else if cfg!(target_os = "macos") {
        home().join("Library").join("Caches").join(PRODUCT_NAME)
    } else {
        env_dir("XDG_CACHE_HOME").unwrap_or_else(|| home().join(".cache")).join(PRODUCT_ID)
    }
}

pub fn migrate_data_dir(legacy: &Path, data: &Path) {
    if !legacy.join(DATA_FILES[0]).exists() || data.join(DATA_FILES[0]).exists() {
        return;
    }
    let _ = fs::create_dir_all(data);
    for f in DATA_FILES {
        let src = legacy.join(f);
        if src.exists() {
            let _ = fs::copy(&src, data.join(f));
        }
    }
}

pub fn migrate_cache_dir(legacy: &Path, cache: &Path) {
    if cache.exists() || !legacy.exists() {
        return;
    }
    if let Some(parent) = cache.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if !cache.exists() {
        let _ = fs::rename(legacy, cache);
    }
}

pub fn resolve() -> Paths {
    let data_override = env_dir("MODSMITH_DATA_DIR");
    let cache_override = env_dir("MODSMITH_CACHE_DIR");
    let data = data_override.clone().unwrap_or_else(default_data_dir);
    let cache = cache_override.clone().unwrap_or_else(default_cache_dir);
    if cfg!(windows) && data_override.is_none() {
        if let Some(parent) = data.parent() {
            migrate_data_dir(&parent.join(LEGACY_NAME), &data);
        }
    }
    if cfg!(windows) && cache_override.is_none() {
        if let Some(root) = cache.parent().and_then(Path::parent) {
            migrate_cache_dir(&root.join(LEGACY_NAME).join("cache"), &cache);
        }
    }
    let _ = fs::create_dir_all(&data);
    let _ = fs::create_dir_all(&cache);
    Paths { data, cache }
}

pub fn exe_dir() -> PathBuf {
    std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)).unwrap_or_default()
}

pub fn find_upwards(start: &Path, rel: &[&str], levels: usize) -> Option<PathBuf> {
    let mut dir = Some(start.to_path_buf());
    for _ in 0..levels {
        let d = dir?;
        let candidate = rel.iter().fold(d.clone(), |p, part| p.join(part));
        if candidate.exists() {
            return Some(candidate);
        }
        dir = d.parent().map(Path::to_path_buf);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("modsmith-paths-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn migrates_legacy_data_once() {
        let root = tmp("data");
        let legacy = root.join("ModWorkbench");
        let data = root.join("Modsmith");
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("workbench.sqlite"), b"db").unwrap();
        fs::write(legacy.join("workbench.sqlite-wal"), b"wal").unwrap();
        migrate_data_dir(&legacy, &data);
        assert_eq!(fs::read(data.join("workbench.sqlite")).unwrap(), b"db");
        assert_eq!(fs::read(data.join("workbench.sqlite-wal")).unwrap(), b"wal");
        fs::write(legacy.join("workbench.sqlite"), b"newer").unwrap();
        migrate_data_dir(&legacy, &data);
        assert_eq!(fs::read(data.join("workbench.sqlite")).unwrap(), b"db");
        assert!(legacy.join("workbench.sqlite").exists());
    }

    #[test]
    fn moves_legacy_cache_only_when_missing() {
        let root = tmp("cache");
        let legacy = root.join("ModWorkbench").join("cache");
        let cache = root.join("Modsmith").join("cache");
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("a"), b"1").unwrap();
        migrate_cache_dir(&legacy, &cache);
        assert!(cache.join("a").exists());
        assert!(!legacy.exists());
    }
}
