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

### Fabric API version

The sync also checks each example mod's Fabric API pin against the versions Modrinth lists for that exact Minecraft version. Several old branches pin a Fabric API that requires a newer Minecraft (for example `0.42.0+1.16` on the 1.16 and 1.16.1 branches needs 1.16.2), so the game refuses to start. For 1.15, 1.15.1, 1.16 to 1.16.4 and 1.17 the catalog uses the newest Fabric API that Modrinth lists for that version instead. The Fabric API mod id also changed over time (`fabric` up to 1.18.1 and on 1.19 and 1.19.1, `fabric-api` elsewhere), so entries record it in `fabric.apiModId` and the generated `fabric.mod.json` depends on the right one.

### Launch checks in CI

The **Catalog builds** workflow (`.github/workflows/catalog.yml`, weekly and on demand) builds the Linux `modsmith-service` once, then for every Fabric entry runs `scripts/catalog/launch-check.mjs`. That script drives the real service through its CLI: it creates a project with the empty mod (which runs the first Gradle build on JDK 25), launches the development client under Xvfb with software OpenGL and OpenAL's null audio driver, waits for the title screen ("Sound engine started" or the block atlas being created in the log), and stops the game. The runner has Temurin 8, 11, 17, 21 and 25, and Modsmith chooses among them as it would on a user's machine.

On 2026-10-21 all 44 versions reached the title screen, 9 to 28 seconds after launch (median 19):

| Minecraft | Java Modsmith chose |
| --- | --- |
| 1.14.4 to 1.16.5 | 8 |
| 1.17 to 1.20.4 | 17 (1.17 asks for 16, which was not installed) |
| 1.20, 1.20.5 to 1.21.11 | 21 |
| 26.1 to 26.3 | 25 |

Two runs hit a Loom "Failed to download" error in `downloadAssets` while 16 jobs fetched Minecraft assets at once; the check now retries the launch once after a download failure.

To refresh the catalog after a run, download the `catalog-results` artifact and apply it:

```bash
node scripts/catalog/ci.mjs apply catalog-results.json
```

Entries that reached the title screen, or built but did not launch, become `tested` with the outcome in their note; entries that failed to build go back to `unverified`. To run the same check locally (Windows or Linux), point it at a service binary:

```bash
node scripts/catalog/launch-check.mjs target/release/modsmith-service fabric-1.16.5 work
```

`CHECK_JAVA_HOME=<path>` pins the client to a particular Java for the run.

### Java runtime selection

For each launch Modsmith uses the lowest installed Java at or above the entry's `runtimeJavaMin` (or the profile's own Java home or minimum). Checked on Windows 11 with Java 8, 17, 21 and 25 installed: 1.14.4 and 1.16.5 ran on Java 8, 1.17.1 and 1.19 on 17, and 26.3 on 25. When the ideal Java is missing, newer ones still worked: 1.16.5 reached the title screen pinned to Java 17 and to Java 21, and 1.14.4 pinned to Java 25.

Java 8 does not understand `@argfile` arguments, which Modsmith used to pass the classpath, so 1.14 to 1.16 clients could not start. Modsmith now passes `-cp` directly when the runtime is Java 8 and keeps the argument file for Java 9 and newer. Java detection also follows symbolic links in the folders it scans (such as `~/.jdks`).

Not covered yet: docking and input on versions other than 1.21.1, release-build clients for older versions, starters beyond the empty mod on other versions, NeoForge and Forge versions other than 1.21.1.

Note: Loom 1.18 refuses to run on a Java 21 Gradle JVM even for 1.21.1 projects; the catalog therefore records the Gradle JDK requirement separately from the bytecode level.

## Loaders

| Loader | Detection of existing projects | Generation | Build / launch | Bridge |
| --- | --- | --- | --- | --- |
| Fabric | yes | yes (1.14.4 to 26.3; starters beyond the empty mod on 1.21.1) | yes | 1.21.1 |
| NeoForge (ModDevGradle) | yes | yes (verified entries) | yes (dev client/server, data generation; production server via the official installer) | 1.21.1 |
| NeoForge (NeoGradle) | detected, reported as unsupported | no | no | no |
| Forge | yes (static) | planned | planned | planned |
| Quilt, Architectury | detected and reported as unsupported | no | no | no |

## Server packs

`server.export_pack` (More actions > Export server pack) turns a server profile into a folder that runs on any host:

- The project's release JAR and the profile's server-side mods. Client-only mods and the development bridge are left out.
- The official server: Fabric's server launcher with the Minecraft server JAR, or the NeoForge `--install-server` output.
- Configs, datapacks and scripts from the profile. Datapacks for the profile's world go to `world/datapacks`.
- `start.sh` and `start.bat` with the profile's memory and JVM arguments (NeoForge keeps them in `user_jvm_args.txt`), and a README listing the mods and the Java version.
- Optionally a zip of the folder, with `start.sh` marked executable for Linux hosts.

The EULA is not accepted in the pack; the server owner does that on the first start. The output folder must be new or empty.

## Mod providers

| Provider | Search | Resolve dependencies | Download | Pack import | Pack export |
| --- | --- | --- | --- | --- | --- |
| Modrinth | yes | yes | yes, hash-verified | `.mrpack` | `.mrpack` |
| CurseForge | yes (needs your API key) | yes | when the author allows third-party distribution; otherwise a manual download step with SHA-1 verification | CurseForge `.zip` (`manifest.json`) | CurseForge `.zip` |
| Local JAR | n/a | metadata only | n/a | n/a | listed as a manual step |
| Maven coordinates | n/a | resolved by Gradle | n/a | n/a | n/a |
