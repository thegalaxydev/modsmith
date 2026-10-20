# Editor

The built-in editor is CodeMirror 6 with syntax highlighting for Java, JSON, TOML, Gradle and properties files.

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
- Completion of registry IDs (items, blocks, tags) from the running game or the Minecraft jar.
- Java, TOML and Gradle language servers.
