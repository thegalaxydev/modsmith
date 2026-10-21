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

### Locked versions and updates

Resolution keeps the version in the lock file for every Modrinth and CurseForge mod, including dependencies pulled in by other mods, as long as the lock section was resolved for the same Minecraft version and loader. Play resolves before each launch, so this is what keeps a profile on the same mod versions from run to run. A mod that is not in the lock yet (newly added) gets the newest compatible version. A pin in the manifest (`versionId` or `fileId`) always wins.

Newer versions are taken only through an update. **Mods › Updates** in the app, or the API:

| Method | |
| --- | --- |
| `profile.check_updates` | Lists the locked mods with a newer compatible version (newest release first, then beta and alpha, as resolution picks), whether each is pinned and whether it is a direct reference or a dependency. Version lists are fetched fresh, not from the 15-minute cache |
| `profile.preview_update` | Resolves with the chosen updates without writing anything and returns the change list: mods updated, added and removed, and problems that appear or go away |
| `profile.apply_update` | Moves pinned references to the new versions, resolves, and records a rollback point in `.modsmith/updates/<id>.json` with the earlier pins and lock section |
| `profile.update_history` | Rollback points, newest first |
| `profile.rollback_update` | Restores the earlier pins and resolves with the earlier versions held. Mods added since the update keep their versions; dependencies that only the newer versions needed are dropped |

`keys` (lock keys such as `modrinth:mOgUt4GM`) selects some updates; without it every available update is used.

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
