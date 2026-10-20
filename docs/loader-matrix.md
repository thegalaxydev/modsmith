# Supported loader and version matrix

The compatibility catalog is `resources/catalog/compatibility.json` (schema version 1). Each entry has a status:

- **verified**: tested by hand with every starter, a build, a development client launch with the bridge, a world and the bridge tools.
- **tested** (shown as "build-tested"): generated from the loader's official example project and built automatically in CI with the empty starter. Starter code and launching are not tested.
- **unverified**: listed but not generated; the New Project wizard shows it disabled.

Projects can be created from verified and tested entries.

## Hand-verified entries

| Entry | Loader | Minecraft | Loader version | Gradle plugin | Gradle | Gradle JDK | Bytecode / runtime Java | Fabric API | Verified |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `fabric-1.21.1` | Fabric | 1.21.1 | 0.19.5 | `net.fabricmc.fabric-loom-remap` 1.18-SNAPSHOT | 9.7.1 | 25+ | 21 / 21+ | 0.116.17+1.21.1 | 2026-10-19 |
| `neoforge-1.21.1` | NeoForge | 1.21.1 | 21.1.262 | `net.neoforged.moddev` 2.0.148 | 9.2.1 | 21+ | 21 / 21+ | n/a (Parchment 2024.11.17) | 2026-10-19 |

NeoForge values come from `NeoForgeMDKs/MDK-1.21.1-ModDevGradle`.

## Fabric: every version from 1.14.4 to 26.3

`node scripts/catalog/sync-fabric.mjs` reads every branch of `FabricMC/fabric-example-mod` from 1.14.4 onwards and writes one catalog entry per Minecraft version (44 today). All of them use Fabric Loader 0.19.5, Loom 1.18 and Gradle 9.7.1, so Gradle needs JDK 25. What changes between versions:

| Minecraft | Java (bytecode) | Loom plugin | Mappings | Client source set | Logger | Identifier helper |
| --- | --- | --- | --- | --- | --- | --- |
| 1.14.4 to 1.16.5 | 8 | `fabric-loom-remap` | Mojang | no | log4j | `new ResourceLocation(...)` |
| 1.17, 1.17.1 | 16 | `fabric-loom-remap` | Mojang | no | log4j | `new ResourceLocation(...)` |
| 1.18 to 1.18.2 | 17 | `fabric-loom-remap` | Mojang | no | slf4j | `new ResourceLocation(...)` |
| 1.19 to 1.20.4 | 17 (1.20: 21) | `fabric-loom-remap` | Mojang | yes | slf4j | `new ResourceLocation(...)` |
| 1.20.5, 1.20.6 | 21 | `fabric-loom-remap` | Mojang | yes | slf4j | `new ResourceLocation(...)` |
| 1.21 to 1.21.10 | 21 | `fabric-loom-remap` | Mojang | yes | slf4j | `ResourceLocation.fromNamespaceAndPath` |
| 1.21.11 | 21 | `fabric-loom-remap` | Mojang | yes | slf4j | `Identifier.fromNamespaceAndPath` |
| 26.1 to 26.3 | 25 | `fabric-loom` | none (unobfuscated) | yes | slf4j | `Identifier.fromNamespaceAndPath` |

The entry records these details in its `fabric` block (`splitSources`, `logger`, `identifier`) and the generator follows them. The runtime Java minimum is the higher of Mojang's requirement for that version and the bytecode level (the example mod compiles 1.20 for Java 21). Hand-verified entries are never overwritten by the sync.

Generated entries offer the **empty** and **profiles** starters. The item, block, command, config and data generation starters use Minecraft 1.21-era APIs and stay limited to `fabric-1.21.1` until they are made version-aware. The bridge exists for 1.21.1 only.

### Build checks in CI

The **Catalog builds** workflow (`.github/workflows/catalog.yml`, weekly and on demand) generates an empty project for every Fabric entry and runs `./gradlew build` on JDK 25. On 2026-10-20 all 44 versions built (33 to 80 seconds each). To refresh the catalog after a run, download the `catalog-results` artifact and apply it:

```bash
node scripts/catalog/ci.mjs apply catalog-results.json
```

Passing entries become `tested`; failing ones go back to `unverified` with the failure noted. `node scripts/catalog/ci.mjs generate <entry> <dir>` produces the same project locally.

Not covered yet: launching each version, docking and input on older versions, Java runtime selection for Java 8 to 17 clients (Modsmith picks the lowest installed Java at or above the minimum), NeoForge and Forge versions other than 1.21.1.

Note: Loom 1.18 refuses to run on a Java 21 Gradle JVM even for 1.21.1 projects; the catalog therefore records the Gradle JDK requirement separately from the bytecode level.

## Loaders

| Loader | Detection of existing projects | Generation | Build / launch | Bridge |
| --- | --- | --- | --- | --- |
| Fabric | yes | yes (1.14.4 to 26.3; starters beyond the empty mod on 1.21.1) | yes | 1.21.1 |
| NeoForge (ModDevGradle) | yes | yes (verified entries) | yes (dev client/server, data generation; production server via the official installer) | 1.21.1 |
| NeoForge (NeoGradle) | detected, reported as unsupported | no | no | no |
| Forge | yes (static) | planned | planned | planned |
| Quilt, Architectury | detected and reported as unsupported | no | no | no |

## Mod providers

| Provider | Search | Resolve dependencies | Download | Pack import | Pack export |
| --- | --- | --- | --- | --- | --- |
| Modrinth | yes | yes | yes, hash-verified | `.mrpack` | `.mrpack` |
| CurseForge | yes (needs your API key) | yes | when the author allows third-party distribution; otherwise a manual download step with SHA-1 verification | CurseForge `.zip` (`manifest.json`) | CurseForge `.zip` |
| Local JAR | n/a | metadata only | n/a | n/a | listed as a manual step |
| Maven coordinates | n/a | resolved by Gradle | n/a | n/a | n/a |
