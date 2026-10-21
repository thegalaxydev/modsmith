# Architecture

## Stack decision

Tauri 2 (Rust) desktop shell + React + TypeScript renderer, with a separate Rust service process (`modsmith-service.exe`) that the shell ships next to itself.

- The application services (Gradle orchestration, downloads, process control, the bridge host, MCP and the CLI) are Rust (`crates/service`). Nothing in the installed app needs Node.
- The original TypeScript implementation (`src/core`, `src/service`, `src/mcp`, `src/cli`) stays in the repository as the reference: `npm test` runs every contract test against it in-process and against the Rust binary, and parity tests compare the two on identical inputs. It is not shipped. [rust-service-port.md](rust-service-port.md) records how the port was done.
- The shell is small Rust code: window, dialogs, opening paths and links, starting the service, and native docking of the game window through the `windows` crate.

## Processes

```
Tauri shell (window, dialogs, native docking, starts the service)
   │  commands + injected window.workbench shim      │ RPC client (instance lookups)
React renderer (WebView2) ── WebSocket RPC ──► modsmith-service.exe (Rust, loopback only)
modsmith-service cli … ────── WebSocket RPC ──►   ├─ transport, auth, discovery, validation, activity, events
modsmith-service mcp (stdio) ─ WebSocket RPC ──►   ├─ storage, workspaces, providers, profiles, packs, operations
                                                   ├─ projects, Gradle, Java, launches, instances, crash, snapshots, scenarios, bisect
                                                   ├─ Bridge host (WebSocket, loopback) ◄── companion mod in each game JVM
                                                   └─ child processes: Gradle, Minecraft JVMs, installers
```

- **Service** (`crates/service`, `modsmith-service.exe`): one per user. Binds `127.0.0.1` on a random port, writes `%APPDATA%\Modsmith\service.json` (port, per-start token, pid) and holds a lock file so only one runs. Every client authenticates with the token as its first message; browser origins other than the app are refused. Any client starts it on demand, so instances keep running when the window closes. It validates every call against `resources/api.json` (generated from the zod method table in `src/shared/api.ts`), dispatches it, and records activity with its source (`ui`, `cli`, `mcp`).
- **Desktop shell** (`src-tauri`): window, file dialogs, opening paths and links, starting the service, and the Windows docking controller. See [Desktop shell](#desktop-shell).
- **Renderer** (`src/renderer`): React UI. Talks to the service directly over WebSocket using the endpoint provided through `window.workbench`.
- **MCP server** (`modsmith-service mcp`, `crates/service/src/mcp.rs`): stdio MCP server. One tool per API method with `mcp: true`, generated from `resources/api.json`, plus resources and resource templates; it forwards calls to the service and starts the service if needed. Its tool list, results and error texts match the TypeScript SDK server it replaced (`test/mcp.test.ts`).
- **CLI** (`modsmith-service cli …`, `crates/service/src/cli.rs`): thin RPC client. `bin/modsmith.cjs` is a shim that runs it.

## Service modules (`crates/service/src`)

| Module | Responsibility |
| --- | --- |
| `server.rs`, `handlers.rs`, `api.rs`, `schema.rs`, `activity.rs` | WebSocket front, method table, zod-compatible validation, activity log |
| `workspace.rs`, `detect.rs`, `manifest.rs` | Open/inspect folders without executing them, trust state, scoped file IO, manifest and lock files |
| `projects.rs`, `scaffold.rs`, `png.rs` | Project creation (Fabric and NeoForge templates), builds, validation, diagnostics |
| `java.rs`, `gradle.rs`, `proc.rs` | Java discovery and selection, the project's own Gradle wrapper, process trees |
| `launch.rs`, `clientinstall.rs` | Development launch (Loom/ModDevGradle spec extraction), release client and server launches, EULA, datagen |
| `assets.rs` | Resource checks (models, textures, blockstates, names, IDs in data files) and model resolution for the editor preview |
| `regindex.rs` | Registry index for JSON completion: vanilla client jar, project resources, resolved mods and the dev classpath |
| `dap.rs` | Debug Adapter Protocol relay between the app and the Java debug adapter started by the language server (see [editor.md](editor.md#debugging)) |
| `modupdates.rs` | Mod update check, dry-run preview with a change list, apply with rollback points, rollback (see [manifest.md](manifest.md#locked-versions-and-updates)) |
| `perf.rs` | Benchmarks: repeatable runs on a fresh fixed-seed world, sampling over the bridge, saved results and comparisons (see [performance.md](performance.md)) |
| `sessions.rs` | Multiplayer test sessions: offline server setup, waiting for the server, client identities and joining, stopping a session (see [multiplayer.md](multiplayer.md)) |
| `hotswap.rs` | Java hot reload: class snapshots, class file comparison, JDWP class redefinition (see [hot-reload.md](hot-reload.md)) |
| `instances.rs`, `logs.rs`, `bridge.rs`, `win32.rs` | Game process lifecycle, structured logs, graceful/forced stop, crash detection, bridge host, game window lookup |
| `profiles.rs`, `resolver.rs`, `packlink.rs`, `packimport.rs`, `mrpack.rs`, `jarmeta.rs`, `versionrange.rs` | Profiles, provider-agnostic dependency resolution, linked and imported packs, instance sync |
| `providers.rs`, `http.rs`, `secrets.rs` | Modrinth, CurseForge and loader metadata, cached HTTP, verified downloads, DPAPI secrets |
| `crash.rs`, `snapshots.rs`, `scenarios.rs`, `bisect.rs` | Deeper tooling |
| `ops.rs`, `store.rs` | Long-running operations; SQLite (recents, trust, activity, operations, launches, HTTP cache, kv) |
| `mcp.rs`, `client.rs`, `cli.rs` | MCP server, RPC client with service auto-start, CLI |

The TypeScript modules in `src/core` have the same names and responsibilities.

## Development launch without modifying projects

Modsmith never edits an opened project's build scripts to launch it. It runs the project's wrapper with an init script (`resources/gradle/modsmith-init.gradle`) that registers `mwbLaunchSpec`. That task depends on everything `runClient`/`runServer` depends on (compilation, `configureClientLaunch` or `prepareClientRun`, asset download) and writes the run's main class, JVM arguments, program arguments and classpath to `.modsmith/launch/`. It supports Fabric Loom and NeoForge ModDevGradle; for ModDevGradle the VM/program argument files and `classpathProvider` are kept as-is. The service then starts the JVM itself with:

- a per-profile instance directory under `.modsmith/instances/` as the working directory,
- the profile's Java runtime, memory and JVM args, and the JDWP agent when hot reload is on (the compiled classes are then recorded for [hot reload](hot-reload.md)),
- bridge credentials in environment variables (not on the command line).

Owning the process gives exact PIDs for docking, stopping and crash detection. External runtime mods, including the bridge, are copied into the instance `mods/` folder; Fabric Loader remaps intermediary JARs to the development namespace at runtime.

## Desktop shell

`src-tauri` is a Tauri 2 app that loads `dist/renderer` and provides the `window.workbench` API the renderer expects (`src/renderer/bridge.d.ts`):

- `src-tauri/src/shim.js` is injected before the page loads. It defines `window.workbench` on top of Tauri commands (`src-tauri/src/main.rs`) and the `viewport:state` event.
- Confirmations and alerts go through `window.workbench.confirm` and `window.workbench.alert` (`src/renderer/dialogs.ts`), which show a native message box owned by the main window with No as the default button. The renderer never relies on `window.confirm`: in the Tauri webview it returns a Promise, which is always truthy.
- File dialogs use `tauri-plugin-dialog`, paths and links use `tauri-plugin-opener` (links only for `https://`), and a second launch focuses the existing window (`tauri-plugin-single-instance`).
- `app_endpoint` reads `<data dir>/service.json`, checks that the pid is alive and that the token is accepted, and otherwise starts `modsmith-service.exe` (next to `modsmith.exe`, or `MODSMITH_SERVICE_BIN`) detached and waits for it (`src-tauri/src/service.rs`). The service outlives the window, so the CLI and MCP server keep working against it. `mcp config` points MCP clients at the same `modsmith-service.exe` with the `mcp` argument.
- The service accepts WebSocket upgrades from the `http(s)://tauri.localhost` origin, and the renderer's CSP allows Tauri's IPC endpoint.

Bundle layout (installed into `%LOCALAPPDATA%\Modsmith` by the NSIS installer):

| Path | Content |
| --- | --- |
| `modsmith.exe` | Tauri shell |
| `modsmith-service.exe` | Service, MCP server (`mcp`) and CLI (`cli`) |
| `resources/` | Templates, catalog, Gradle init script, bridge JARs |

`npm run tauri:prepare` builds the renderer and the service (`scripts/build-service.mjs` copies the release binary to `src-tauri/binaries/` for `externalBin`).

## Workspace layout

The project window has three fixed parts around a docking area:

- The toolbar (`TopBar.tsx`) holds the project selector with its Minecraft version and loader, the run configuration selector, one launch control for the selected configuration and the process status next to it. The control reads Launch client or Start server, then Building, Starting, Stop or Stopping. Restart and Apply changes appear only while the configuration runs; build, export and layout actions are in the overflow menu.
- The rail (`Rail.tsx`) lists the views of the open project: Overview, Files (toggles the explorer), Client or Server (the run view of the selected configuration), Mods, Run configurations and Tests. MCP and Settings sit at the bottom, apart from the project views.
- The status bar shows running tasks, the bridge connection, problem counts and the panel toggles. It does not repeat the toolbar's process status.

The run view depends on the configuration. A client configuration shows the embedded game viewport with its embedding options. A dedicated server shows a server view (`ServerPane.tsx`): process state and uptime, address, world and settings read from the instance's `server.properties`, players taken from join and leave lines in the server log, the EULA state, the previous run's result, the latest output and a command line. Values that cannot be read are shown as unavailable rather than estimated.

The docking area is built with dockview (`src/renderer/dock.tsx`). Every view is a panel that can be dragged by its tab into another group, split to any side of a group, maximized, or floated: documents (Overview, the run view, Mods, Run configurations, Tests, Diagnostics and open files) and tools (Files, Console, Problems, Tasks, Test results, Activity, Inspect). Tools open in their usual area the first time (Files on the left, output panels below the documents, Inspect on the right) and afterwards wherever they were left. Documents always open in the main document group, or above the output panels when no document group is left. The layout is saved in the webview's local storage under `mwb.dock.v2`, file tabs are dropped when a project opens, and "Reset layout" rebuilds the default.

Colors, surfaces, radii, control heights and text sizes are tokens on `:root` in `styles.css`. Teal is reserved for the primary action, selection and focus; errors and warnings use their own colors, and console lines at those levels get a colored edge rather than colored text.

The renderer keeps `store.tabs` and `store.activeTab` in sync with the open documents, so code that opens files keeps calling `store.openTab`; tools are opened with `store.showTool`, `store.toggleTool` and `store.toggleOutput`. Closing a tab goes through `store.closeTab`, which asks before discarding unsaved changes.

Because the docked game is a separate window drawn above the webview, the layout hides it while a tab is being dragged (so drop targets stay visible) and re-measures the client view after every layout change, so the game follows its panel when it is moved, split or resized. A floating group placed over the docked game is drawn underneath it.

## Native viewport (Windows)

The shell finds the game's `GLFW30` window by PID, removes its frame, and makes it a borderless popup owned by a host window, positioned over the Minecraft tab and kept in sync with moves and resizes of the main window (`src-tauri/src/win32.rs`, `src-tauri/src/viewport.rs`). The client view checks its position and size every animation frame and keeps at most one update in flight, always sending the newest rectangle, so a stream of resizes (dragging the divider of a neighbouring panel) never queues up. The game window is moved with `SWP_ASYNCWINDOWPOS`, so the shell does not wait for Minecraft's thread to handle each move; measured while dragging a neighbouring divider with the client in a world, the game followed the panel with a median lag of 7 ms (21 ms at the 90th percentile), where blocking moves gave 23 ms (132 ms). The game stays a top-level window rather than a `WS_CHILD` because GLFW only captures the mouse when its window is the active window, which a child window can never be; as a child, Minecraft could not lock the cursor and the camera did not turn.

WebView2 composites web content with DirectComposition above child HWNDs, so a game window parented directly into the main window is invisible (verified: correct position and z-order, but covered by the web content). Instead the game is parented into a dedicated host window: an owned, borderless `WS_POPUP` (`ModsmithViewportHost`, tool window, no taskbar entry) placed in screen coordinates over the tab. Owned windows stay above their owner, follow it when it is minimized and restored, and are separate DWM surfaces, so the game shows above the web content. The host forwards focus to the game when activated; clicking the game makes the host the active window and gives the game keyboard focus.

The host is hidden while modals, menus or other overlays are open and when the Minecraft tab is not visible. The game window is restored to a normal top-level window when detached or when the game closes. Closing the workbench hides its window, stops every running game gracefully (the bridge saves and quits, as with Stop), then exits; the background service keeps running for MCP and CLI clients. If the shell is killed without closing (Task Manager), Windows destroys the game window with its owner and the game has to be restarted.

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
