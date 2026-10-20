# Supported loader and version matrix

The compatibility catalog is `resources/catalog/compatibility.json` (schema version 1). Project generation is only allowed for entries with `status: "verified"`.

| Entry | Loader | Minecraft | Loader version | Gradle plugin | Gradle | Gradle JDK | Bytecode / runtime Java | Fabric API | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `fabric-1.21.1` | Fabric | 1.21.1 | 0.19.5 | `net.fabricmc.fabric-loom-remap` 1.18-SNAPSHOT | 9.7.1 | 25+ | 21 / 21+ | 0.116.17+1.21.1 | **verified** 2026-10-19 |
| `neoforge-1.21.1` | NeoForge | 1.21.1 | 21.1.262 | `net.neoforged.moddev` 2.0.148 | 9.2.1 | 21+ | 21 / 21+ | n/a (Parchment 2024.11.17) | **verified** 2026-10-19 |
| `fabric-26.3` | Fabric | 26.3 | 0.19.5 | `net.fabricmc.fabric-loom` 1.18-SNAPSHOT | 9.7.1 | 25+ | 25 / 25+ | 0.163.0+26.3 | unverified (generation disabled) |

Fabric values come from the official `FabricMC/fabric-example-mod` branches; NeoForge values from `NeoForgeMDKs/MDK-1.21.1-ModDevGradle`. Verification means: generated a project with every starter, built it, launched the development client with the bridge, created a world, and exercised the bridge on Windows 11.

Note: Loom 1.18 refuses to run on a Java 21 Gradle JVM even for 1.21.1 projects; the catalog therefore records the Gradle JDK requirement separately from the bytecode level.

## Loaders

| Loader | Detection of existing projects | Generation | Build / launch | Bridge |
| --- | --- | --- | --- | --- |
| Fabric | yes | yes (verified entries) | yes | 1.21.1 |
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
