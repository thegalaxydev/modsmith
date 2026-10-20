# Architecture

## Stack decision

Tauri 2 (Rust) desktop shell + React + TypeScript, with a separate Node service process that the shell ships as a sidecar.

- The application services (Gradle orchestration, downloads, process control, MCP) are TypeScript and run in Node 24, which provides `node:sqlite`, so persistence needs no native modules. The shell bundles a Node 24 runtime (`node.exe`) for them; [rust-service-port.md](rust-service-port.md) is the plan for replacing that service with Rust behind the same API.
- The shell is small Rust code: window, dialogs, opening paths and links, starting the service, and native docking of the game window through the `windows` crate.

## Processes

```
Tauri shell (window, dialogs, native docking, starts the service)
   │  commands + injected window.workbench shim      │ RPC client (instance lookups)
React renderer (WebView2) ── WebSocket RPC ──► modsmith-service.exe (Rust, loopback only)
CLI ───────────────────────── WebSocket RPC ──►   ├─ transport, auth, discovery, validation, activity, events
MCP stdio server ──────────── WebSocket RPC ──►   ├─ ported handlers (storage, workspace files, providers, profiles, packs)
                                                   └─ Node worker (node.exe dist/worker/main.cjs, stdio JSON lines)
                                                        ├─ remaining Workbench handlers (builds, launches, game, java)
                                                        ├─ Bridge host (WebSocket, loopback) ◄── companion mod in each game JVM
                                                        └─ child processes: Gradle, Minecraft JVMs
```

- **Service** (`crates/service`, `modsmith-service.exe`): one per user. Binds `127.0.0.1` on a random port, writes `%APPDATA%\Modsmith\service.json` (port, per-start token, pid) and holds a lock file so only one runs. Every client authenticates with the token as its first message; browser origins other than the app are refused. Any client starts it on demand, so instances keep running when the window closes. It validates every call against `resources/api.json` (generated from `src/shared/api.ts`), records activity, and either handles the call itself or forwards it to the Node worker; [rust-service-port.md](rust-service-port.md) tracks which methods have moved. `src/service/main.ts` (the original all-Node service) still builds and is used by the tests and as a fallback when the Rust binary is missing.
- **Desktop shell** (`src-tauri`): window, file dialogs, opening paths and links, starting the service, and the Windows docking controller. See [Desktop shell](#desktop-shell).
- **Renderer** (`src/renderer`): React UI. Talks to the service directly over WebSocket using the endpoint provided through `window.workbench`.
- **MCP server** (`src/mcp/main.ts`): stdio MCP server built with the official TypeScript SDK v2 (`@modelcontextprotocol/server`). It registers one tool per API method and forwards calls to the service.
- **CLI** (`src/cli/main.ts`): thin RPC client.

UI, CLI and MCP all call the same method table (`src/shared/api.ts`, zod schemas) handled by `Workbench.call` (`src/core/workbench.ts`), which validates arguments, dispatches, and records activity with its source (`ui`, `cli`, `mcp`).

## Application services (`src/core`)

| Module | Responsibility |
| --- | --- |
| `workspace.ts` | Open/inspect folders without executing them, trust state, scoped file IO |
| `projects.ts` | Project creation, builds, validation, diagnostics |
| `adapters/` | Loader adapters (`LoaderAdapter` interface). Fabric and NeoForge (ModDevGradle) are implemented; Forge reports planned capabilities |
| `catalog.ts` | Versioned compatibility catalog (`resources/catalog/compatibility.json`) |
| `java.ts` | Java discovery and toolchain selection |
| `gradle.ts` | Runs the project's own wrapper JAR with a chosen JDK; parses diagnostics |
| `launch.ts` | Development launch (Loom spec extraction), production server validation, EULA, datagen |
| `instances.ts` | Process lifecycle, logs, graceful/forced stop, crash detection, history |
| `profiles.ts` / `resolver.ts` | Profile CRUD, provider-agnostic dependency resolution, lock files, instance sync |
| `modrinth.ts` / `curseforge.ts` | Provider clients |
| `http.ts` | Cached metadata, verified atomic downloads with retries and cancellation |
| `bridge.ts` | Authenticated bridge host |
| `crash.ts`, `snapshots.ts`, `scenarios.ts`, `bisect.ts`, `mrpack.ts`, `presets.ts` | Deeper tooling |
| `secrets.ts` | DPAPI-backed secret storage |
| `operations.ts` | Long-running operations with progress, logs, cancellation and results |
| `db.ts` | SQLite: recents, trust, activity, operations, launches, HTTP cache |

## Development launch without modifying projects

Modsmith never edits an opened project's build scripts to launch it. It runs the project's wrapper with an init script (`resources/gradle/modsmith-init.gradle`) that registers `mwbLaunchSpec`. That task depends on everything `runClient`/`runServer` depends on (compilation, `configureClientLaunch` or `prepareClientRun`, asset download) and writes the run's main class, JVM arguments, program arguments and classpath to `.modsmith/launch/`. It supports Fabric Loom and NeoForge ModDevGradle; for ModDevGradle the VM/program argument files and `classpathProvider` are kept as-is. The service then starts the JVM itself with:

- a per-profile instance directory under `.modsmith/instances/` as the working directory,
- the profile's Java runtime, memory and JVM args, optional JDWP agent,
- bridge credentials in environment variables (not on the command line).

Owning the process gives exact PIDs for docking, stopping and crash detection. External runtime mods, including the bridge, are copied into the instance `mods/` folder; Fabric Loader remaps intermediary JARs to the development namespace at runtime.

## Desktop shell

`src-tauri` is a Tauri 2 app that loads `dist/renderer` and provides the `window.workbench` API the renderer expects (`src/renderer/bridge.d.ts`):

- `src-tauri/src/shim.js` is injected before the page loads. It defines `window.workbench` on top of Tauri commands (`src-tauri/src/main.rs`) and the `viewport:state` event.
- Dialogs use `tauri-plugin-dialog`, paths and links use `tauri-plugin-opener` (links only for `https://`), and a second launch focuses the existing window (`tauri-plugin-single-instance`).
- `app_endpoint` reads `<data dir>/service.json`, checks that the pid is alive and that the token is accepted, and otherwise starts `node.exe app/dist/service/main.cjs` detached and waits for it (`src-tauri/src/service.rs`). The service outlives the window, so the CLI and MCP server keep working against it. Because the service's MCP launch info points at the same `node.exe`, `mcp config` produces a configuration that works without a system Node.
- The service accepts WebSocket upgrades from the `http(s)://tauri.localhost` origin, and the renderer's CSP allows Tauri's IPC endpoint.

Bundle layout (installed into `%LOCALAPPDATA%\Modsmith` by the NSIS installer):

| Path | Content |
| --- | --- |
| `modsmith.exe` | Tauri shell |
| `node.exe` | Node 24 runtime (`scripts/fetch-node.mjs`, verified against nodejs.org `SHASUMS256.txt`) |
| `app/dist/{service,mcp,cli}/main.cjs` | Bundled service, MCP server and CLI |
| `app/resources/` | Templates, catalog, Gradle init script, bridge JARs |
| `app/node_modules/koffi`, `app/node_modules/@koromix/koffi-win32-x64` | FFI used by the service (DPAPI, window lookup) |

`scripts/stage-tauri.mjs` assembles `app/` in `dist/sidecar/`.

## Native viewport (Windows)

The shell finds the game's `GLFW30` window by PID, removes its frame, and reparents it as a `WS_CHILD`, positioned over the Minecraft tab and kept in sync with the tab's `ResizeObserver` and with moves and resizes of the main window (`src-tauri/src/win32.rs`, `src-tauri/src/viewport.rs`).

WebView2 composites web content with DirectComposition above child HWNDs, so a game window parented directly into the main window is invisible (verified: correct position and z-order, but covered by the web content). Instead the game is parented into a dedicated host window: an owned, borderless `WS_POPUP` (`ModsmithViewportHost`, tool window, no taskbar entry) placed in screen coordinates over the tab. Owned windows stay above their owner, follow it when it is minimized and restored, and are separate DWM surfaces, so the game shows above the web content. The host forwards focus to the game when activated; clicking the game makes the host the active window and gives the game keyboard focus.

The host is hidden while modals, menus or other overlays are open and when the Minecraft tab is not visible. The game window is restored to a normal top-level window when detached, when the workbench closes, or when the game closes. If the shell is killed without closing (Task Manager), Windows destroys the game window with its owner and the game has to be restarted.

## Storage layout

| What | Where |
| --- | --- |
| User-authored project config | `modsmith.json`, `scenarios/*.json`, profile config folders (commit these) |
| Reproducible resolution | `modsmith.lock.json` (commit) |
| Generated launch/build files | `.modsmith/launch`, `.modsmith/harness`, `.modsmith/diagnostics.json` |
| Instance state | `.modsmith/instances/<profile>-<side>` (worlds, logs, config) |
| Test results and snapshots | `.modsmith/results`, `.modsmith/snapshots`, `.modsmith/crash-bundles` |
| Shared immutable download cache | `%LOCALAPPDATA%\Modsmith\cache\downloads` (by hash) |
| Application history | `%APPDATA%\Modsmith\workbench.sqlite` |
| Secrets | `%APPDATA%\Modsmith\secrets.json`, encrypted with Windows DPAPI (current user) |
