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

Builds are not code-signed. Windows SmartScreen warns on first run of the installer until the publisher has reputation or a signing certificate is added.

## Update check

On startup, once the interface connects to the service, Modsmith calls `system.check_update`. The service asks the GitHub API for the latest published release of `thegalaxydev/modsmith` (`/repos/thegalaxydev/modsmith/releases/latest`, which skips drafts and pre-releases) and compares its tag with the running version. The answer is cached for six hours; `force: true` skips the cache.

If a newer version exists, a banner offers the installer for the current platform (the `-setup.exe` on Windows, the AppImage or `.deb` on Linux), a link to the release notes, and a dismiss button that hides the banner until the next version. Settings, About shows the result, has a Check now button, and can turn the startup check off. Modsmith does not download or install updates itself.

`MODSMITH_GITHUB_API` overrides the API base URL (the tests point it at `test/fakeapi.ts`).
