# Modsmith

A desktop workbench for Minecraft mod and modpack development: project creation from verified templates, dependency management (Modrinth and CurseForge), real Gradle builds, isolated development instances, a Minecraft client docked inside the window (Windows, and Linux on X11), a runtime bridge for live inspection, tests, and an MCP server so Claude and other MCP clients can drive the same tools.

"Modsmith" is a provisional name. It is defined once in `src/shared/product.ts`.

## Download

Installers are on the [Releases page](https://github.com/thegalaxydev/modsmith/releases): `Modsmith_<version>_x64-setup.exe` for Windows, and `Modsmith_<version>_amd64.AppImage` or `.deb` for Linux. Modsmith checks for a newer release when it starts and shows a notice with a download link. You can turn this off under Settings, About.

## Requirements

- Windows 10/11 (primary target) or Linux (see [Linux](docs/linux.md); docking needs X11 or XWayland)
- Node.js 22+ and npm (for building)
- Rust (stable, `x86_64-pc-windows-msvc`) for the desktop shell
- A JDK 25+ for Gradle (Fabric Loom 1.18 requires it) and a Java 21+ runtime for Minecraft 1.21.1. JDK 25 covers both.
- Internet access for first builds (Minecraft, Loom, Fabric API) and for Modrinth/CurseForge

## Setup

```bash
npm install
```

```bash
npm run build:bridge
```

```bash
npm run build
```

`build:bridge` compiles the Java companion mod into `resources/bridge/`. `build` bundles the service, MCP server, CLI and React UI into `dist/`.

## Run

Desktop app (Tauri shell; needs a Rust toolchain with the MSVC target and WebView2, which Windows 11 includes):

```bash
npm start
```

Installer (`src-tauri/target/release/bundle/nsis/Modsmith_<version>_x64-setup.exe`):

```bash
npm run tauri:build
```

`tauri:prepare`, which `npm start` (an alias of `npm run tauri:dev`) and `tauri:build` run first, builds the renderer and the TypeScript reference bundles and the Rust service (`modsmith-service.exe`, which is also the MCP server and the CLI). The installed app contains no Node runtime. See [docs/architecture.md](docs/architecture.md#desktop-shell).

CLI (starts the background service when needed):

```bash
node bin/modsmith.cjs help
```

Typical CLI flow:

```bash
node bin/modsmith.cjs create D:\mods\my-mod --name "My Mod" --starters empty,item,block,bridge,profiles
```

```bash
node bin/modsmith.cjs launch D:\mods\my-mod --profile dev-client
```

MCP configuration for your installation:

```bash
node bin/modsmith.cjs mcp config
```

See [docs/mcp.md](docs/mcp.md).

## Tests

```bash
npm test
```

`npm test` runs the suite twice: once against an in-process `Workbench` (the Node implementation) and once against the Rust service (`target/debug/modsmith-service.exe`, built first), plus the Rust unit tests. `npm run test:node` and `npm run test:rust` run one side. The Rust run includes parity tests that call both implementations on identical fixtures and compare the results, and a fake HTTP server (`test/fakeapi.ts`) stands in for Modrinth, CurseForge and the loader metadata services.

End-to-end smoke test through the MCP server (creates a project, builds, adds Mod Menu from Modrinth, launches Minecraft, uses the bridge, captures a screenshot, stops):

```bash
npm run smoke
```

## Documentation

- [Architecture](docs/architecture.md)
- [Supported loader/version matrix](docs/loader-matrix.md)
- [Project manifest and lock format](docs/manifest.md)
- [Bridge protocol](docs/bridge-protocol.md)
- [MCP setup and tools](docs/mcp.md)
- [Implementation status and limitations](docs/status.md)
- [Linux](docs/linux.md)
- [Releases and update checks](docs/releases.md)
- [Third-party notices](docs/third-party.md)

## License

Modsmith is free and will stay free. It is source-available under the [Apache License 2.0 with the Commons Clause](LICENSE) so that nobody can turn it into a commercial product: you may not sell Modsmith, a modified version or fork of it, or a paid product or service whose value comes mainly from Modsmith, such as paid hosting or paid support. Everything else is allowed. You can use it for anything, including making and selling mods and modpacks, and you can modify it and share it for free.

Everything you make with Modsmith is yours with no strings attached: your mods, modpacks and other creations, and every file Modsmith generates into your projects (templates, build scripts, manifests, lock files, exports). See [NOTICE](NOTICE) for that permission and for third-party components.
