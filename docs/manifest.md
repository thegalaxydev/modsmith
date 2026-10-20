# Project manifest (`modsmith.json`)

Schema version 1. Validated with zod (`src/core/manifest.ts`). Unknown schema versions are rejected rather than guessed.

```json
{
  "schemaVersion": 1,
  "name": "My Mod",
  "type": "mod",
  "modId": "mymod",
  "platform": { "loader": "fabric", "minecraft": "1.21.1", "loaderVersion": "0.19.5", "catalogEntry": "fabric-1.21.1" },
  "source": { "kind": "gradle", "root": "." },
  "dependencies": [
    { "source": "modrinth", "projectId": "mOgUt4GM", "versionId": "6lgOkclV", "usage": "compile", "required": false, "environment": "client" }
  ],
  "profiles": [
    {
      "id": "dev-client",
      "name": "Development client",
      "side": "client",
      "mode": "development",
      "java": {},
      "jvm": { "memoryMb": 4096, "args": [] },
      "includeSourceMod": true,
      "bridge": true,
      "mods": [
        { "source": "modrinth", "projectId": "mOgUt4GM", "usage": "runtime", "required": true, "environment": "both" },
        { "source": "curseforge", "projectId": "238222", "fileId": "5101366", "usage": "runtime", "required": true, "environment": "both" },
        { "source": "local", "path": "D:/jars/some-mod.jar", "usage": "runtime", "required": true, "environment": "both" }
      ],
      "configDir": "profiles/dev/config",
      "resourcePacks": [],
      "datapacks": [],
      "scripts": [],
      "world": { "name": "test-world" },
      "debug": { "enabled": false, "port": 5005, "suspend": false },
      "programArgs": []
    }
  ]
}
```

## Workspace types

- `mod`: a Gradle source project.
- `modpack`: no Java source (`source.kind: "none"`). Development clients run through a generated Loom harness in `.modsmith/harness`.
- `combined`: a source mod tested inside one or more pack profiles.

## Mod references

| `source` | Fields | Notes |
| --- | --- | --- |
| `modrinth` | `projectId`, optional `versionId` | `usage: compile` adds a Modrinth Maven dependency (generated projects read `modsmith.dependencies.gradle`); `runtime` installs into instances only |
| `curseforge` | numeric `projectId`, optional `fileId` | runtime only |
| `local` | `path` | runtime only |
| `maven` | `coordinates`, optional `repository` | resolved by Gradle |

`environment` (`client`, `server`, `both`) filters references per profile side. Provider side metadata is also respected.

## Profiles

`mode: development` launches through Loom's development tooling. `mode: production` builds the distributable JAR and installs it into an ordinary Fabric server (servers only). Each profile gets its own instance directory; a second launch of the same profile is refused while one is running.

## Lock file (`modsmith.lock.json`)

Written by resolution. One section per profile (`<id>` or `<id>@production`):

```json
{
  "schemaVersion": 1,
  "profiles": {
    "dev-client": {
      "resolvedAt": "2026-10-19T22:00:00.000Z",
      "minecraft": "1.21.1",
      "loader": "fabric",
      "loaderVersion": "0.19.5",
      "entries": [
        {
          "key": "modrinth:mOgUt4GM",
          "provider": "modrinth",
          "projectId": "mOgUt4GM",
          "versionId": "6lgOkclV",
          "versionNumber": "11.0.5",
          "title": "Mod Menu",
          "fileName": "modmenu-11.0.5.jar",
          "url": "https://cdn.modrinth.com/...",
          "sha1": "...",
          "sha512": "...",
          "size": 975846,
          "modIds": ["modmenu"],
          "license": "MIT",
          "environment": { "client": "required", "server": "unsupported" },
          "distribution": "direct",
          "reason": "profile dev-client",
          "required": true
        }
      ],
      "issues": [{ "severity": "info", "message": "..." }]
    }
  }
}
```

A resolved graph records declared metadata (required/optional/incompatible dependencies, duplicate IDs and files, missing declared dependencies). Unknown compatibility stays unknown; resolution does not prove runtime compatibility.

## Scenario files (`scenarios/*.json`)

```json
{
  "schemaVersion": 1,
  "name": "smoke",
  "profile": "dev-client",
  "requires": ["registry.search", "world.give_item"],
  "timeoutMs": 60000,
  "setup": [{ "action": "command", "command": "clear @s" }],
  "steps": [
    { "action": "assert_registry", "registry": "item", "id": "minecraft:diamond" },
    { "action": "give", "item": "minecraft:diamond", "count": 2 },
    { "action": "wait_ticks", "ticks": 5 },
    { "action": "assert_inventory", "item": "minecraft:diamond", "minCount": 2 },
    { "action": "assert_block", "x": 0, "y": -61, "z": 0, "block": "minecraft:grass_block" },
    { "action": "assert_log", "pattern": "ERROR", "absent": true },
    { "action": "screenshot", "label": "end" }
  ],
  "cleanup": [{ "action": "command", "command": "clear @s" }]
}
```
