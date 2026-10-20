use base64::Engine;
use serde_json::{Map, Value};
use std::fs;
use std::path::PathBuf;

pub struct SecretStore {
    file: PathBuf,
}

pub fn supported() -> bool {
    cfg!(windows)
}

#[cfg(windows)]
fn dpapi(protect: bool, input: &[u8]) -> Result<Vec<u8>, String> {
    use windows::core::w;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};
    let data_in = CRYPT_INTEGER_BLOB { cbData: input.len() as u32, pbData: input.as_ptr() as *mut u8 };
    let mut out = CRYPT_INTEGER_BLOB::default();
    let ok = unsafe {
        if protect {
            CryptProtectData(&data_in, w!("Modsmith secret"), None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out)
        } else {
            CryptUnprotectData(&data_in, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out)
        }
    };
    if ok.is_err() {
        return Err(format!("DPAPI {} failed", if protect { "protect" } else { "unprotect" }));
    }
    let bytes = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec() };
    unsafe {
        let _ = LocalFree(Some(HLOCAL(out.pbData as *mut core::ffi::c_void)));
    }
    Ok(bytes)
}

#[cfg(not(windows))]
fn dpapi(_protect: bool, _input: &[u8]) -> Result<Vec<u8>, String> {
    Err("Operating-system secret storage is only implemented on Windows (DPAPI). Set the value through an environment variable instead.".into())
}

impl SecretStore {
    pub fn new(file: PathBuf) -> SecretStore {
        SecretStore { file }
    }

    fn read(&self) -> Result<Map<String, Value>, String> {
        if !self.file.exists() {
            return Ok(Map::new());
        }
        let text = fs::read_to_string(&self.file).map_err(|e| crate::js::fs_error(&e, "open", &self.file))?;
        match serde_json::from_str::<Value>(&text).map_err(|e| e.to_string())? {
            Value::Object(m) => Ok(m),
            _ => Ok(Map::new()),
        }
    }

    fn write(&self, data: &Map<String, Value>) -> Result<(), String> {
        if let Some(dir) = self.file.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let tmp = PathBuf::from(format!("{}.tmp", self.file.display()));
        fs::write(&tmp, serde_json::to_string_pretty(&Value::Object(data.clone())).unwrap_or_default()).map_err(|e| crate::js::fs_error(&e, "open", &tmp))?;
        fs::rename(&tmp, &self.file).map_err(|e| crate::js::fs_error(&e, "rename", &tmp))
    }

    pub fn set(&self, name: &str, value: &str) -> Result<(), String> {
        let mut data = self.read()?;
        let blob = dpapi(true, value.as_bytes())?;
        data.insert(name.to_string(), Value::String(base64::engine::general_purpose::STANDARD.encode(blob)));
        self.write(&data)
    }

    pub fn get(&self, name: &str) -> Result<Option<String>, String> {
        let data = self.read()?;
        let Some(encoded) = data.get(name).and_then(Value::as_str).filter(|s| !s.is_empty()) else { return Ok(None) };
        let blob = base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|e| e.to_string())?;
        Ok(Some(String::from_utf8_lossy(&dpapi(false, &blob)?).into_owned()))
    }

    pub fn has(&self, name: &str) -> bool {
        self.read().ok().and_then(|d| d.get(name).map(|v| crate::js::truthy(Some(v)))).unwrap_or(false)
    }

    pub fn delete(&self, name: &str) -> Result<(), String> {
        let mut data = self.read()?;
        data.shift_remove(name);
        self.write(&data)
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn round_trips_through_dpapi() {
        let file = std::env::temp_dir().join(format!("modsmith-secrets-{}.json", std::process::id()));
        let _ = fs::remove_file(&file);
        let s = SecretStore::new(file.clone());
        s.set("test.value", "not-a-real-key-123456").unwrap();
        assert!(!fs::read_to_string(&file).unwrap().contains("not-a-real-key"));
        assert_eq!(s.get("test.value").unwrap().as_deref(), Some("not-a-real-key-123456"));
        s.delete("test.value").unwrap();
        assert!(!s.has("test.value"));
    }
}
