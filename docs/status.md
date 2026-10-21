# Implementation status

Status as of 2026-10-20. Platform used for verification: Windows 11 Pro 22631, JDK 25.0.1 (Oracle) for Gradle, Temurin 21.0.2 for the game, Node 22.18 for building and tests, the Rust service (`modsmith-service.exe`), Tauri 2.12 with WebView2 155.

## Verified on this machine

| Area | How it was verified |
| --- | --- |
| New project (Fabric 1.21.1) with all starters (item, block, command, config, datagen, bridge, profiles) and Git | Generated and built through the CLI; build succeeded on the first run (about 30 s) |
| Existing project opening without executing Gradle | Static detection; trust gate enforced (unit tests and UI) |
| Development client launch through Loom's launch configuration | Launched from CLI, UI and MCP; the game reached the title screen in about 10 s |
| Native docking of the client into the workbench panel | Tauri UI on Windows: game rendered inside the Minecraft tab through a host window, follows tab, panel and window moves and resizes, hidden behind overlays and other tabs, minimize and restore, clicking the game gives it keyboard focus, detach and close release it as a separate window, re-docking after restarting the workbench worked |
| Runtime bridge (authenticated loopback WebSocket) | Connected in every launch; registry search, world creation, give item, commands (including the generated mod's command), targeted-block inspection from the logical server, telemetry, screenshot, graceful shutdown |
| Modrinth search, dependency resolution, hash-verified downloads | Mod Menu added to a profile; its required dependency (Text Placeholder API) was resolved, Fabric API was recognized as provided by the dev classpath |
| End-to-end smoke test through MCP | `npm run smoke` passed all steps (create, build, add external mod, launch, bridge, registry query, world, give/inspect, logs, screenshot, clean stop, activity history) for Fabric (Mod Menu) and, with `SMOKE_ENTRY=neoforge-1.21.1`, for NeoForge (JEI with its jar-in-jar MezzConfig dependency) |
| NeoForge 1.21.1 (ModDevGradle) | Generated a project with every starter, built it, ran `runData` (language file generated), launched the dev client with the instance folder as game directory, bridge connected, registry/world/give/command/inspect/screenshot worked, graceful stop exited 0. NeoForge installer download, SHA-1 check and `--install-server` verified separately |
| Rust service (no Node in the app) | Every method served by `modsmith-service.exe`; `npm test` runs the contract suite in-process and against the binary, with parity tests comparing both on identical inputs; real Play in the release app: development client docked in the Minecraft tab and a release-build client (Cobblemon release profile, 91 mods) to the title screen, both stopped cleanly; MCP smoke test (`npm run smoke`, `npm run smoke:neoforge`) passed for Fabric (Mod Menu) and NeoForge (JEI with MezzConfig), including a check that a dedicated server refuses to start before the EULA is accepted; NeoForge in the release app on a fresh project: development client docked with bridge, inspector (create world, inspect target), stop and restart; release-build client installed through the official NeoForge installer (`--install-client`) and docked at the title screen; NeoForge `runData` and the early-window override worked. See [rust-service-port.md](rust-service-port.md) |
| Fabric project generation for 1.14.4 to 26.3 | The catalog has an entry for each of the 44 Fabric versions, generated from the official example mod. The Catalog builds workflow creates an empty project for every one through the Linux service, builds it with Gradle on JDK 25 and launches the development client under Xvfb: 44 of 44 reached the title screen (Java 8 for 1.14.4 to 1.16.5, 17, 21 and 25 for newer versions). On Windows, 1.14.4, 1.16.5, 1.17.1, 1.19 and 26.3 reached the title screen, and older versions also ran on newer Java when the ideal one was missing. Rust and TypeScript generate identical projects for each era (see [loader-matrix.md](loader-matrix.md)) |
| JSON editing help | Completion, hover and checks in the editor; the SchemaStore schemas that give warnings were checked against every matching file in vanilla 1.21.1 without a false warning (see [editor.md](editor.md)) |
| Linux | Kubuntu 26.04 (KDE Plasma, Wayland session through XWayland) on a laptop: the installed `.deb`, Fabric project build, docking, mouse look in a world. WSLg checks are listed in [linux.md](linux.md) |
| Unit and integration tests | `npm test`: 169 tests, run in-process and against the Rust service (manifest/schema, catalog and generation, identifier validation, resolver incl. duplicates, incompatibilities and CurseForge manual files, hash verification and atomic downloads, cancellation, process lifecycle, bridge authentication and message validation, API/MCP argument validation and dispatch, CurseForge mapping and pack import, DPAPI secrets, log/crash parsing, bisection) |

## Implemented but not verified end to end here

| Area | Why not verified |
| --- | --- |
| Development dedicated server and production server validation | Starting a server requires accepting the Minecraft EULA for that instance. Modsmith asks the user; it was not accepted on the user's behalf during testing |
| CurseForge search, resolution and downloads against the live API | Needs the user's own CurseForge API key. Mapping, manual-download handling and pack import/export are covered by tests with fixtures; an unauthenticated request was confirmed to return 403 |
| `.mrpack` import/export, CurseForge pack export | Code paths and schema validation implemented; export requires a resolved profile. Import of a CurseForge manifest is covered by a test |
| Scenarios, world snapshots, bisection, crash bundles | Implemented and partially unit-tested (bisection logic, crash parsing); not run against a live game in this session |
| Data generation run (`runDatagen`) | Generated projects configure it; the task was not executed in this session |
| Debugger attachment | JDWP agent arguments are generated; no debugger was attached |

## Not implemented

- Forge adapter (detection only), NeoGradle-based NeoForge projects, Quilt, Architectury multi-loader projects
- NeoForge modpack workspaces without source (needs a ModDevGradle harness; Fabric has one)
- Account sign-in for release-build clients (they launch offline as "Player", so online-mode servers refuse them)
- Loom's Microsoft account dev authentication as a launch mode (Loom 1.18 supports it; Modsmith launches with Loom's offline development account)
- Basic networking starter
- Asset model preview and model/translation reference validation (texture preview only)
- Multi-client scenarios
- In-app assistant and consuming external MCP servers
- Item, block, command, config and data generation starters for Fabric versions other than 1.21.1 (generated entries offer the empty mod and test profiles)
- Docking and input checks on Fabric versions other than 1.21.1, and release-build clients for older versions
- NeoForge and Forge versions other than 1.21.1
- macOS docking (detached window only); Linux docks on X11 and XWayland

## Known limitations

- The docked game lives in a separate host window over the Minecraft tab, so it can lag a frame behind while the workbench window is dragged. Fullscreen (F11) is not supported while docked; detach first. If the workbench is killed (rather than closed) while the game is docked, Windows destroys the game window and the game has to be restarted.
- World creation through the bridge waits until the client finishes its startup resource load; creating a world during that fade previously deadlocked the client.
- Logger names in the console are shown as printed by the game; they are not treated as reliable mod attribution.
- Compile dependencies added after project creation are recorded in the manifest but not written into `modsmith.dependencies.gradle` automatically.
- The bridge exists for Minecraft 1.21.1 only (Fabric and NeoForge). Both builds share `bridge/common`.
- NeoForge's early loading window (FML `earlyWindowControl`) is disabled for development clients by writing `earlyWindowControl = false` to the instance `config/fml.toml` (a profile-supplied `fml.toml` is kept). With it enabled, 1 of 4 launches failed with "An error occurred initializing shaders": a class-loading race in FML 4.0.45/securejarhandler 3.0.8 between the early-display thread and mod discovery (`FileSystemNotFoundException`), not a driver problem. FML then blocks on a modal dialog; Modsmith now detects that error and terminates the process instead of leaving it hung. After the change, 4 consecutive launches and a fresh MCP smoke run succeeded.

## Next milestone

1. Live verification of dedicated server and production server flows (after EULA acceptance), scenarios and snapshots.
2. Loom Microsoft authentication launch mode and production client validation.
3. Asset/model preview and reference validation.
4. NeoForge modpack harness and a Forge adapter.
