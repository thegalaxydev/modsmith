# Verified extension registry

This folder lists the extensions that Modsmith shows under **Settings › Extensions › Verified extensions**. Each file in `extensions/<id>/<version>.json` describes one reviewed version of one extension: where its package is, its SHA-256 and size, and the permissions that were approved.

When a pull request that adds a file here is merged, the Website workflow publishes the list to <https://thegalaxydev.github.io/modsmith/extensions/index.json>, and Modsmith shows the new version the next time someone opens the Verified list (the list is cached for up to six hours). Modsmith only installs a Verified version if the downloaded file matches the SHA-256 recorded here, and refuses packages that ask for permissions that were not approved.

Anyone can still install an extension from a link or a `.zip` file. Those installs are marked **Unverified**.

## Submitting a version

1. Build your extension and check it with the packer (see [docs/extensions.md](../docs/extensions.md)):

   ```bash
   node scripts/extensions.mjs pack path/to/your-extension
   ```

   `extension.json` must have a `repository` link to the public GitHub repository that holds the extension's source.

2. Create a GitHub release in that repository and attach the `.zip` the packer made.

3. In a fork of Modsmith, write the registry entry from the release asset:

   ```bash
   node scripts/extensions.mjs manifest https://github.com/OWNER/REPO/releases/download/v1.0.0/OWNER.NAME-1.0.0.zip
   ```

   This downloads the package, checks it and writes `registry/extensions/<id>/<version>.json`.

4. Commit only that file and open a pull request. Say what the extension does and why it needs each permission.

The **Extension registry** check downloads the package and confirms that the entry matches it. Approved versions are never changed: to fix something, publish a new version. Every version of an extension must come from the same repository.

## Reviewing a submission

Anyone with write access to Modsmith can approve a submission by merging it. Before merging:

- [ ] The pull request changes only files under `registry/extensions/`. Treat any change to scripts, workflows or other files as a separate, ordinary code review.
- [ ] The **Extension registry** check passed.
- [ ] The release tag and source in the extension's repository match the package (the packer output is reproducible from the tagged source).
- [ ] `main.js` is readable. Reject packages whose code is obfuscated, or that load or evaluate code they download.
- [ ] Each permission is needed for what the extension says it does. Look closely at `project.write`, `build` and `network`.
- [ ] With `network`, the extension says which servers it contacts and why, and does not send project files or personal data anywhere without asking.
- [ ] The extension works when installed from the release asset in a current build of Modsmith.
- [ ] The name and description are accurate and do not imply that it is made by Mojang, Microsoft or the Modsmith project unless it is.

To delist a version, delete its file in a pull request. Installed copies keep working, but the version is no longer offered.
