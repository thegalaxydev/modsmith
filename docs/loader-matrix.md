# Supported loader and version matrix

The compatibility catalog is `resources/catalog/compatibility.json` (schema version 1). Each entry has a status:

- **verified**: tested by hand with every starter, a build, a development client launch with the bridge, a world and the bridge tools.
- **tested**: generated from the loader's official example project; in CI an empty project built and its development client reached the title screen. Starter code beyond the empty mod is not tested. The New mod form explains the selected version's status under the version list.
- **unverified**: listed but not generated; the New Project wizard shows it disabled.

Projects can be created from verified and tested entries.

## Hand-verified entries

| Entry | Loader | Minecraft | Loader version | Gradle plugin | Gradle | Gradle JDK | Bytecode / runtime Java | Fabric API | Verified |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `fabric-1.21.1` | Fabric | 1.21.1 | 0.19.5 | `net.fabricmc.fabric-loom-remap` 1.18-SNAPSHOT | 9.7.1 | 25+ | 21 / 21+ | 0.116.17+1.21.1 | 2026-10-19 |
| `neoforge-1.21.1` | NeoForge | 1.21.1 | 21.1.262 | `net.neoforged.moddev` 2.0.148 | 9.2.1 | 21+ | 21 / 21+ | n/a (Parchment 2024.11.17) | 2026-10-19 |
| `fabric-1.20.1` | Fabric | 1.20.1 | 0.19.5 | `net.fabricmc.fabric-loom-remap` 1.18-SNAPSHOT | 9.7.1 | 25+ | 17 / 17+ | 0.92.12+1.20.1 | 2026-10-21 |
| `forge-1.20.1` | Forge | 1.20.1 | 47.4.28 | `net.neoforged.moddev.legacyforge` 2.0.148 | 9.2.1 | 17+ | 17 / 17+ | n/a (Parchment 2023.09.03) | 2026-10-21 |

NeoForge values come from `NeoForgeMDKs/MDK-1.21.1-ModDevGradle`. The Forge entry is described under [Forge 1.20.1](#forge-1201).

For both 1.20.1 entries, a project with every starter was built and its data generation run, and `scripts/smoke.mjs` passed: it created a project with the item, block, command, bridge and profiles starters, added a mod from Modrinth (Mod Menu 7.2.2 on Fabric, JEI 15.56.0.205 on Forge), launched the development client, connected the bridge, found the item and block in the registry, created a flat world, gave the item, placed the block, ran the command, took a screenshot, stopped the game with exit code 0 and confirmed that the test server refused to start without the EULA.

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

Generated entries offer the **empty** and **profiles** starters. The item, block, command, config, data generation and bridge starters are offered on the hand-verified entries, `fabric-1.21.1` and `fabric-1.20.1`. The generators adapt the starter code to the version (for example `loot_tables` instead of `loot_table` before 1.21, and the language provider without a registry lookup before 1.20.5); other versions get them once they have been checked.

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

## NeoForge: every version from 1.20.4 to 26.3

`node scripts/catalog/sync-neoforge.mjs` reads every `NeoForgeMDKs/MDK-<version>-ModDevGradle` template and writes one catalog entry per Minecraft version (19 today). Each takes the NeoForge, ModDevGradle, Gradle, Java and Parchment versions from its template. What changes between versions:

| Minecraft | Java | Mappings | Metadata file | Mod constructor | Client entrypoint | `modLoader`/`loaderVersion` | Data run | Identifier helper |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1.20.4 | 17 | Parchment | `mods.toml` | `IEventBus` | no | yes | `data()` | `new ResourceLocation(...)` |
| 1.20.6 | 21 | Parchment | `neoforge.mods.toml` | `IEventBus, ModContainer` | no | yes | `data()` | `new ResourceLocation(...)` |
| 1.21 | 21 | Parchment | `neoforge.mods.toml` | `IEventBus, ModContainer` | no | yes | `data()` | `ResourceLocation.fromNamespaceAndPath` |
| 1.21.1 to 1.21.3 | 21 | Parchment | `neoforge.mods.toml` | `IEventBus, ModContainer` | yes | yes | `data()` | `ResourceLocation.fromNamespaceAndPath` |
| 1.21.4 | 21 | Parchment | `neoforge.mods.toml` | `IEventBus, ModContainer` | yes | yes | `clientData()` | `ResourceLocation.fromNamespaceAndPath` |
| 1.21.5 to 1.21.10 | 21 | Parchment | `neoforge.mods.toml` | `IEventBus, ModContainer` | yes | no | `clientData()` | `ResourceLocation.fromNamespaceAndPath` |
| 1.21.11 | 21 | Parchment | `neoforge.mods.toml` | `IEventBus, ModContainer` | yes | no | `clientData()` | `Identifier.fromNamespaceAndPath` |
| 26.1 to 26.3 | 25 | none (unobfuscated) | `neoforge.mods.toml` | `IEventBus, ModContainer` | yes | no | `clientData()` | `Identifier.fromNamespaceAndPath` |

The entry records these in its `neoforge` block and both generators follow them. The identifier helper is taken from the Fabric entry for the same Minecraft version, since both use Mojang's names. Entries without a `neoforge` block (the hand-verified `neoforge-1.21.1`) keep the 1.21.1 layout. As for Fabric, generated entries offer the empty and profiles starters and the bridge is 1.21.1 only.

Some versions only have NeoForge betas (1.21.2, 1.21.6, 1.21.7, 1.21.9, 26.1 and 26.1.1); their notes say so. Not included:

- 1.20.5: NeoForge only published 20.5.x betas, which lack the bundle ModDevGradle needs, so the build fails. 1.20.6 replaced it within days.
- 1.20.2: its template uses NeoGradle, which Modsmith does not support.
- 1.20.1: NeoForge's 1.20.1 build is a fork of Forge. Use the [Forge 1.20.1](#forge-1201) entry instead.

On 2026-10-21 the Catalog builds workflow created, built and launched every NeoForge entry: all 19 reached the title screen 9 to 19 seconds after launch, with Java 17 for 1.20.4, 21 for 1.20.6 to 1.21.11 and 25 for 26.1 to 26.3. Before that, empty projects for 1.20.4, 1.21.5, 1.21.11 and 26.3 were built on Windows. The workflow takes `fabric`, `neoforge`, `all`, `untested` or entry ids.

### Java runtime selection

For each launch Modsmith uses the lowest installed Java at or above the entry's `runtimeJavaMin` (or the profile's own Java home or minimum). Checked on Windows 11 with Java 8, 17, 21 and 25 installed: 1.14.4 and 1.16.5 ran on Java 8, 1.17.1 and 1.19 on 17, and 26.3 on 25. When the ideal Java is missing, newer ones still worked: 1.16.5 reached the title screen pinned to Java 17 and to Java 21, and 1.14.4 pinned to Java 25.

Java 8 does not understand `@argfile` arguments, which Modsmith used to pass the classpath, so 1.14 to 1.16 clients could not start. Modsmith now passes `-cp` directly when the runtime is Java 8 and keeps the argument file for Java 9 and newer. Java detection also follows symbolic links in the folders it scans (such as `~/.jdks`).

Not covered yet: docking and input on versions other than 1.21.1, release-build clients for older versions, starters beyond the empty mod on other versions.

Note: Loom 1.18 refuses to run on a Java 21 Gradle JVM even for 1.21.1 projects; the catalog therefore records the Gradle JDK requirement separately from the bytecode level.

## Forge 1.20.1

New Forge projects use [ModDevGradle Legacy](https://github.com/neoforged/ModDevGradle) (`net.neoforged.moddev.legacyforge`) instead of ForgeGradle. It is the same Gradle plugin as NeoForge's ModDevGradle, adapted for Forge 1.17 to 1.20.1, so Modsmith builds and launches Forge projects the way it does NeoForge ones. The generated project follows the official Forge 1.20.1 MDK (47.4.28):

- `META-INF/mods.toml` from `src/main/templates`, with Forge `[47.4,)` and Minecraft `[1.20.1,1.21)`, and `pack.mcmeta` with pack format 15.
- A `@Mod` class whose constructor takes `FMLJavaModLoadingContext`, and a client class that listens for `FMLClientSetupEvent`.
- Starters with Forge's APIs: `DeferredRegister` and `RegistryObject` for the item and block, `RegisterCommandsEvent`, a `ForgeConfigSpec` common config (Forge 1.20.1 has no built-in configuration screen), and a `GatherDataEvent` language provider run by `runData`.
- Java 17 and Parchment 2023.09.03. Compile dependencies go in `modImplementation` so ModDevGradle remaps them.

`./gradlew build` puts the JAR for players in `build/libs`, reobfuscated to Forge's SRG names, and the development JAR in `build/devlibs`. Release launches and server packs use the `build/libs` JAR.

A Forge 1.20.1 development game runs with Mojang's names, but mods published on Modrinth and CurseForge use SRG names, so they crash in a development game (`NoSuchFieldError: f_91002_` from JEI, for example). Before a development launch Modsmith remaps every mod in the profile to development names with ModDevGradle's own tool (installertools `SRG_TO_MCP` and the project's `intermediateToNamed.zip`) and caches the result by checksum in `downloads/forge-dev-remap`. The tool also remaps the jars nested inside a mod (jar-in-jar), and the development run tells Mixin to remap the mods' refmaps with the same mappings. Checked with Create 6.0.8, which bundles Flywheel, Ponder, Registrate and MixinExtras: it loaded, applied its mixins and registered its blocks in a development client.

For the same reason the Forge bridge comes as two JARs: `modsmith-bridge-forge-1.20.1.jar` for development runs and `modsmith-bridge-forge-1.20.1-release.jar` (reobfuscated) for release runs. The catalog names them `bridge.jar` and `bridge.releaseJar`.

Existing projects that use ForgeGradle are detected as Forge but can only be browsed and edited; the workspace shows a warning. Moving one to ModDevGradle Legacy means replacing the `minecraft {}` block with a `legacyForge {}` block like the generated one.

## Loaders

| Loader | Detection of existing projects | Generation | Build / launch | Bridge |
| --- | --- | --- | --- | --- |
| Fabric | yes | yes (1.14.4 to 26.3; starters beyond the empty mod on 1.21.1 and 1.20.1) | yes | 1.21.1, 1.20.1 |
| NeoForge (ModDevGradle) | yes | yes (1.20.4 to 26.3; starters beyond the empty mod on 1.21.1) | yes (dev client/server, data generation; production server via the official installer) | 1.21.1 |
| Forge (ModDevGradle Legacy) | yes | yes (1.20.1, all starters) | yes (dev client/server with remapped runtime mods, data generation; production server via the official installer) | 1.20.1 |
| NeoForge (NeoGradle), Forge (ForgeGradle) | detected, reported as unsupported | no | no | no |
| Quilt, Architectury | detected and reported as unsupported | no | no | no |

## Server packs

`server.export_pack` (More actions > Export server pack) turns a server profile into a folder that runs on any host:

- The project's release JAR and the profile's server-side mods. Client-only mods and the development bridge are left out.
- The official server: Fabric's server launcher with the Minecraft server JAR, the NeoForge `--install-server` output, or the Forge `--installServer` output.
- Configs, datapacks and scripts from the profile. Datapacks for the profile's world go to `world/datapacks`.
- `start.sh` and `start.bat` with the profile's memory and JVM arguments (NeoForge and Forge keep them in `user_jvm_args.txt`), and a README listing the mods and the Java version.
- Optionally a zip of the folder, with `start.sh` marked executable for Linux hosts.

The EULA is not accepted in the pack; the server owner does that on the first start. The output folder must be new or empty.

## Deploying to a server

More actions > **Deploy to a server…** uploads a server profile to a server over SFTP (`server.deploy`). It builds the same pack as above in `.modsmith/deploy`, compares it with what is on the server and uploads only new and changed files.

- **What to upload.** *Mods and configs* (the default) sends `mods/` and `config/`, for hosts whose panel installs the loader; set the server to the same loader version there (the dialog names it). *The whole server* also sends the loader, libraries and start scripts, for a plain VPS. `server.properties`, `eula.txt` and the world are never uploaded, so host settings such as the port and the live world stay as they are; datapacks under `world/datapacks` are uploaded in *whole server* mode.
- **Preview first.** Preview lists every file it would upload (new or changed) or remove and changes nothing; Deploy is enabled after a preview. Files are written under a temporary name and then moved into place.
- **Removing mods.** Modsmith records what it uploaded in `.modsmith-deploy.json` in the server folder. With *Remove mods you took out of the configuration* on, it deletes mods it uploaded earlier that are no longer in the profile, and only if they are unchanged on the server. Files it did not upload, such as mods added through the host's panel, are never removed.
- **Credentials.** The address, port, user name, folder and mode are saved per server profile in the data folder (`deploy-targets.json`), not in the project. The password is kept in the system secret store (DPAPI on Windows, Secret Service on Linux) when *Remember the password* is on; otherwise it is sent with each deploy and not stored.
- **Host keys.** The first connection shows the server's host key (for example `ssh-ed25519 SHA256:…`) so you can compare it with the one your host shows, and Modsmith remembers it after you trust it (`known-hosts.json`). If the key later changes, deploys stop with an error until you check and trust the new key.
- **BisectHosting.** Choose the BisectHosting preset: SFTP runs on port 2022, the user name looks like `username.serverid` and the password is your panel password. All three are shown in the panel under Files > SFTP Credentials. Restart the server from the panel after a deploy to load the changes.

Deploys are not available through MCP. The Rust service uses `russh` with the `ring` backend, so it needs no OpenSSL on Windows or Linux; it supports ed25519, ECDSA and RSA host keys, of which ed25519 has been tested.

Verified on Windows with a local SFTP server (the test server in `test/sftpserver.ts`, an ed25519 host key) through the dialog against the Rust service: the host key prompt showed the server's fingerprint, the preview listed the three files, Deploy uploaded them, the target and password were remembered and a second preview reported everything unchanged. `test/deploy.test.ts` runs a longer scenario (wrong password, unsaved password, preview, deploy, redeploy, a swapped mod with a file added by hand, a forgotten password and a changed host key) against both services and checks that they report and leave the same files. Not yet tried against a real BisectHosting server.

## Mod providers

| Provider | Search | Resolve dependencies | Download | Pack import | Pack export |
| --- | --- | --- | --- | --- | --- |
| Modrinth | yes | yes | yes, hash-verified | `.mrpack` | `.mrpack` |
| CurseForge | yes (needs your API key) | yes | when the author allows third-party distribution; otherwise a manual download step with SHA-1 verification | CurseForge `.zip` (`manifest.json`) | CurseForge `.zip` |
| Local JAR | n/a | metadata only | n/a | n/a | listed as a manual step |
| Maven coordinates | n/a | resolved by Gradle | n/a | n/a | n/a |
