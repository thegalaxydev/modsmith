# Implementation status

Status as of 2026-10-19. Platform used for verification: Windows 11 Pro 22631, JDK 25.0.1 (Oracle) for Gradle, Temurin 21.0.2 for the game, Node 22.18 for building, Node 24.22 bundled for the service, Tauri 2.12 with WebView2 155.

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
| Unit and integration tests | `npm test`: 62 tests (manifest/schema, catalog and generation, identifier validation, resolver incl. duplicates, incompatibilities and CurseForge manual files, hash verification and atomic downloads, cancellation, process lifecycle, bridge authentication and message validation, API/MCP argument validation and dispatch, CurseForge mapping and pack import, DPAPI secrets, log/crash parsing, bisection) |

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
- Production client validation (needs Loom production run tasks plus Microsoft authentication)
- Loom's Microsoft account dev authentication as a launch mode (Loom 1.18 supports it; Modsmith launches with Loom's offline development account)
- Basic networking starter
- Asset model preview and model/translation reference validation (texture preview only)
- Multi-client scenarios
- In-app assistant and consuming external MCP servers
- Catalog entry `fabric-26.3` (listed, generation disabled until verified)
- macOS/Linux native docking (detached window only; other platforms are untested)

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
4. Replace the Node service with Rust ([rust-service-port.md](rust-service-port.md)).
5. NeoForge modpack harness and a Forge adapter.
