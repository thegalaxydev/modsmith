# Third-party notices

| Component | License | Use |
| --- | --- | --- |
| Material Icon Theme (`material-icon-theme`, material-extensions/vscode-material-icon-theme) | MIT | File and folder icons; license copied to `dist/renderer/material-icons/LICENSE.material-icon-theme.txt` |
| Fabric example mod template (FabricMC/fabric-example-mod) | CC0-1.0 | Gradle wrapper scripts/JAR and template structure (`resources/templates`) |
| Gradle wrapper | Apache-2.0 | `gradle-wrapper.jar`, `gradlew`, `gradlew.bat` |
| React, CodeMirror, react-resizable-panels, ws, zod, fflate, json5, smol-toml, koffi | MIT | Application |
| vscode-json-languageservice, vscode-languageserver-textdocument (Microsoft) | MIT | JSON completion, hover and checks in the editor |
| JSON Schema Store schemas (SchemaStore/schemastore) | Apache-2.0 | Schemas for `fabric.mod.json`, mixin configs and Minecraft data and resource files, bundled in `src/renderer/jsonschemas/schemastore` and refreshed with `node scripts/fetch-schemas.mjs` |
| MCP TypeScript SDK (`@modelcontextprotocol/server`) | MIT | Reference MCP server used by the tests (not shipped) |
| Tauri, tauri-plugin-dialog, tauri-plugin-opener, tauri-plugin-single-instance, tungstenite, serde, windows-rs | MIT or Apache-2.0 | Desktop shell (`src-tauri`) |
| tokio, tokio-tungstenite, tungstenite, reqwest (native-tls), rusqlite, zip, flate2, zlib-rs, regex, chrono, humantime, sha1, sha2, base64, json5, toml, url, unicode-normalization, serde, windows-rs | MIT or Apache-2.0 (zlib-rs: Zlib) | Service, MCP server and CLI (`crates/service`) |
| x11rb, keyring (Secret Service backend), raw-window-handle | MIT or Apache-2.0 | Linux only: X11 window docking (`crates/x11win`) and keyring storage for the CurseForge key |
| SQLite (bundled by rusqlite) | Public domain | Service database |

Modsmith does not bundle Minecraft, Minecraft assets, or account credentials. Minecraft and libraries are downloaded by Fabric Loom and the Fabric installer from Mojang and Fabric sources. CurseForge access uses the user's own API key and respects each project's distribution setting.
