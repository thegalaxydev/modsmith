use base64::Engine;
use serde_json::{Map, Value};
use std::fs;
use std::path::PathBuf;

pub struct SecretStore {
    file: PathBuf,
}

const KEYRING_MARKER: &str = "secret-service";
#[cfg(target_os = "linux")]
const KEYRING_SERVICE: &str = "Modsmith";

pub fn supported() -> bool {
    cfg!(any(windows, target_os = "linux"))
}

pub fn storage_label() -> &'static str {
    if cfg!(windows) {
        "Windows DPAPI (current user)"
    } else {
        "Secret Service (desktop keyring)"
    }
}

pub fn storage_short() -> &'static str {
    if cfg!(windows) {
        "Windows DPAPI"
    } else {
        "Secret Service"
    }
}

#[cfg(target_os = "linux")]
fn keyring_entry(name: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, name).map_err(|e| format!("Desktop keyring unavailable: {e}. Set the value through an environment variable instead."))
}

#[cfg(target_os = "linux")]
fn keyring_set(name: &str, value: &str) -> Result<(), String> {
    keyring_entry(name)?.set_password(value).map_err(|e| format!("Could not store the secret in the desktop keyring: {e}"))
}

#[cfg(target_os = "linux")]
fn keyring_get(name: &str) -> Result<Option<String>, String> {
    match keyring_entry(name)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Could not read the secret from the desktop keyring: {e}")),
    }
}

#[cfg(target_os = "linux")]
fn keyring_delete(name: &str) {
    if let Ok(e) = keyring_entry(name) {
        let _ = e.delete_credential();
    }
}

#[cfg(not(target_os = "linux"))]
fn keyring_set(_name: &str, _value: &str) -> Result<(), String> {
    Err("The desktop keyring is only used on Linux".into())
}

#[cfg(not(target_os = "linux"))]
fn keyring_get(_name: &str) -> Result<Option<String>, String> {
    Ok(None)
}

#[cfg(not(target_os = "linux"))]
fn keyring_delete(_name: &str) {}

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
        if cfg!(target_os = "linux") {
            keyring_set(name, value)?;
            data.insert(name.to_string(), Value::String(KEYRING_MARKER.into()));
            return self.write(&data);
        }
        let blob = dpapi(true, value.as_bytes())?;
        data.insert(name.to_string(), Value::String(base64::engine::general_purpose::STANDARD.encode(blob)));
        self.write(&data)
    }

    pub fn get(&self, name: &str) -> Result<Option<String>, String> {
        let data = self.read()?;
        let Some(encoded) = data.get(name).and_then(Value::as_str).filter(|s| !s.is_empty()) else { return Ok(None) };
        if encoded == KEYRING_MARKER {
            return keyring_get(name);
        }
        let blob = base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|e| e.to_string())?;
        Ok(Some(String::from_utf8_lossy(&dpapi(false, &blob)?).into_owned()))
    }

    pub fn has(&self, name: &str) -> bool {
        self.read().ok().and_then(|d| d.get(name).map(|v| crate::js::truthy(Some(v)))).unwrap_or(false)
    }

    pub fn delete(&self, name: &str) -> Result<(), String> {
        let mut data = self.read()?;
        if data.get(name).and_then(Value::as_str) == Some(KEYRING_MARKER) {
            keyring_delete(name);
        }
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
