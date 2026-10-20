# Porting the service to Rust

This is the plan for replacing the Node service (`src/service`, `src/core`, `src/mcp`, `src/cli`) with Rust, one module at a time, without changing what any client sees. It applies after the Tauri shell (`src-tauri`) has shipped with the Node service as a sidecar. Do the port only if the measurements below show the Node footprint still matters; the shell swap already removes most of Electron's weight.

## Progress

As of 2026-10-20 the port is complete: steps 0 to 7 are done and the installed app contains no Node runtime. Each step passed the full test suite against both the Node and the Rust implementation, the end-to-end MCP smoke test (create, build, Modrinth resolve, launch, bridge, world, screenshot, clean stop), and a Tauri release build. After step 7 a real Play was verified in the release app with an isolated data directory on the Starter Test project: the development Test Client ran docked in the Minecraft tab with the bridge connected and stopped cleanly through the bridge (exit 0), and the "Cobblemon release" profile built the release JAR, installed the release client from the cache, loaded 91 mods (Cobblemon 1.7.3, the built `startertest` JAR, the bridge) in production names, ran docked to the title screen and stopped with exit 0.

| Step | State | What runs in Rust |
| --- | --- | --- |
| 0 | Done | Front: WebSocket transport, auth, origin and path checks, `service.json`, lock file, legacy data migration, method table and parameter validation from `resources/api.json`, event fan-out, client counts |
| 1 | Done | SQLite access (rusqlite, same schema and migrations), activity recording with redaction for every call, `workspace.list`, `activity.list` |
| 2 | Done | `catalog.list`, `dependency.inspect_jar`, `workspace.inspect/tree/read_file/write_file/image/set_image/delete_file`, manifest and lock reading and writing, Gradle project detection |
| 3 | Done | HTTP client with the shared SQLite cache, Modrinth, CurseForge, DPAPI secrets, `meta.*`, `provider.*`, `dependency.search/versions`, `modpack.search`, `preset.*` |
| 4 | Done | Operation manager, `profile.*`, the resolver, linked packs, pack import into profiles, `modpack.import_*`, `modpack.export_*`, `dependency.add/remove/set_enabled/provide_file` |
| 5 | Done | `java.*`, `system.*`, `catalog.starters`, `workspace.open/init/trust`, `project.*` (Fabric and NeoForge project generation, Gradle builds and diagnostics, datagen), `instance.*` (development, release client and release server launches, EULA, process control, logs), the bridge host, `bridge.*`, `game.*`, `registry.search`, `world.*`, `viewport.*`, `crash.*`, `scenario.*`, `bisect.*`, `mcp.config`, `service.shutdown` |
| 6 | Done | MCP server (`modsmith-service mcp`) and CLI (`modsmith-service cli …`) in the same binary; `bin/modsmith.cjs` is a shim that runs the CLI |
| 7 | Done | The Node worker and the bundled `node.exe` are gone, along with `scripts/fetch-node.mjs`, `scripts/stage-tauri.mjs` and the `app/` folder. The bundle is `modsmith.exe`, `modsmith-service.exe` and `resources/` |

Changes from the original plan:

- The service is a Rust front with a Node worker behind it only until step 4. Step 5 moved every remaining method at once, so the worker had nothing left to do and was removed then rather than at step 7; step 7 removed the files and the packaging.
- Validation uses a small validator over the JSON Schema that zod exports, not the `jsonschema` crate. zod's error messages and its handling of defaults, unknown keys, unions and transforms are reproduced exactly; `test/validation.test.ts` compares both on thousands of generated inputs, including manifests, lock files, catalogs and scenario files. The export adds `x-message`, `x-transform` and missing defaults that zod's exporter drops (`scripts/export-api.mjs` writes `resources/api.json` and `resources/schemas.json`; a test fails if they are stale).
- HTTP uses reqwest with Windows SChannel (`native-tls`) instead of rustls, which avoids the CMake/NASM toolchain that aws-lc needs.
- Base URLs of external APIs can be overridden (`MODSMITH_MODRINTH_API`, `MODSMITH_CURSEFORGE_API`, `MODSMITH_FABRIC_META`, `MODSMITH_NEOFORGE_VERSIONS`) in both implementations, so parity tests run offline against `test/fakeapi.ts` and also compare the outgoing requests byte for byte.
- Processes are run and stopped as before (`taskkill /T /F` for trees), not through Job objects, so behavior matches `instances.ts` exactly. Child processes are started with `CREATE_NO_WINDOW`, which hides console windows only; the game window is unaffected.
- The MCP server is hand-written JSON-RPC over stdio instead of `rmcp`, so that its wire output matches the TypeScript SDK server byte for byte (`test/mcp.test.ts` sends the same probes to both: initialize and version negotiation, the 99-tool list, resources and templates, argument validation errors, tool errors, resource reads). The CLI is hand-written for the same reason; its output and exit codes match the Node CLI on the same commands.
- The TypeScript implementation stays in the repository as the reference for the dual-mode tests and is no longer shipped.

The parity tests that guard step 5 to 7 are `test/parity-projects.test.ts` (nine generated Fabric and NeoForge projects compared file by file, project validation, workspace init and trust, refusal paths for builds, launches, EULA, scenarios, snapshots and bisection, world snapshot and restore) and `test/mcp.test.ts`. `npm test` now runs 114 tests in-process, 147 against the Rust service (including the parity tests, which need both), and 38 Rust unit tests.

Footprint, same method as the shell comparison below (release build, welcome screen, 30 s idle, private bytes summed over the shell, WebView2 and the service):

| | Node service (before the port) | Rust front + Node worker (after step 4) | Rust service (after step 7) |
| --- | --- | --- | --- |
| Service processes, private memory | `node.exe` 66 MB | `modsmith-service.exe` 3 MB + worker `node.exe` 66 MB | `modsmith-service.exe` 3 to 4 MB |
| Whole app, private memory | 248 to 249 MB | 251 MB | 184 to 186 MB |
| Whole app, working set | 393 MB | | 346 to 348 MB |
| Installer (NSIS) | 25.2 MB | 27.0 MB | 4.0 MB |
| On disk | 99 MB | | 10.5 MB (`modsmith.exe` 4.6 MB, `modsmith-service.exe` 5.7 MB, resources 0.2 MB) |
| Launch, service already running | 355 to 424 ms | 349 to 425 ms | 369 to 470 ms |
| Launch, service started by the shell | 640 to 844 ms | 656 to 787 ms | 657 to 721 ms |

Launch time is unchanged within noise: it is dominated by WebView2 start-up and the first render, not by the service. The saving is memory (about 63 MB less idle private memory) and size (the installer is about a sixth, the installed app about a tenth). While a game runs the JVM still dominates.

Known differences that remain: messages for malformed JSON files (V8's `JSON.parse` wording versus serde's), messages for corrupt zip or TOML files, zip files written by `modpack.export_*` and `crash.bundle` (same entries and contents, different compression bytes), the PNG placeholder textures in generated projects (identical pixels, different zlib compression: Node bundles Chromium's zlib, and neither zlib-rs nor stock zlib produce the same deflate stream), and regular expressions in scenario `assert_log` steps (Rust `regex` syntax instead of JavaScript's).

## Why, and what it buys

Measured on the development machine (Windows 11 22631, WebView2 155), idle on the welcome screen, 30 s after start. See "Shell comparison" at the end for method and the Electron numbers.

| Process | Private memory | Working set |
| --- | --- | --- |
| Tauri shell (`modsmith.exe`) | 6 MB | 23 MB |
| WebView2 (6 processes) | 177 MB | 313 MB |
| Node service (`node.exe`) | 66 MB | 57 MB |
| Total | 249 MB | 393 MB |

Install size: 99 MB on disk, of which `node.exe` is 90 MB, `modsmith.exe` 4.4 MB and the staged service files 4.7 MB. The NSIS installer is 25.2 MB.

The Node runtime is about 90 MB of the 99 MB installed size and 66 MB of the 249 MB idle memory. A Rust service would plausibly idle at 10 to 20 MB and add 5 to 10 MB to the installer. While a game runs, the JVM (1 to 4 GB) dominates every other number, so the port mainly pays off for install size, idle memory with no game running, and having a single toolchain.

## The contract that must not change

Everything outside the service talks to it through one surface. That surface is the contract, and the port is done when a Rust binary satisfies it.

1. **Discovery.** `<data dir>/service.json` holds `{ pid, port, token, version, startedAt }`, written atomically (temporary file, then rename) after the socket listens. `<data dir>/service.json.lock` holds the owner pid so only one service runs. The data dir is `MODSMITH_DATA_DIR` or `%APPDATA%\Modsmith`; the cache dir is `MODSMITH_CACHE_DIR` or `%LOCALAPPDATA%\Modsmith\cache`. On first start without overrides, the service migrates the legacy `ModWorkbench` folders (`src/core/legacy.ts`).
2. **Transport.** WebSocket at `ws://127.0.0.1:<port>/rpc`. The upgrade is refused for any other path and for browser origins other than `file://`, `null`, `http://localhost:*`, `http://127.0.0.1:*` `http(s)://tauri.localhost` (Windows) and `tauri://localhost` (Linux and macOS). Maximum message size is 64 MB.
3. **Session.** The first message must be `{ type: "auth", token, client: "ui" | "mcp" | "cli", events: bool, protocol: 1 }` within 5 s. The token is compared in constant time. On failure the socket closes with code 4004 (4001 on timeout, 4002 on invalid JSON). On success the service sends `{ type: "ready", server: { product, version, pid } }` and emits `clients.changed`.
4. **Calls.** `{ type: "call", id, method, params }` gets `{ type: "result", id, ok: true, result }` or `{ type: "result", id, ok: false, error }`. Error strings are part of the contract: the UI and tests match on them (`/not trusted/`, `/outside the workspace/`, `/destructive/`, `/Invalid parameters for/`, `/Unknown method/`).
5. **Methods.** The 104 methods in `src/shared/api.ts` with their zod parameter schemas, defaults (`project.create` relies on them), and flags: `mcp`, `mutating`, `longRunning`, `destructive` (requires `confirm: true`), `untrustedOutput`. Every call is recorded in the activity log with its source.
6. **Events.** Sent only to clients that authenticated with `events: true`, as `{ type: "event", event, data }`: `activity.added`, `bridge.connected`, `bridge.disconnected`, `bridge.event`, `clients.changed`, `diagnostics.updated`, `instance.log`, `instance.updated`, `operation.log`, `operation.updated`, `workspace.changed`, `workspace.file_changed`. Payload shapes are the TypeScript types in `src/shared/types.ts`.
7. **Files on disk.** `workbench.sqlite` (schema and `schema_version` in `src/core/db.ts`), `secrets.json` (DPAPI blobs), and everything written into projects: `modsmith.json`, `modsmith.lock.json`, `.modsmith/**`, generated projects and Gradle init scripts. A Rust service must read what the Node service wrote and write byte-compatible output, because users commit these files.
8. **Bridge.** The loopback WebSocket the companion mod connects to (`docs/bridge-protocol.md`), with credentials passed through `MODSMITH_BRIDGE_*` environment variables.
9. **MCP launch info.** `mcp.config` returns the command that starts the MCP server. Today that is the sidecar `node.exe` plus `app/dist/mcp/main.cjs`; after the port it becomes `modsmith-service.exe mcp`.

## Strategy: a Rust front with a Node worker behind it

Do not run two services side by side. Replace the outer layer first and move handlers across one group at a time.

```
UI / CLI / MCP ──WebSocket──► modsmith-service (Rust)
                                ├─ transport, auth, service.json, lock, events
                                ├─ validation, activity log, dispatch
                                ├─ ported handlers (Rust)
                                └─ legacy worker: node.exe dist/worker/main.cjs
                                     stdio JSON lines: { id, method, params, source } → { id, ok, result | error }
                                     and { event, data } upward
```

- The front owns the socket and the method table. A method is either native or forwarded. The forwarded set shrinks with each step until the worker can be deleted along with the Node sidecar.
- The worker is today's `Workbench` without the WebSocket server: a new entry `src/worker/main.ts` that reads JSON lines on stdin, calls `wb.call(method, params, source)`, writes results, and forwards `wb.s.bus` events. That is about 60 lines of TypeScript and keeps all existing behavior.
- **State ownership moves in groups.** Some methods share in-memory state (the operation manager, running instances, the bridge host, the SQLite connection). A group moves only when all of its methods move, so no state is split between runtimes. The order below follows those boundaries.
- Validation: generate JSON Schema from the zod table at build time (`z.toJSONSchema`, zod 4) into `resources/api.json`. The front embeds it (`include_str!`), validates with `jsonschema`, and applies `default` values itself, because JSON Schema validators do not fill defaults. The same file drives the MCP tool list, so the method table stays defined in one place until the TypeScript side is gone.

## Module order

Each step ends with all tests green, the smoke test passing, and a release build. Rough sizes are TypeScript lines today.

| Step | Moves to Rust | Methods | Notes |
| --- | --- | --- | --- |
| 0 | Front: transport, auth, discovery, lock, legacy migration, dispatch, validation, activity recording, event fan-out, worker supervision | `service.shutdown`, `system.info`, `system.capabilities` | Ship this alone. It already proves the protocol, discovery and the shell integration. `src/service/main.ts`, `legacy.ts`, `paths.ts`, `events.ts` (about 350 lines) |
| 1 | Storage | `workspace.list`, `activity.list`, trust and recents writes | `db.ts` with rusqlite (bundled SQLite). The worker keeps its own connection for the tables it still owns; SQLite WAL makes two connections to one file safe. |
| 2 | Pure readers | `catalog.*`, `java.*`, `dependency.inspect_jar`, `workspace.inspect`, `workspace.tree`, `workspace.read_file`, `workspace.write_file`, `workspace.delete_file`, `workspace.image`, `workspace.set_image` | `catalog.ts`, `java.ts`, `jarmeta.ts` (zip, json5, toml), `png.ts`, `versionrange.ts`, `redact.ts`, scoped file IO from `workspace.ts`. No shared state, easy to test against fixtures. |
| 3 | Network and secrets | `meta.*`, `provider.*`, `dependency.search`, `dependency.versions`, `modpack.search`, `preset.check` | `http.ts` (cache in SQLite, verified atomic downloads, retries, cancellation), `modrinth.ts`, `curseforge.ts`, `secrets.ts` (DPAPI through the `windows` crate, same blob format so existing `secrets.json` keeps decrypting). |
| 4 | Operations, profiles and packs | `operation.*`, `profile.*`, `dependency.add/remove/set_enabled/provide_file`, `modpack.*`, `preset.list/save` | `operations.ts`, `profiles.ts`, `resolver.ts`, `manifest.ts`, `mrpack.ts`, `packimport.ts`, `packlink.ts` (reads other launchers' SQLite files), `presets.ts`. The operation manager is shared state, so it moves with every long-running method that is not in step 5; until then the worker keeps a second operation manager and the front merges `operation.list`. |
| 5 | Builds, launches and the running game | `project.*`, `instance.*`, `logs.read`, `crash.*`, `bridge.*`, `game.*`, `registry.search`, `world.*`, `viewport.*`, `scenario.*`, `bisect.*`, `workspace.open`, `workspace.init`, `workspace.trust` | `projects.ts`, `adapters/*`, `gradle.ts`, `launch.ts`, `clientinstall.ts`, `instances.ts`, `proc.ts`, `logs.ts`, `bridge.ts`, `crash.ts`, `snapshots.ts`, `scenarios.ts`, `bisect.ts`. The largest and most stateful group (about 3,500 lines); it moves as one unit. Process trees use Job objects. |
| 6 | MCP server and CLI | all MCP tools | `rmcp` stdio server inside the same binary (`modsmith-service mcp`), tools generated from `resources/api.json`, forwarding over the WebSocket like today. CLI with `clap` (`modsmith-service cli …`); keep `bin/modsmith.cjs` as a shim that runs it. |
| 7 | Delete the worker and the Node sidecar | none | Remove `externalBin` `binaries/node`, `scripts/fetch-node.mjs`, `scripts/stage-tauri.mjs` and the `app/` resources from the bundle. Move the service into the Tauri process or keep it as a separate binary; keep it separate, because the service must outlive the window and serve the CLI and MCP. |

Steps 1 to 4 can be reordered if a module turns out easier; step 0 must come first and step 5 must move as one unit.

## Crates

| Need | Crate |
| --- | --- |
| Async runtime, processes, timers, cancellation | `tokio` (with `process`, `fs`, `signal`), `tokio-util` (`CancellationToken`) |
| RPC socket and bridge host | `tokio-tungstenite` with `axum` or `hyper` for the upgrade and origin check |
| JSON and validation | `serde`, `serde_json`, `jsonschema`; `json5` and `toml` for mod metadata |
| SQLite | `rusqlite` with `bundled` |
| HTTP and downloads | `reqwest` (`rustls-tls`, `stream`, `gzip`), `sha1`, `sha2`, `tempfile` for atomic writes |
| Archives | `zip` (jar metadata, nested jars, mrpack and CurseForge zips, crash bundles) |
| MCP | `rmcp` (official Rust SDK) with the stdio transport |
| Windows | `windows` (DPAPI `CryptProtectData`, Job objects, window lookup for `viewport.window`) |
| Files | `walkdir`, `notify` (for `workspace.file_changed`), `dirs` |
| Misc | `uuid`, `time`, `tracing` and `tracing-appender` (service.log), `clap` |

## Keeping the existing tests as the contract

The tests construct `new Workbench()` and call `wb.call(method, params, source)` in-process (`test/api.test.ts`, `test/packimport.test.ts`, `test/packlink.test.ts`). Turn that into the contract suite:

1. Add a `ServiceUnderTest` helper in `test/helpers.ts` with `call(method, params, source)`, `events()` and `stop()`. By default it wraps an in-process `Workbench`. With `MODSMITH_TEST_SERVICE=<path to binary>` it starts that binary with a temporary `MODSMITH_DATA_DIR`, reads `service.json`, and talks to it over the WebSocket with `RpcClient` (one connection per source, since the source comes from the auth message).
2. Replace the few places where tests reach into internals (`wb.s.store.listActivity(...)`) with the public methods (`activity.list`). After that, every test that goes through `call` runs unchanged against Node and against Rust.
3. Tests that import internal modules directly (`curseforge.ts` helpers, `SecretStore`, `jarmeta.ts`, `versionrange.ts`, `resolver.ts`) are unit tests. When a module is ported, port its fixtures with it as `cargo test` cases, and keep the TypeScript version until the module is deleted.
4. Add a protocol test that exercises the contract points the API tests do not: wrong token (close code 4004), auth timeout (4001), refused origins, `events: false` clients receiving no events, `service.json` rewritten on restart, a second instance exiting when the lock is held.
5. Add a golden-file test for project generation and lock files: generate a project and resolve a profile from fixed inputs under both services, then diff the trees byte for byte.
6. CI runs `npm test` twice, once in-process and once with `MODSMITH_TEST_SERVICE` pointing at the Rust build, plus `npm run smoke` against the Rust build.

## Risks

- **Behavior drift in generated files.** Project templates, `modsmith.json` and lock formatting, and Gradle init script handling are where users notice differences, because those files end up in git. The golden-file test is the guard.
- **Validation semantics.** zod coerces, strips unknown keys and fills defaults; `jsonschema` only validates. Apply defaults and strip unknown keys in the front, and keep the zod error wording in `Invalid parameters for <method>` messages.
- **Error strings.** The UI and tests match on message text. Keep a list of matched messages in the contract test.
- **Process control on Windows.** Graceful stop (bridge, then console, then window close), forced kill of whole process trees, and crash detection have to match `instances.ts`. Use Job objects so Gradle daemons and JVM children are cleaned up.
- **Mixed-mode period.** Two runtimes and two SQLite connections. Keep state groups intact, use WAL, and keep the worker's stdio protocol trivial.
- **MCP parity.** Tool names, descriptions, annotations (destructive, read-only) and untrusted-output wrapping must match what clients already have configured. Generate them from the same JSON file.
- **DPAPI compatibility.** Existing `secrets.json` entries must decrypt. Use the same entropy and scope as `secrets.ts`.
- **The payoff is modest while a game runs.** Measure again after step 0 and step 5; stop early if the remaining Node footprint does not matter in practice.

## Shell comparison

Measured 2026-10-19 on Windows 11 Pro 22631 (WebView2 155.0.4283.62, Electron 44.9.0, both with Node 24.22.0 for the service), release Tauri build against `npm start`-equivalent Electron, each with its own isolated data directory and browser profile. Launch time is from process start until the welcome screen shows with the service connected (polled through the DevTools protocol every 50 ms); four runs each, files already in the OS cache, so these are warm-disk launches. Memory is sampled 30 s after the welcome screen appears: private bytes and working set summed over the shell, its browser processes and the service. Working sets double-count shared pages, so private bytes is the fairer comparison. No game was running.

| | Tauri + Node sidecar | Electron 44 |
| --- | --- | --- |
| Installer | 25.2 MB (NSIS, measured) | about 108 MB (estimated: the same files compressed with LZMA, which gives 24.8 MB for the Tauri payload against its real 25.2 MB installer; the repository has no Electron packaging) |
| On disk | 99 MB | 376 MB (Electron runtime plus the same app files) |
| Launch, service already running | 355 to 424 ms | 252 to 284 ms |
| Launch, service started by the shell | 640 to 844 ms | 515 to 594 ms |
| Idle private memory | 249 MB (shell 6, WebView2 177, service 66) | 239 to 248 MB (main 38, helpers 138 to 147, service 63 to 64) |
| Idle working set | 393 MB in 8 processes | 533 to 552 MB in 5 processes |

The WebView2 runtime itself (about 600 MB, shared with Edge and other apps) is part of Windows 11 and not counted. The shell swap cuts install size by about 4x and leaves idle memory about where it was; WebView2 costs about what Chromium in Electron costs, and the service is the same either way. Electron reaches the first connected frame about 100 to 150 ms sooner, mostly WebView2 environment start-up. Replacing the service would remove 66 MB of idle private memory and 90 MB of disk.
