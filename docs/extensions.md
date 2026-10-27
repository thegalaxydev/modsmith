# Extensions

Extensions add file viewers and panels to Modsmith without changing Modsmith itself. A viewer opens when you click a file that matches its patterns (for example `*.nbt`), and a panel is a tab you open from the left rail. Extensions are web code (HTML, CSS and JavaScript) that runs in a sandbox and talks to Modsmith through a small API, limited to the permissions it asks for.

Extensions need Modsmith 0.1.12 or newer. Companion mods, bridge methods for extensions, `modsmith.showGame`, `modsmith.onBridgeEvent` and binary writes need 0.1.13; an extension that uses them sets `"modsmith": "0.1.13"` in its manifest. `assets.blocks`, which resolves block states to their models, rotations and textures for drawing blocks (Ponder Studio uses it for its 3D view), needs 0.1.16. From 0.1.17 it also resolves block states with missing properties, picking the first variant that agrees with the properties given as the game does with defaults, and returns `connected`, which maps each texture with a `<texture>_connected` sheet (Create-style connected textures) to that sheet.

## Installing extensions

Open **Settings › Extensions**.

- **Verified extensions** lists extensions that the Modsmith maintainers reviewed (see [Verified extensions](#verified-extensions)). **Install** shows what the extension can do and installs the reviewed package, checked against the SHA-256 recorded when it was approved. When a newer Verified version is published, **Update to …** appears next to the installed extension.
- **Install from a link or file** installs an extension that is not in the registry. Paste a GitHub repository link (the `.zip` attached to its latest release is used), a release page link (`…/releases/tag/v1.2.0`) or a direct `https://` link to a `.zip`, or choose a `.zip` on your computer. Modsmith shows the name, publisher, permissions, source and SHA-256 before anything is installed. These installs are marked **Unverified**.

Each installed extension can be turned off with its switch or uninstalled. Viewers show a bar above the file with the extension's name and **Open as text** to use the normal editor instead. Extensions are stored in the `extensions` folder of the Modsmith data folder (`%APPDATA%\Modsmith\extensions` on Windows, `~/.config/modsmith/extensions` on Linux).

## What an extension can and cannot do

Every viewer and panel runs in its own sandboxed frame, served from a separate origin (`modsmithext:`) with its own content security policy. An extension:

- cannot read or change Modsmith's window, settings, stored data or other extensions,
- cannot run Gradle, launch the game, write files or use the network unless it has the matching permission,
- only reaches the project that is open: Modsmith fills in the project path itself, and game commands only go to that project's running game,
- cannot load code from the internet (inline scripts from its own package only), and cannot open pop-ups or navigate the app.

| Permission | Shown as | Service methods it allows |
| --- | --- | --- |
| `project.read` | Read files and settings of the open project | `workspace.inspect`, `workspace.tree`, `workspace.read_file`, `workspace.search`, `workspace.image`, `project.diagnostics`, `project.artifacts`, `assets.validate`, `assets.model`, `assets.blocks`, `registry.index`, `registry.search`, `profile.list`, `instance.list`, `instance.status`, `catalog.list` |
| `project.write` | Create and change files in the open project | `workspace.write_file` |
| `game` | Control the running game: run commands, give items, inspect the world and take screenshots | `game.status`, `game.mods`, `game.telemetry`, `game.reload`, `world.open`, `world.inspect_target`, `world.give_item`, `world.run_command`, `world.entities`, `world.recipes`, `world.tags`, `viewport.capture`, `bridge.status`, and `bridge.call` for the extension's own `ext.<extension id>.*` bridge methods |
| `build` | Build the project and start or stop the game | `project.build`, `project.datagen`, `instance.launch`, `instance.stop`, `instance.hotswap` |
| `network` | Connect to the internet | none; allows `fetch` to `https://` addresses |
| `companion` | Add its companion mod to development runs of the game | none; the jars in `contributes.mods` are added to development runs that also load the Modsmith bridge |

Extensions cannot add service methods, MCP tools or starters yet. They can add features to the game through a companion mod (see [Companion mods](#companion-mods)).

## Writing an extension

An extension is a folder with `extension.json`, a script and any other files it needs. [examples/extensions/project-stats](../examples/extensions/project-stats) is a complete example with a panel and a viewer.

```
my-extension/
  extension.json
  main.js
  style.css
  icons/check.svg
```

### extension.json

```json
{
  "id": "yourname.nbt-viewer",
  "name": "NBT viewer",
  "version": "1.0.0",
  "publisher": "Your Name",
  "description": "Shows the contents of .nbt structure files.",
  "modsmith": "0.1.12",
  "repository": "https://github.com/yourname/modsmith-nbt-viewer",
  "license": "MIT",
  "main": "main.js",
  "style": "style.css",
  "permissions": ["project.read"],
  "contributes": {
    "viewers": [{ "id": "nbt", "title": "NBT data", "files": ["*.nbt"] }],
    "panels": [{ "id": "structures", "title": "Structures" }]
  }
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | `publisher.name` in lowercase letters, digits and dashes. It must never change between versions |
| `name`, `publisher` | yes | Shown in Modsmith (60 characters at most) |
| `version` | yes | `major.minor.patch`, optionally with a pre-release suffix such as `1.2.0-beta.1` |
| `modsmith` | yes | The oldest Modsmith version the extension works with. Older versions refuse to install it |
| `description` | no | Up to 300 characters |
| `repository`, `homepage` | no | `https://` links. `repository` is required for the Verified registry |
| `license` | no | For example `MIT` |
| `main` | when there are viewers or panels | The script, a `.js` file in the package |
| `style` | no | A `.css` file in the package, added to every frame |
| `permissions` | no | Any of the permissions above |
| `contributes.viewers` | no | `id`, `title` and `files`: glob patterns matched against the file's path in the project. `*.nbt` matches in any folder; a pattern with a `/` matches from the project root, and `**/` matches any number of folders |
| `contributes.panels` | no | `id` and `title` |
| `contributes.mods` | no | Companion mods: `file` (a `.jar` in the package), `loader` (`fabric`, `neoforge` or `forge`) and `minecraft` (for example `1.21.1`). Needs the `companion` permission. For Forge, ship the reobfuscated JAR from `build/libs`; Modsmith remaps it for development runs |

If more than one extension has a viewer for a file, the first enabled one in alphabetical order is used.

### The modsmith API

`main.js` runs once in each frame. Register a function for each viewer and panel; Modsmith calls the one the frame was opened for with the frame's root element and its context.

```js
modsmith.registerViewer('nbt', async (root, context) => {
  const file = await modsmith.readFile(context.file);
  root.textContent = `${context.file}: ${file.size} bytes`;
});

modsmith.registerPanel('structures', async (root) => {
  const tree = await modsmith.call('workspace.tree', { dir: 'src/main/resources', depth: 8 });
  root.textContent = `${tree.length} entries`;
});
```

| Member | Description |
| --- | --- |
| `modsmith.context` | `{ kind: 'viewer' or 'panel', contribution, file, extension: { id, name, version }, workspace: { path, name, modId, loader, minecraft } }`. `file` is the project-relative path for viewers |
| `modsmith.call(method, params)` | Calls a service method allowed by the extension's permissions and returns its result. The project path and the game instance are filled in by Modsmith; see `resources/api.json` for each method's parameters and results |
| `modsmith.readFile(file)` | `workspace.read_file` for a project-relative path: `{ path, content, size, binary, mtime }`. Binary files (such as `.nbt`) are returned as base64 |
| `modsmith.writeFile(file, content, options)` | `workspace.write_file`. Pass `{ create: true }` to create a file, `expectedMtime` to refuse overwriting a file that changed on disk, and `{ encoding: 'base64' }` to write bytes (for example an `.nbt` file) |
| `modsmith.asset(file)` | Reads a file from the extension's own package: `{ file, content, binary, size }` |
| `modsmith.openFile(file)` | Opens a project file in a Modsmith tab (needs `project.read`) |
| `modsmith.toast(kind, text)` | Shows a short notice; `kind` is `info`, `success` or `error` |
| `modsmith.showGame()` | Brings the Client tab to the front (needs `game`) |
| `modsmith.onBridgeEvent(fn)` | Called with `(event, data, instanceId)` for bridge events named `ext.<extension id>.*` from this project's running game |
| `modsmith.state.get()`, `modsmith.state.set(value)` | Keeps up to 1 MB of JSON per extension between sessions |
| `modsmith.onFilesChanged(fn)` | Called when files in the project change, for example after saving in the editor |
| `modsmith.onThemeChange(fn)` | Called with the new CSS variables when the Modsmith theme changes |

Files in the package can also be used directly with relative URLs, for example `<img src="icons/check.svg">` or `url(fonts/mono.woff2)` in `style.css`.

### Companion mods

A companion mod adds bridge methods to the game, so an extension can work with code that only exists inside Minecraft. Declare the jar in `contributes.mods` and ask for the `companion` and `game` permissions. When the extension is turned on, Modsmith copies the jar into development runs of matching projects (same loader and Minecraft version) that use the Modsmith bridge.

In the mod, register handlers with the bridge API (compile against `resources/bridge/modsmith-bridge-<loader>-<version>.jar` as a compile-only dependency, and declare a required dependency on `modsmith_bridge`):

```java
Bridge.register("ext.yourname.your-extension.status", params -> CompletableFuture.completedFuture(result));
Bridge.event("ext.yourname.your-extension.changed", data);
```

Method and event names must start with `ext.<extension id>.`. The extension calls them with `modsmith.call('bridge.call', { method, params })`, and Modsmith refuses names outside the extension's own prefix. Bridge calls run with a 20 second timeout and are recorded in the Activity history, so push frequent updates as events instead of polling. Make the companion mod's other dependencies optional, so projects without them still launch.

### Looking like Modsmith

Frames get the current theme as CSS variables on `:root` (such as `--bg`, `--fg`, `--fg-mute`, `--surface`, `--raised`, `--line`, `--accent`, `--err`, `--warn`, `--sans` and `--mono`) and update when the theme changes. Basic styles for the page, buttons (`button` and `button.primary`), inputs and code are included, so an extension that uses plain elements already matches the app.

### Packaging and testing

```bash
node scripts/extensions.mjs pack path/to/my-extension
```

This runs the same checks as Modsmith, writes `<id>-<version>.zip` next to the folder and prints its size, SHA-256 and permissions. Install the `.zip` with **Choose a .zip…** to try it; installing the same id again replaces the earlier version. Packages are limited to 50 MB, 5000 files and 200 MB unpacked, and a `.zip` whose files are inside one top-level folder also works.

For a public extension, attach the `.zip` to a GitHub release so people can install it from the repository link.

## Verified extensions

The Verified list is the [registry](../registry/README.md) in this repository. Publishers submit a version by pull request; anyone with write access to Modsmith approves it by merging after the review checklist in that file. The Website workflow then publishes the list to <https://thegalaxydev.github.io/modsmith/extensions/index.json>, which Modsmith reads (cached for six hours; **Refresh** fetches it again).

Approved entries pin the package's SHA-256, size and permissions. Modsmith refuses a Verified install when the download does not match the hash, when the package's id or version differ from the entry, or when it asks for a permission that was not approved.

## Service methods

| Method | MCP | Description |
| --- | --- | --- |
| `extension.list` | yes | Installed extensions with their manifest, permissions, source, Verified state and whether they are on |
| `extension.catalog` | yes | The Verified registry, with compatibility, installed version and update for each extension |
| `extension.inspect` | no | Reads a package from a file or link without installing it |
| `extension.install` | no | Installs from the registry (Verified) or from an inspected package (Unverified) |
| `extension.remove`, `extension.set_enabled` | no | Uninstall, turn on or off |
| `extension.read` | no | Reads a file from an installed extension's package |

Assistants can see which extensions are installed and available, but cannot install, remove or run them.

`MODSMITH_EXTENSION_INDEX` points the service at another index: an `https://` or `http://127.0.0.1` URL, or a local file path. Tests use it with a local index.
