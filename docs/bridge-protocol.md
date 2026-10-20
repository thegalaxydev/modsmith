# Bridge protocol (version 1)

The bridge is a development-only companion mod (mod id `modsmith_bridge`) built for Fabric (`bridge/fabric-1.21.1`) and NeoForge (`bridge/neoforge-1.21.1`). Protocol, handlers and connection code live in `bridge/common` and are compiled into both; each loader project only adds its entrypoint and hooks (Fabric: mixins on `MinecraftServer` and `Minecraft.tick`; NeoForge: `ServerStartedEvent`, `ServerStoppedEvent`, `ServerTickEvent.Post`, `ClientTickEvent.Pre`). It is placed in development and test instances only, never in the project's built JAR. It is inert unless the game was launched by Modsmith.

It is independent of MCP: the service talks to the bridge, and MCP tools call service methods.

## Transport and authentication

- The service listens on `ws://127.0.0.1:<random>/bridge`. Requests with an `Origin` header are refused.
- Each launch gets a session id and a 32-byte random token, passed to the game through environment variables `MODSMITH_BRIDGE_URL`, `MODSMITH_BRIDGE_SESSION`, `MODSMITH_BRIDGE_TOKEN` (not on the command line, not logged).
- The mod refuses non-loopback URLs. It connects with `java.net.http.WebSocket` and retries every 5 seconds.
- The first message must be `hello`. Token comparison is constant-time. Wrong token closes with 4004, malformed hello 4003, protocol mismatch 4005, no hello within 10 s 4001.
- The session is closed when the process exits.

## Messages

```json
{ "type": "hello", "protocol": 1, "session": "...", "token": "...",
  "game": { "minecraft": "1.21.1", "loader": "fabric", "loaderVersion": "0.19.5", "side": "client", "bridgeVersion": "0.1.0", "development": true, "capabilities": ["registry.search", "..."] } }
{ "type": "welcome", "ok": true, "protocol": 1 }
{ "type": "request", "id": 7, "method": "registry.search", "params": { "registry": "item", "query": "diamond" } }
{ "type": "response", "id": 7, "ok": true, "result": { } }
{ "type": "response", "id": 8, "ok": false, "error": "Unknown item foo:bar" }
{ "type": "event", "event": "server.started", "data": { "dedicated": false } }
```

The host only sends methods listed in `capabilities`; calls time out (default 20 s).

## Methods

| Method | Side | Thread | Notes |
| --- | --- | --- | --- |
| `game.status` | both | caller | server running, world loaded, ticks, players |
| `client.status` | client | render | FPS, screen, loading overlay, local vs remote server, position |
| `game.mods` | both | caller | loaded mods (with nested flag) |
| `game.telemetry` | both | server | MSPT, TPS, entity count, memory |
| `game.wait_ticks` | both | server tick | resolves after N server ticks |
| `game.shutdown` | both | render/server | graceful stop |
| `registry.search` | both | caller | built-in registries; dynamic registries need a world |
| `world.open` | client | client tick | open or create a world; queued until resource loading finishes |
| `world.inspect_target` | both | render then server | block state, tags, light, biome, block entity NBT, or entity; `source` is `logical-server` or `client-replica` |
| `world.block_at` | both | server | block at coordinates |
| `world.give_item` | both | server | adds to inventory, drops overflow |
| `world.run_command` | both | server | operator permission, output captured |
| `world.entities` | both | server | entities around the player |
| `world.recipes` | both | server | resolved recipes with ingredients |
| `world.tags` | both | server | tags and members |
| `world.reload_datapacks` | both | server | `/reload` |
| `world.save` | both | server | flush and save |
| `player.inventory` | both | server | inventory contents |
| `client.screenshot` | client | render | PNG of the main render target, base64 |
| `client.reload_resources` | client | render | resource reload |

## Authority

World reads and writes run on the logical server thread (`server.execute`). On a client connected to a remote server there is no logical server: world-modifying methods fail with an explanation, and `world.inspect_target` returns client-replica data marked as such. A client connection never implies permission to modify a multiplayer server.
