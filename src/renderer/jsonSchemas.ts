import { getLanguageService, type Diagnostic, type JSONDocument, type LanguageService } from 'vscode-json-languageservice';
import { TextDocument } from 'vscode-languageserver-textdocument';
import projectSchemas from '../../resources/schemas.json';

const vendored = import.meta.glob<Record<string, unknown>>('./jsonschemas/schemastore/*.json', { import: 'default' });

const STORE = 'https://www.schemastore.org/';
const STORE_HOSTS = [STORE, 'https://json.schemastore.org/', 'http://json.schemastore.org/'];
const PROJECT = 'modsmith://schemas/';

export interface SchemaInfo {
  uri: string;
  label: string;
  checked: boolean;
}

const store = (name: string, label: string, checked = true): SchemaInfo => ({ uri: STORE + name, label, checked });
const hints = (name: string, label: string): SchemaInfo => store(name, label, false);
const project = (key: keyof typeof projectSchemas, label: string): SchemaInfo => ({ uri: `${PROJECT}${key}.json`, label, checked: true });

const DATA = String.raw`(?:^|/)data/[^/]+/`;
const ASSETS = String.raw`(?:^|/)assets/[^/]+/`;
const re = (s: string) => new RegExp(s);

const RULES: [RegExp, SchemaInfo][] = [
  [/(?:^|\/)modsmith\.json$/, project('manifest', 'Modsmith project')],
  [/(?:^|\/)profiles\/[^/]+\/profile\.json$/, project('profile', 'Modsmith profile')],
  [/(?:^|\/)scenarios\/[^/]+\.json$/, project('scenario', 'Modsmith scenario')],
  [/(?:^|\/)modrinth\.index\.json$/, project('mrpackIndex', 'Modrinth pack index')],
  [/(?:^|\/)fabric\.mod\.json$/, store('fabric.mod.json', 'Fabric mod metadata')],
  [/\.mixins\.json$/, store('sponge-mixins.json', 'Mixin configuration')],
  [/(?:^|\/)pack\.mcmeta$/, store('minecraft-pack-mcmeta.json', 'Pack metadata')],
  [re(ASSETS + String.raw`lang/[^/]+\.json$`), store('minecraft-lang.json', 'Language file')],
  [re(ASSETS + String.raw`textures/.+\.png\.mcmeta$`), hints('minecraft-texture-mcmeta.json', 'Texture metadata')],
  [re(ASSETS + String.raw`particles/[^/]+\.json$`), store('minecraft-particle.json', 'Particle')],
  [re(DATA + String.raw`advancements?/.+\.json$`), store('minecraft-advancement.json', 'Advancement')],
  [re(DATA + String.raw`recipes?/.+\.json$`), hints('minecraft-recipe.json', 'Recipe')],
  [re(DATA + String.raw`loot_tables?/.+\.json$`), hints('minecraft-loot-table.json', 'Loot table')],
  [re(DATA + String.raw`item_modifiers?/.+\.json$`), hints('minecraft-item-modifier.json', 'Item modifier')],
  [re(DATA + String.raw`predicates?/.+\.json$`), hints('minecraft-predicate.json', 'Predicate')],
  [re(DATA + String.raw`tags/.+\.json$`), store('minecraft-tag.json', 'Tag')],
  [re(DATA + String.raw`damage_type/[^/]+\.json$`), store('minecraft-damage-type.json', 'Damage type')],
  [re(DATA + String.raw`dimension_type/[^/]+\.json$`), store('minecraft-dimension-type.json', 'Dimension type')],
  [re(DATA + String.raw`dimension/[^/]+\.json$`), hints('minecraft-dimension.json', 'Dimension')],
  [re(DATA + String.raw`worldgen/biome/.+\.json$`), hints('minecraft-biome.json', 'Biome')],
  [re(DATA + String.raw`worldgen/configured_carver/.+\.json$`), hints('minecraft-configured-carver.json', 'Configured carver')],
  [re(DATA + String.raw`worldgen/template_pool/.+\.json$`), store('minecraft-template-pool.json', 'Template pool')],
  [re(DATA + String.raw`trim_material/[^/]+\.json$`), store('minecraft-trim-material.json', 'Trim material')],
  [re(DATA + String.raw`trim_pattern/[^/]+\.json$`), store('minecraft-trim-pattern.json', 'Trim pattern')]
];

export const SCHEMAS = [...new Map(RULES.map(([, s]) => [s.uri, s])).values()];

export function isJsonFile(file: string): boolean {
  return /\.(json|mcmeta)$/i.test(file);
}

export function schemaFor(file: string): SchemaInfo | null {
  const norm = file.replace(/\\/g, '/');
  for (const [pattern, info] of RULES) if (pattern.test(norm)) return info;
  return null;
}

export function documentUri(file: string): string {
  const schema = schemaFor(file);
  const slot = schema ? `s${SCHEMAS.indexOf(schema)}` : 'none';
  return `file:///modsmith/${slot}/${encodeURI(file.replace(/\\/g, '/'))}`;
}

async function loadSchema(uri: string): Promise<string> {
  if (uri.startsWith(PROJECT)) {
    const key = uri.slice(PROJECT.length).replace(/\.json(#.*)?$/, '') as keyof typeof projectSchemas;
    const schema = projectSchemas[key];
    if (schema) return JSON.stringify(schema);
  }
  const host = STORE_HOSTS.find((h) => uri.startsWith(h));
  if (host) {
    const name = uri.slice(host.length).split('#')[0];
    const load = vendored[`./jsonschemas/schemastore/${name}`];
    if (load) return JSON.stringify(await load());
  }
  throw new Error(`Schema ${uri} is not bundled with Modsmith`);
}

let service: LanguageService | null = null;

export function jsonService(): LanguageService {
  if (service) return service;
  service = getLanguageService({
    schemaRequestService: loadSchema,
    workspaceContext: { resolveRelativePath: (relative, resource) => new URL(relative, resource).toString() }
  });
  service.configure({
    validate: true,
    allowComments: false,
    schemas: SCHEMAS.map((s, i) => ({ uri: s.uri, fileMatch: ['*'], folderUri: `file:///modsmith/s${i}/` }))
  });
  return service;
}

export function parse(file: string, text: string, version = 1): { doc: TextDocument; json: JSONDocument } {
  const doc = TextDocument.create(documentUri(file), 'json', version, text);
  return { doc, json: jsonService().parseJSONDocument(doc) };
}

export async function validateJson(file: string, text: string): Promise<Diagnostic[]> {
  const { doc, json } = parse(file, text);
  const checked = schemaFor(file)?.checked ?? true;
  return jsonService().doValidation(doc, json, { comments: 'error', trailingCommas: 'error', schemaValidation: checked ? 'warning' : 'ignore', schemaRequest: 'warning' });
}
