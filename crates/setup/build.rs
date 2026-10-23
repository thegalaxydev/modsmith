use std::env;
use std::fs;
use std::path::PathBuf;

const MANIFEST: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="asInvoker" uiAccess="false"/>
      </requestedPrivileges>
    </security>
  </trustInfo>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application>
      <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/>
    </application>
  </compatibility>
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"/>
    </dependentAssembly>
  </dependency>
</assembly>
"#;

fn main() {
    static_vcruntime::metabuild();
    println!("cargo:rerun-if-env-changed=MODSMITH_SETUP_PAYLOAD");
    println!("cargo:rerun-if-env-changed=MODSMITH_SETUP_VERSION");
    let out = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    let payload = out.join("payload.zip");
    match env::var("MODSMITH_SETUP_PAYLOAD") {
        Ok(p) if !p.is_empty() => {
            println!("cargo:rerun-if-changed={p}");
            fs::copy(&p, &payload).unwrap_or_else(|e| panic!("cannot read the setup payload {p}: {e}"));
        }
        _ => fs::write(&payload, b"").expect("write empty payload"),
    }
    let version = env::var("MODSMITH_SETUP_VERSION").unwrap_or_default();
    println!("cargo:rustc-env=MODSMITH_SETUP_VERSION={version}");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        #[cfg(windows)]
        {
            let shown = if version.is_empty() { "0.0.0" } else { version.as_str() };
            let mut res = tauri_winres::WindowsResource::new();
            res.set_icon("../../resources/brand/modsmith.ico")
                .set("ProductName", "Modsmith")
                .set("FileDescription", "Modsmith Setup")
                .set("CompanyName", "Galaxy Development LLC")
                .set("LegalCopyright", "Galaxy Development LLC")
                .set("ProductVersion", shown)
                .set("FileVersion", shown)
                .set("OriginalFilename", "modsmith-setup.exe")
                .set_manifest(MANIFEST);
            res.compile().expect("compile Windows resources");
        }
    }
}
