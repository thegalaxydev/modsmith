# Editor

The built-in editor is CodeMirror 6 with syntax highlighting for Java, JSON, TOML, Gradle and properties files. Its colors come from the code theme; see [Themes](themes.md).

## Completion

Suggestions appear in a popup as you type. Arrow keys move through them, Tab or Enter accepts one, and Escape closes the popup. Where they come from depends on the file:

| Files | Source |
| --- | --- |
| `.java` | The Eclipse JDT Language Server (jdtls), the language server behind VS Code's Java support: members, types, imports, method snippets with parameters, hover, signature help and diagnostics from the project's real Gradle classpath (Minecraft, the loader and every dependency) |
| `.json`, `.mcmeta` | The JSON language service and bundled schemas (see JSON help below) |
| TOML, Gradle, properties, `.lang`, `.cfg`, text and Markdown | Words already in the file |

### Java language server

Java files show a banner until Java completion is on. **Turn on** (or **Trust and turn on** for a project that is not trusted yet) does the one-time setup; **Not now** hides the banner and leaves a small **Set up Java completion** button in the editor bar. Setup:

- jdtls (about 51 MB) is downloaded from download.eclipse.org and checked against the SHA-256 pinned in `resources/lsp.json` before it is unpacked into the data folder (`lsp/jdtls-<version>`).
- It runs on the newest installed Java at or above `javaMin` (Java 25 for jdtls 1.62).
- It imports the project through Gradle, which runs the project's build scripts, so the project must be trusted first.
- The import uses the same JDK Modsmith uses for Gradle builds. The first import of a project takes a minute or so; later starts reuse the server's workspace in `lsp/workspaces`.

Once installed, the server starts as soon as a trusted Gradle project opens, so it has usually finished loading the project by the time a Java file is opened; a thin line under the editor bar shows while it is still loading. Requests may take up to two minutes during a first import. If the server stops, a banner offers **Restart**. Servers are stopped with the LSP shutdown and exit messages and only killed if they do not exit within a few seconds, which keeps their workspace clean for the next start.

The service starts one server per project (`lsp.start`) and relays JSON-RPC messages between it and the editor (`lsp.send` and `lsp.message` events); the editor side is `@codemirror/lsp-client`. Eclipse metadata (`.project`, `.classpath`, `.settings`) is kept in the server's workspace, not in the project. The Gradle import itself still writes Eclipse launch configurations to `.eclipse/` (NeoForge's ModDevGradle) and compiles to `bin/`; generated projects ignore both in `.gitignore`.

### Navigation

With the Java language server running:

| Action | Keys |
| --- | --- |
| Go to definition | Ctrl+click (Cmd+click on macOS) or F12. Holding Ctrl or Cmd underlines the symbol under the pointer and, after a moment, shows a peek of its definition |
| Find references | Shift+F12, which opens a list under the editor. Clicking an entry opens that file at the reference. Files that are not open are read for the list, so references across the project are shown |
| Documentation on hover | Hover any symbol |

Definitions in the project open in a normal editor tab at the right line and column.

Definitions in libraries (Minecraft, NeoForge, Fabric, other mods, the JDK) open in a read-only tab. jdtls supplies the source through `java/classFileContents` for its `jdt://` URIs: the editor turns on `classFileContentsSupport`, and Gradle sources jars are downloaded during the import. The tab:

- shows the class's package and name, where it came from (the JAR, or the JDK module), and whether it is source or decompiled;
- supports Ctrl+click, F12, Shift+F12 and hover from there on;
- never writes to disk.

Where the source comes from:

- NeoForge (ModDevGradle) attaches Minecraft sources automatically.
- Libraries with a sources jar (for example DataFixerUpper) and the JDK (from its `src.zip`) show real source.
- Fabric Loom only has Minecraft sources after its `genSources` task. Until then, jdtls decompiles classes on the fly and the tab says so. Its **Generate sources** button runs `genSources` once and reloads the project in the language server.

## Debugging

Java code in development runs can be debugged in the app. Debugging uses Microsoft's Java Debug Server (the engine behind VS Code's Java debugger) as a plugin of the Java language server.
- The plugin is about 3 MB. It is downloaded once from Maven Central and checked against the SHA-256 pinned in `resources/lsp.json`.
- The first **Start debugging** installs it and restarts Java support.

**Breakpoints**
- Click in the gutter left of the line numbers in a Java file to set or remove a breakpoint.
- Breakpoints are kept per project, can be set before or during a session, and are listed in the Debug panel.

**Starting**
- The run needs its debug port. Turn on **Hot reload and debugger** for the run configuration.
- While such a development run is going, the toolbar shows a debug button that opens the **Debug** panel. **Start debugging** attaches to the run on its debug port.
- When several runs are going (for example a multiplayer test session), the panel asks which one.

**While paused**
- The panel shows the threads, the call stack and the variables of the selected frame.
- Click a frame to open its source. Project files open at the line; library classes open in the read-only source tabs (see Navigation above).
- Objects expand to their fields.
- **Evaluate** runs a Java expression in the selected frame, for example `player.getName()` or `server.getTickCount()`.
- The editor marks the current line.

**Controls**

| Action | Key |
| --- | --- |
| Continue | F5 |
| Step over | F10 |
| Step into | F11 |
| Step out | Shift+F11 |
| Stop debugging | Shift+F5 |

**Stopping:** Stop debugging detaches and leaves the game running.

**Hot reload:** the debug port takes one debugger connection at a time, so **Apply changes** asks you to stop debugging first.

**How it works**
- `vscode.java.startDebugSession` starts a debug adapter inside the language server.
- The service relays Debug Adapter Protocol messages between the adapter and the app (`debug.connect`, `debug.send`, `debug.disconnect`, and the `debug.message` and `debug.closed` events).
- The adapter attaches to the game over JDWP.

## Registry IDs in JSON

Inside JSON strings that hold a game ID, the editor suggests item, block and entity type IDs with their English names, and item, block, entity type and fluid tags with how many entries they have. Hover an ID to see its name, registry and where it comes from. Hover a tag to see its entries.

The registry is chosen from the file and the property:

| Where | Suggests |
| --- | --- |
| `values` in `data/*/tags/<registry>/…` | IDs and `#tags` of that registry |
| `item`, `result`, `result.id`, `icon` | Items |
| `items`, `ingredient`, `ingredients`, `base`, `addition`, `template`, `input`, and string ingredients in a recipe `key` | Items and `#item tags` |
| `tag` | Tags without `#`: block tags under block or location predicates, entity tags under entity predicates, otherwise item tags |
| Loot entries: `name` next to `"type": "minecraft:item"` or `"minecraft:tag"` | Items or item tags |
| `block`, `blocks`, `Name` | Blocks (and `#block tags` for `blocks`) |
| `entity_type`, `entity_types`, `type` inside `entity`, `this`, `killer` and other entity predicates | Entity types and `#entity tags` |
| `fluid`, `fluids` | Fluid tags |

The IDs come from `registry.index`, which reads, without starting the game:

1. The vanilla client jar for the project's Minecraft version. It is downloaded once from Mojang and checked against its SHA-1; the first lookup starts a "Download Minecraft <version> data" task and completion fills in when it finishes.
2. The project's own `src/*/resources` and `src/*/generated` folders.
3. Resolved profile mods that are already downloaded.
4. The JARs on the development launch classpath, which includes Fabric API or NeoForge and their `c:` convention tags.

Items are taken from item definitions (`assets/*/items`, Minecraft 1.21.4 and later), or else from item names in `en_us.json` that have an item model. Blocks are taken from blockstates, entity types from entity names, and tags from `data/*/tags`.

Checked against a running Fabric 1.21.1 server, the index matched the game's registries exactly: 1,333 items, 1,060 blocks, and 419 item, 301 block and 39 entity type tags. The only extra was one entity type, `minecraft:killer_bunny`, which is a rabbit name in the language file.

When the game runs with the bridge connected, suggestions also include matching entries from the live registries (`registry.search`, `world.tags`). That adds whatever mods register in code without language or model files.

## Asset checks and model preview

Modsmith checks the project's resources (`src/*/resources` and `src/*/generated`) with `assets.validate`. Problems appear in the Problems panel under the source "assets", with a link to the file and line. The open file is also checked as you type, including unsaved changes, and its problems are underlined in the editor.

| Where | Check | Severity |
| --- | --- | --- |
| Any JSON file | Not valid JSON | Error |
| `assets/*/models/**` | The `parent` model does not exist, or a texture does not exist (`assets/<ns>/textures/<path>.png`) | Error |
| `assets/*/blockstates/*`, `assets/*/items/*` | A referenced model does not exist | Error |
| Blockstates, item definitions, item models | The block or item has no English name in `en_us.json` | Warning |
| `assets/*/lang/en_us.json` | An item has a name but no item model (or item definition from Minecraft 1.21.4) | Warning |
| `data/**` (recipes, tags, loot tables, advancements, predicates and others) | Unknown item, block or entity type ID, unknown tag, a tag where only an ID is allowed, or an ID that is not valid | Warning or error |
| `data/**` | A namespace that no mod provides, which usually means a typo | Info |

Models, textures, names and IDs are looked up in the same sources as completion: vanilla Minecraft, the project, resolved mods and the development classpath (see Registry IDs above). Optional tag entries (`"required": false`) are not checked. Until the vanilla data for the project's Minecraft version has downloaded, only JSON syntax is checked, and the Problems panel says so.

Model, blockstate and item definition files show a preview beside the editor:

- Blocks are drawn the way the inventory shows them, using the model's GUI rotation, per-face UVs and rotations, element rotations, side shading and the grass/foliage tint. The parent chain is listed under the preview.
- Items whose models extend `item/generated` are drawn as flat sprites from their layers. Animated textures use their first frame.
- Missing parents and textures are listed and drawn in magenta. Models drawn in code (`builtin/entity`, for example chests and beds) have no preview.

The preview follows the saved file. It was checked against vanilla 1.21.1 models: furnace (front on the left, as in the inventory), grass block, oak stairs, torch and lantern.

## JSON help

JSON files and `.mcmeta` files get help from Microsoft's JSON language service (`vscode-json-languageservice`, the engine behind VS Code's JSON support), running inside the interface:

- Completion of property names, enum values and default snippets (Ctrl+Space, or as you type a quote).
- Hover text from the schema's descriptions.
- Syntax errors (red) and schema problems (yellow) underlined as you type.

The schema is chosen from the file's path (`src/renderer/jsonSchemas.ts`):

| Files | Schema | Level |
| --- | --- | --- |
| `modsmith.json`, `profiles/*/profile.json`, `scenarios/*.json`, `modrinth.index.json` | Modsmith's own schemas, generated from the service's definitions (`resources/schemas.json`) | Checked |
| `fabric.mod.json`, `*.mixins.json`, `pack.mcmeta` | SchemaStore | Checked |
| `assets/*/lang/*.json`, `assets/*/particles/*.json` | SchemaStore | Checked |
| `data/*/advancement/`, `tags/`, `damage_type/`, `dimension_type/`, `trim_material/`, `trim_pattern/`, `worldgen/template_pool/` | SchemaStore | Checked |
| `data/*/recipe/`, `loot_table/`, `item_modifier/`, `predicate/`, `dimension/`, `worldgen/biome/`, `worldgen/configured_carver/`, `assets/*/textures/**/*.png.mcmeta` | SchemaStore | Hints only |

Both the singular folder names used since Minecraft 1.21 (`recipe`, `loot_table`, `advancement`) and the older plural ones are recognised.

"Checked" schemas were validated against every matching file in vanilla Minecraft 1.21.1 (about 2,300 files) without a single false warning. "Hints only" schemas lag behind current Minecraft: the recipe schema predates the 1.20 smithing recipes and the special crafting types, the loot table, biome and carver schemas use number formats Minecraft replaced, and the texture metadata schema requires an `animation` section that not every texture has. For those files the editor offers their completions and hover text but does not show their warnings, so valid files are never flagged. The editor bar shows which schema applies and whether it is "(hints)".

The editor bar still runs the older save-time checks for `fabric.mod.json`, lang files, recipes, loot tables and tags.

### Schemas are bundled

All schemas ship with Modsmith; nothing is downloaded while editing. To refresh the SchemaStore copies:

```bash
node scripts/fetch-schemas.mjs
```

The script downloads each schema and every schema it references into `src/renderer/jsonschemas/schemastore`. Re-check the vanilla results before promoting a schema from hints to checked.

### Not covered yet

- Version-specific data: the schemas describe one generation of the formats, not the project's Minecraft version.
- Block states, block and item models, item model definitions and `sounds.json` have no schema yet.
- Registry completion for other registries (enchantments, biomes, sounds, recipe types, models and textures). Items, blocks, entity types and tags are covered (see Registry IDs above).
- TOML and Gradle language servers; those files get word completion only.
