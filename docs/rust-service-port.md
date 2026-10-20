# Porting the service to Rust

This is the plan for replacing the Node service (`src/service`, `src/core`, `src/mcp`, `src/cli`) with Rust, one module at a time, without changing what any client sees. It applies after the Tauri shell (`src-tauri`) has shipped with the Node service as a sidecar. Do the port only if the measurements below show the Node footprint still matters; the shell swap already removes most of Electron's weight.

## Progress

As of 2026-10-20 steps 0 to 4 are done. Each step passed the full test suite against both the Node and the Rust implementation, the end-to-end MCP smoke test (create, build, Modrinth resolve, launch, bridge, world, screenshot, clean stop), and a Tauri release build.

| Step | State | What runs in Rust |
| --- | --- | --- |
| 0 | Done | Front: WebSocket transport, auth, origin and path checks, `service.json`, lock file, legacy data migration, method table and parameter validation from `resources/api.json`, event fan-out, client counts, Node worker supervision and shutdown |
| 1 | Done | SQLite access (rusqlite, same schema and migrations), activity recording with redaction for every call, `workspace.list`, `activity.list` |
| 2 | Done | `catalog.list`, `dependency.inspect_jar`, `workspace.inspect/tree/read_file/write_file/image/set_image/delete_file`, manifest and lock reading and writing, Gradle project detection |
| 3 | Done | HTTP client with the shared SQLite cache, Modrinth, CurseForge, DPAPI secrets, `meta.*`, `provider.*`, `dependency.search/versions`, `modpack.search`, `preset.*` |
| 4 | Done | Operation manager (the front merges `operation.list` with the worker's and routes `operation.*` by id), `profile.*`, the resolver, linked packs, pack import into profiles, `modpack.import_*`, `modpack.export_*`, `dependency.add/remove/set_enabled/provide_file` |
| 5 | Not started | Builds, launches, the running game, `java.*`, `system.*` |

Changes from the original plan:

- `java.*` and `system.*` stay in the worker until step 5. `JavaService` keeps an in-memory list that builds and launches read, and `system.info` reports the bridge port, which belongs to the worker.
- Validation uses a small validator over the JSON Schema that zod exports, not the `jsonschema` crate. zod's error messages and its handling of defaults, unknown keys, unions and transforms are reproduced exactly; `test/validation.test.ts` compares both on thousands of generated inputs, including manifests, lock files and catalogs. The export adds `x-message`, `x-transform` and missing defaults that zod's exporter drops (`scripts/export-api.mjs` writes `resources/api.json` and `resources/schemas.json`; a test fails if they are stale).
- The worker records nothing; the front records activity for every call, including forwarded ones, so there is one activity log.
- HTTP uses reqwest with Windows SChannel (`native-tls`) instead of rustls, which avoids the CMake/NASM toolchain that aws-lc needs.
- Base URLs of external APIs can be overridden (`MODSMITH_MODRINTH_API`, `MODSMITH_CURSEFORGE_API`, `MODSMITH_FABRIC_META`, `MODSMITH_NEOFORGE_VERSIONS`) in both implementations, so parity tests run offline against `test/fakeapi.ts` and also compare the outgoing requests byte for byte.

Footprint after step 4 (release build, same method as the shell comparison below, welcome screen, 30 s idle):

| | Node service (before the port) | Rust front + Node worker (after step 4) |
| --- | --- | --- |
| Service processes, private memory | `node.exe` 66 MB | `modsmith-service.exe` 3 MB + worker `node.exe` 66 MB |
| Whole app, private memory | 248 to 249 MB | 251 MB |
| Installer | 25.2 MB | 27.0 MB |
| Launch, service already running | 355 to 424 ms | 349 to 425 ms |
| Launch, service started by the shell | 640 to 844 ms | 656 to 787 ms |

There is no saving yet: the worker still loads the whole TypeScript `Workbench`, because step 5's handlers live there. The saving arrives when the worker and the Node runtime are removed (steps 5 to 7): about 66 MB of idle memory and about 90 MB on disk, and the installer should shrink to roughly a quarter of its size.

Known differences that remain: messages for malformed JSON files (V8's `JSON.parse` wording versus serde's), messages for corrupt zip or TOML files, and zip files written by `modpack.export_*` (same entries and contents, different compression bytes).

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
2. **Transport.** WebSocket at `ws://127.0.0.1:<port>/rpc`. The upgrade is refused for any other path and for browser origins other than `file://`, `null`, `http://localhost:*`, `http://127.0.0.1:*` and `http(s)://tauri.localhost`. Maximum message size is 64 MB.
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
