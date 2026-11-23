use std::path::{Path, PathBuf};

#[cfg(windows)]
pub fn redirect_dir(data: &Path) -> Option<PathBuf> {
    use std::sync::OnceLock;
    static CACHE: OnceLock<Option<PathBuf>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let appdata = std::env::var_os("APPDATA").map(PathBuf::from)?;
            let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from)?;
            let rel = data.strip_prefix(&appdata).ok()?.to_path_buf();
            std::fs::create_dir_all(data).ok()?;
            let name = format!(".redirect-check-{}", std::process::id());
            let marker = data.join(&name);
            std::fs::write(&marker, b"").ok()?;
            let found = std::fs::read_dir(local.join("Packages")).ok().and_then(|d| d.flatten().map(|e| e.path().join("LocalCache").join("Roaming").join(&rel)).find(|dir| dir.join(&name).exists()));
            let _ = std::fs::remove_file(&marker);
            found
        })
        .clone()
}

#[cfg(not(windows))]
pub fn redirect_dir(_data: &Path) -> Option<PathBuf> {
    None
}

pub fn unshadow(data: &Path) {
    if let Some(dir) = redirect_dir(data) {
        let _ = std::fs::remove_file(dir.join("service.json"));
    }
}

#[cfg(windows)]
pub fn spawn_outside(exe: &Path) -> Result<u32, String> {
    use windows::core::{w, IUnknown, Interface, BSTR};
    use windows::Win32::System::Com::*;
    use windows::Win32::System::Variant::VARIANT;
    use windows::Win32::System::Wmi::*;
    const DETACHED_PROCESS: i32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: i32 = 0x0000_0200;
    const RPC_C_AUTHN_WINNT: u32 = 10;
    const RPC_C_AUTHZ_NONE: u32 = 0;
    let err = |e: windows::core::Error| format!("WMI: {}", e.message());
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let _ = CoInitializeSecurity(None, -1, None, None, RPC_C_AUTHN_LEVEL_DEFAULT, RPC_C_IMP_LEVEL_IMPERSONATE, None, EOAC_NONE, None);
        let locator: IWbemLocator = CoCreateInstance(&WbemLocator, None, CLSCTX_INPROC_SERVER).map_err(err)?;
        let svc = locator.ConnectServer(&BSTR::from(r"ROOT\CIMV2"), &BSTR::new(), &BSTR::new(), &BSTR::new(), 0, &BSTR::new(), None).map_err(err)?;
        CoSetProxyBlanket(&svc, RPC_C_AUTHN_WINNT, RPC_C_AUTHZ_NONE, None, RPC_C_AUTHN_LEVEL_CALL, RPC_C_IMP_LEVEL_IMPERSONATE, None, EOAC_NONE).map_err(err)?;
        let mut class = None;
        svc.GetObject(&BSTR::from("Win32_Process"), WBEM_FLAG_RETURN_WBEM_COMPLETE, None, Some(&mut class), None).map_err(err)?;
        let mut signature = None;
        class.ok_or("WMI: no Win32_Process class")?.GetMethod(w!("Create"), 0, &mut signature, std::ptr::null_mut()).map_err(err)?;
        let params = signature.ok_or("WMI: no Create method")?.SpawnInstance(0).map_err(err)?;
        params.Put(w!("CommandLine"), 0, &VARIANT::from(BSTR::from(format!("\"{}\"", exe.display()))), 0).map_err(err)?;
        if let Some(dir) = exe.parent() {
            params.Put(w!("CurrentDirectory"), 0, &VARIANT::from(BSTR::from(dir.display().to_string())), 0).map_err(err)?;
        }
        let mut startup_class = None;
        svc.GetObject(&BSTR::from("Win32_ProcessStartup"), WBEM_FLAG_RETURN_WBEM_COMPLETE, None, Some(&mut startup_class), None).map_err(err)?;
        let startup = startup_class.ok_or("WMI: no Win32_ProcessStartup class")?.SpawnInstance(0).map_err(err)?;
        startup.Put(w!("CreateFlags"), 0, &VARIANT::from(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP), 0).map_err(err)?;
        let startup: IUnknown = startup.cast().map_err(err)?;
        params.Put(w!("ProcessStartupInformation"), 0, &VARIANT::from(startup), 0).map_err(err)?;
        let mut out = None;
        svc.ExecMethod(&BSTR::from("Win32_Process"), &BSTR::from("Create"), WBEM_GENERIC_FLAG_TYPE(0), None, &params, Some(&mut out), None).map_err(err)?;
        let out = out.ok_or("WMI: Create returned nothing")?;
        let mut code = VARIANT::default();
        out.Get(w!("ReturnValue"), 0, &mut code, None, None).map_err(err)?;
        let mut pid = VARIANT::default();
        out.Get(w!("ProcessId"), 0, &mut pid, None, None).map_err(err)?;
        match i32::try_from(&code).unwrap_or(-1) {
            0 => Ok(u32::try_from(&pid).unwrap_or(0)),
            n => Err(format!("WMI: Win32_Process.Create returned {n}")),
        }
    }
}

#[cfg(not(windows))]
pub fn spawn_outside(_exe: &Path) -> Result<u32, String> {
    Err("Only needed on Windows".into())
}
