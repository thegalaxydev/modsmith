# Releases and update checks

## Publishing a release

Releases are built by GitHub Actions (`.github/workflows/release.yml`) when a tag starting with `v` is pushed.

1. Set the version everywhere it appears (`package.json`, `src/shared/product.ts`, `src-tauri/tauri.conf.json`, the three crate manifests and the HTTP user agent):

   ```bash
   node scripts/version.mjs set 0.2.0
   ```

2. Build once (`npm test` is enough) so `Cargo.lock` picks up the new crate versions, then commit.
3. Tag and push:

   ```bash
   git tag v0.2.0
   git push origin master v0.2.0
   ```

The workflow builds the bridge JARs (JDK 21 for NeoForge, JDK 25 for Fabric), then builds the app on `windows-latest` (NSIS installer) and `ubuntu-22.04` (`.deb` and AppImage), and publishes a GitHub release with those files and generated notes. It stops if the tag does not match the version in the source (`node scripts/version.mjs check <tag>`). Running the workflow by hand (`workflow_dispatch`) builds the installers as workflow artifacts without publishing a release.

### Linux package metadata

The `.deb` and AppImage carry the desktop and software-center metadata that KDE Discover and GNOME Software read:

- `src-tauri/linux/modsmith.desktop` is the desktop entry template (`Name=Modsmith`, `Exec=modsmith`, `Icon=modsmith`, `Categories=Development;IDE;`). Tauri installs it as `/usr/share/applications/Modsmith.desktop`.
- `src-tauri/linux/dev.modsmith.workbench.metainfo.xml.in` is the AppStream metadata, installed as `/usr/share/metainfo/dev.modsmith.workbench.metainfo.xml`. Its ID is the app identifier `dev.modsmith.workbench`, its launchable is `Modsmith.desktop` and its icon is `modsmith`, matching the desktop entry and the installed icons. It names Galaxy Development LLC as the developer and lists the license as `Apache-2.0 AND LicenseRef-Commons-Clause-1.0`: Apache-2.0 is the SPDX identifier of the base license, and the Commons Clause has no SPDX identifier, so it is a `LicenseRef`.
- `node scripts/linux-metadata.mjs` (run by `npm run tauri:prepare` and by the release workflow) fills the release list from the `v*` tags and writes the metainfo file and a machine-readable `/usr/share/doc/modsmith/copyright` built from `LICENSE` into `src-tauri/linux/generated/`.
- Icons are installed at 32, 48, 64, 128, 256 and 512 pixels from `src-tauri/icons/` and as `scalable/apps/modsmith.svg` from `resources/brand/modsmith.svg`.
- The control file's `Maintainer` comes from `authors` in `src-tauri/Cargo.toml` (Galaxy Development LLC with the public support address), `Homepage` from `bundle.homepage` and the description from `bundle.shortDescription` and `longDescription`.

The `check Linux package metadata` job unpacks the built `.deb` on Ubuntu 24.04, checks the control fields and files, and runs `desktop-file-validate` and `appstreamcli validate`. A release is only published when it passes.

Builds are not code-signed. Windows SmartScreen warns on first run of the installer until the publisher has reputation or a signing certificate is added.

## Update check

On startup, once the interface connects to the service, Modsmith calls `system.check_update`. The service asks the GitHub API for the latest published release of `thegalaxydev/modsmith` (`/repos/thegalaxydev/modsmith/releases/latest`, which skips drafts and pre-releases) and compares its tag with the running version. The answer is cached for six hours; `force: true` skips the cache.

If a newer version exists, a banner offers the installer for the current platform (the `-setup.exe` on Windows, the AppImage or `.deb` on Linux), a link to the release notes, and a dismiss button that hides the banner until the next version. Settings, About shows the result, has a Check now button, and can turn the startup check off. Modsmith does not download or install updates itself.

The window starts the service it ships with. If a service from another Modsmith version is still running (for example after installing an update without restarting the computer), the window asks it to stop, leaving any running games alone, and starts its own, so the version the update check reports is always the installed one.

`MODSMITH_GITHUB_API` overrides the API base URL (the tests point it at `test/fakeapi.ts`).
