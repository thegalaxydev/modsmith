import fs from 'node:fs';
import path from 'node:path';
import type { CatalogEntry } from '../shared/types';
import type { DetectedProject, GeneratedFile } from './adapters/types';
import type { Manifest } from './manifest';
import { PRODUCT } from '../shared/product';
import { propOf } from './adapters/fabric';
import { wrapperVersion } from './gradle';
import { COMMON_SOURCES, ROOT_ONLY, compareVersions, fileText, memoryMb, targetBuild, targetFolder, targetProperties } from './multitarget';

export type GitState = 'none' | 'clean' | 'dirty';

export interface AddTargetPlan {
  catalogEntry: string;
  folder: string;
  project: string;
  convert: boolean;
  currentFolder?: string;
  currentPlugin?: { id: string; version: string };
  moves: string[];
  backup: 'git' | 'copy';
  gradle?: { from: string; to: string };
  issues: string[];
}

export interface ScaffoldInfo {
  modId?: string;
  packageName: string;
  author: string;
  description: string;
  license: string;
}

const KEEP = new Set(['gradlew', 'gradlew.bat', 'gradle', 'settings.gradle', 'common', PRODUCT.manifestFile, `${PRODUCT.id}.lock.json`]);
const HEAVY = new Set(['build', '.gradle', 'run', 'runs', 'run-data', 'out', 'bin', 'node_modules']);
const FABRIC_REPO = "\t\tmaven {\n\t\t\tname = 'Fabric'\n\t\t\turl = 'https://maven.fabricmc.net/'\n\t\t}\n";
const FOOJAY = "\tid 'org.gradle.toolchains.foojay-resolver-convention' version '1.0.0'\n";
const ROOT_WRAPPER = "tasks.named('wrapper', Wrapper).configure {\n\tdistributionType = Wrapper.DistributionType.BIN\n}\n";

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function lf(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function pluginRe(id: string): RegExp {
  return new RegExp(`\\bid\\s*\\(?\\s*['"]${esc(id)}['"]\\s*\\)?\\s+version\\s+['"]([^'"\\n]+)['"]`);
}

export function pluginVersion(script: string, id: string): string | undefined {
  return script.match(pluginRe(id))?.[1];
}

function declares(script: string, id: string): boolean {
  return new RegExp(`\\bid\\s*\\(?\\s*['"]${esc(id)}['"]`).test(script);
}

function block(text: string, re: RegExp): { start: number; open: number; close: number } | null {
  const m = re.exec(text);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return { start: m.index, open, close: i };
    }
  }
  return null;
}

function afterBrace(text: string, open: number): number {
  return text[open + 1] === '\n' ? open + 2 : open + 1;
}

export function removeWrapper(text: string): string {
  const b = block(text, /^[ \t]*(?:tasks\.named\(\s*['"]wrapper['"][^)\n]*\)\.configure|wrapper)\s*\{/m);
  if (!b) return text;
  let end = b.close + 1;
  while (text[end] === '\n') end++;
  return text.slice(0, b.start) + text.slice(end);
}

export function convertedBuild(text: string, pluginId: string): string {
  const stripped = removeWrapper(text.replace(pluginRe(pluginId), `id '${pluginId}'`).replace(/from\(\s*['"]LICENSE['"]\s*\)/, 'from(rootProject.file("LICENSE"))'));
  return `${stripped.replace(/\n*$/, '\n')}${COMMON_SOURCES}`;
}

export function withFabricRepos(text: string): string {
  if (text.includes('maven.fabricmc.net')) return text;
  const pm = block(text, /^pluginManagement\s*\{/m);
  if (!pm) return `pluginManagement {\n\trepositories {\n${FABRIC_REPO}\t\tmavenCentral()\n\t\tgradlePluginPortal()\n\t}\n}\n\n${text}`;
  const inner = text.slice(pm.open, pm.close);
  const repos = block(inner, /repositories\s*\{/);
  if (!repos) {
    const at = afterBrace(text, pm.open);
    return `${text.slice(0, at)}\trepositories {\n${FABRIC_REPO}\t\tmavenCentral()\n\t\tgradlePluginPortal()\n\t}\n${text.slice(at)}`;
  }
  const at = afterBrace(text, pm.open + repos.open);
  return `${text.slice(0, at)}${FABRIC_REPO}${inner.includes('mavenCentral()') ? '' : '\t\tmavenCentral()\n'}${text.slice(at)}`;
}

export function withFoojay(text: string): string {
  if (text.includes('foojay-resolver')) return text;
  const pl = block(text, /^plugins\s*\{/m);
  if (pl) {
    const at = afterBrace(text, pl.open);
    return `${text.slice(0, at)}${FOOJAY}${text.slice(at)}`;
  }
  const pm = block(text, /^pluginManagement\s*\{/m);
  const plugins = `plugins {\n${FOOJAY}}\n`;
  if (!pm) return `${plugins}\n${text}`;
  return `${text.slice(0, pm.close + 1)}\n\n${plugins}${text.slice(pm.close + 1).replace(/^\n*/, '\n')}`;
}

export function withInclude(text: string, name: string): string {
  const base = text.trim() ? text.replace(/\n*$/, '\n') : '';
  const last = base.trimEnd().split('\n').pop() ?? '';
  return `${base}${!base || /^\s*include\b/.test(last) ? '' : '\n'}include '${name}'\n`;
}

export function withRootPlugin(text: string, plugin: { id: string; version: string }): string {
  if (declares(text, plugin.id)) return text;
  const line = `\tid '${plugin.id}' version '${plugin.version}' apply false\n`;
  const pl = block(text, /^plugins\s*\{/m);
  if (!pl) return `plugins {\n${line}}\n${text.trim() ? `\n${text}` : `\n${ROOT_WRAPPER}`}`;
  const head = text.slice(0, pl.close);
  return `${head}${head.endsWith('\n') ? '' : '\n'}${line}${text.slice(pl.close)}`;
}

export function mergeRootProperties(root: string, target: string): string {
  const want = target.split('\n').filter((l) => l.startsWith('org.gradle.'));
  const jvm = want.find((l) => l.startsWith('org.gradle.jvmargs='));
  const lines = root ? root.replace(/\n$/, '').split('\n') : [];
  const out: string[] = [];
  let hadJvm = false;
  for (const l of lines) {
    if (l.startsWith('org.gradle.jvmargs=')) {
      hadJvm = true;
      out.push(jvm && memoryMb(jvm) > memoryMb(l) ? jvm : l);
      continue;
    }
    const m = l.match(/^(org\.gradle\.[^=\s]+)\s*=\s*true\s*$/);
    if (m && !want.includes(`${m[1]}=true`)) continue;
    out.push(l);
  }
  if (!hadJvm && jvm) out.unshift(jvm);
  return out.length ? `${out.join('\n')}\n` : '';
}

export function withIgnored(text: string): string {
  const lines = text.split('\n').map((l) => l.trim());
  const missing = ['build', 'run'].filter((x) => ![x, `${x}/`, `**/${x}`, `**/${x}/`].some((v) => lines.includes(v)));
  if (!missing.length) return text;
  return `${text.replace(/\n*$/, '\n')}${missing.map((x) => `${x}/\n`).join('')}`;
}

export function movable(root: string, manifest: Manifest | null): string[] {
  const configDirs = (manifest?.profiles ?? []).map((p) => p.configDir?.split(/[\\/]/)[0]).filter((d): d is string => !!d);
  return fs
    .readdirSync(root)
    .filter((n) => !(n.startsWith('.') || KEEP.has(n) || /^(license|readme)(\.[a-z0-9]+)?$/i.test(n) || configDirs.includes(n)))
    .sort();
}

function currentTarget(root: string, detected: DetectedProject | null, pluginIds: string[]): { folder: string; plugin: { id: string; version: string } } | string {
  if (!detected || detected.loader === 'unknown') return "Modsmith can't tell which loader this project uses, so it can't add a target.";
  const minecraft = propOf(readText(path.join(root, 'gradle.properties')), 'minecraft_version');
  if (!minecraft || !/^[A-Za-z0-9._-]+$/.test(minecraft)) return 'gradle.properties does not declare minecraft_version, so Modsmith has no name for the current target.';
  const build = readText(path.join(root, 'build.gradle'));
  if (!build) return 'The project has no build.gradle in its root folder.';
  if (/^\s*include\b/m.test(readText(path.join(root, 'settings.gradle')))) return 'settings.gradle already includes subprojects. Modsmith can only convert a project that is a single Gradle project.';
  for (const id of pluginIds) {
    const version = pluginVersion(build, id);
    if (version) return { folder: `${detected.loader}-${minecraft}`, plugin: { id, version } };
  }
  return "build.gradle doesn't declare the loader plugin with a version (it may come from a version catalog), so Modsmith can't move it into a subproject.";
}

export function planAddTarget(root: string, manifest: Manifest | null, detected: DetectedProject | null, entry: CatalogEntry, pluginIds: string[], git: GitState): AddTargetPlan {
  const folder = targetFolder(entry);
  const issues: string[] = [];
  const targets = detected?.targets ?? [];
  const convert = targets.length === 0;
  const plan: AddTargetPlan = { catalogEntry: entry.id, folder, project: `:${folder}`, convert, moves: [], backup: git === 'none' ? 'copy' : 'git', issues };
  if (!manifest) issues.push(`This folder has no ${PRODUCT.manifestFile}. Open it as a project in Modsmith first.`);
  if (['build.gradle.kts', 'settings.gradle.kts'].some((f) => fs.existsSync(path.join(root, f)))) issues.push('Projects with Kotlin build scripts (build.gradle.kts) are not supported yet.');
  const wrapper = wrapperVersion(root);
  if (!wrapper) issues.push('The project has no Gradle wrapper.');
  else if (compareVersions(entry.gradleVersion, wrapper) > 0) plan.gradle = { from: wrapper, to: entry.gradleVersion };
  let taken = false;
  if (convert) {
    const cur = currentTarget(root, detected, pluginIds);
    if (typeof cur === 'string') issues.push(cur);
    else {
      plan.currentFolder = cur.folder;
      plan.currentPlugin = cur.plugin;
      plan.moves = movable(root, manifest);
      if (cur.folder === folder) {
        taken = true;
        issues.push(`The project already targets ${entry.loader} ${entry.minecraft}.`);
      } else if (cur.plugin.id === entry.plugin.id && cur.plugin.version !== entry.plugin.version) {
        issues.push(`${entry.id} needs ${entry.plugin.id} ${entry.plugin.version}, but the project uses ${cur.plugin.version}, so they cannot share one Gradle build.`);
      }
      if (fs.existsSync(path.join(root, cur.folder))) issues.push(`A folder named ${cur.folder} already exists in the project.`);
    }
    if (git === 'dirty') issues.push('The project has uncommitted changes. Commit or stash them first, so Git can undo the move if you need to.');
  } else if (targets.some((t) => t.dir.includes('/versions/'))) {
    issues.push('This is a Stonecutter project. Add Minecraft versions in its settings.gradle instead.');
  } else {
    if (targets.some((t) => t.dir === folder)) {
      taken = true;
      issues.push(`The project already has the target ${folder}.`);
    }
    for (const t of targets) {
      const script = readText(path.join(root, t.dir, 'build.gradle'));
      if (pluginVersion(script, entry.plugin.id) !== undefined) issues.push(`${t.dir}/build.gradle sets its own version of ${entry.plugin.id}, so another target cannot share that plugin.`);
    }
    const rootBuild = readText(path.join(root, 'build.gradle'));
    const declared = pluginVersion(rootBuild, entry.plugin.id);
    if (declared !== undefined && declared !== entry.plugin.version) issues.push(`${entry.id} needs ${entry.plugin.id} ${entry.plugin.version}, but the project uses ${declared}, so they cannot share one Gradle build.`);
    if (!block(rootBuild, /^plugins\s*\{/m) && /^buildscript\s*\{/m.test(rootBuild)) issues.push('The root build.gradle uses a buildscript block, so Modsmith cannot add a plugin to it.');
  }
  if (!taken && fs.existsSync(path.join(root, folder))) issues.push(`A folder named ${folder} already exists in the project.`);
  return plan;
}

export function scaffoldInfo(root: string, plan: AddTargetPlan, detected: DetectedProject | null, manifest: Manifest | null): ScaffoldInfo {
  const dir = plan.convert ? root : path.join(root, detected?.targets?.[0]?.dir ?? '.');
  const props = readText(path.join(dir, 'gradle.properties'));
  const modId = manifest?.modId ?? detected?.modMetadata.find((m) => m.id)?.id ?? propOf(props, 'mod_id');
  const pkg = mainPackage([path.join(dir, 'src', 'main', 'java'), path.join(root, 'common', 'src', 'main', 'java')]) ?? propOf(props, 'mod_group_id') ?? propOf(props, 'maven_group') ?? `com.example.${modId ?? 'mod'}`;
  return { modId, packageName: pkg, author: propOf(props, 'mod_authors') ?? '', description: propOf(props, 'mod_description') ?? manifest?.name ?? '', license: propOf(props, 'mod_license') ?? 'All Rights Reserved' };
}

function mainPackage(dirs: string[]): string | undefined {
  let best: { pkg: string; score: number; depth: number } | undefined;
  const walk = (d: string, level: number) => {
    if (level > 12) return;
    let names: string[];
    try {
      names = fs.readdirSync(d).sort();
    } catch {
      return;
    }
    for (const n of names) {
      const full = path.join(d, n);
      let dir = false;
      try {
        dir = fs.statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (dir) walk(full, level + 1);
      else if (n.endsWith('.java')) {
        const text = readText(full);
        const pkg = text.match(/^\s*package\s+([\w.]+)\s*;/m)?.[1];
        if (!pkg) continue;
        const score = /@Mod\s*\(|implements\s+(?:Client)?ModInitializer|\bMOD_ID\b/.test(text) ? 2 : 1;
        const depth = pkg.split('.').length;
        if (!best || score > best.score || (score === best.score && depth < best.depth)) best = { pkg, score, depth };
      }
    }
  };
  for (const d of dirs) walk(d, 0);
  return best?.pkg;
}

function copyTree(src: string, dest: string): void {
  let dir = false;
  try {
    dir = fs.statSync(src).isDirectory();
  } catch {
    return;
  }
  if (!dir) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    return;
  }
  for (const n of fs.readdirSync(src)) if (!HEAVY.has(n)) copyTree(path.join(src, n), path.join(dest, n));
}

export function backupFiles(root: string, plan: AddTargetPlan, stamp: number): string {
  const rel = `${PRODUCT.stateDir}/backups/add-target-${stamp}`;
  const dest = path.join(root, rel);
  const names = plan.convert ? [...plan.moves, 'settings.gradle', PRODUCT.manifestFile] : ['settings.gradle', 'build.gradle', 'gradle.properties', 'gradle/wrapper/gradle-wrapper.properties', '.gitignore', PRODUCT.manifestFile];
  for (const n of names) if (!HEAVY.has(n)) copyTree(path.join(root, n), path.join(dest, n));
  fs.mkdirSync(dest, { recursive: true });
  return rel;
}

function moveAll(root: string, names: string[], folder: string): void {
  fs.mkdirSync(path.join(root, folder));
  const done: string[] = [];
  for (const n of names) {
    try {
      fs.renameSync(path.join(root, n), path.join(root, folder, n));
      done.push(n);
    } catch (err) {
      for (const m of done.reverse()) {
        try {
          fs.renameSync(path.join(root, folder, m), path.join(root, m));
        } catch {
          void 0;
        }
      }
      try {
        fs.rmdirSync(path.join(root, folder));
      } catch {
        void 0;
      }
      throw new Error(`Could not move ${n} into ${folder}: ${(err as Error).message}. Nothing was changed. Close programs that have project files open, such as an IDE, and try again.`);
    }
  }
}

function edit(root: string, rel: string, fn: (text: string) => string): void {
  const full = path.join(root, rel);
  const exists = fs.existsSync(full);
  const before = exists ? fs.readFileSync(full, 'utf8') : '';
  const crlf = before.includes('\r\n');
  const out = fn(lf(before));
  if (!exists && !out) return;
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, crlf ? out.replace(/\n/g, '\r\n') : out);
}

export function applyAddTarget(root: string, plan: AddTargetPlan, entry: CatalogEntry, files: GeneratedFile[], modId: string): void {
  if (plan.convert) {
    const cur = plan.currentFolder!;
    const plugin = plan.currentPlugin!;
    moveAll(root, plan.moves, cur);
    edit(root, `${cur}/build.gradle`, (t) => convertedBuild(t, plugin.id));
    const props = path.join(root, cur, 'gradle.properties');
    if (fs.existsSync(props)) {
      const own = fs.readFileSync(props, 'utf8');
      const lines = lf(own).split('\n').filter((l) => l.startsWith('org.gradle.'));
      edit(root, `${cur}/gradle.properties`, targetProperties);
      if (lines.length) fs.writeFileSync(path.join(root, 'gradle.properties'), (own.includes('\r\n') ? lines.join('\r\n') + '\r\n' : lines.join('\n') + '\n'));
    }
    fs.writeFileSync(path.join(root, 'build.gradle'), `plugins {\n\tid '${plugin.id}' version '${plugin.version}' apply false\n}\n\n${ROOT_WRAPPER}`);
    edit(root, 'settings.gradle', (t) => withInclude(t, cur));
  }
  edit(root, 'settings.gradle', (t) => withInclude(entry.loader === 'fabric' ? withFabricRepos(t) : withFoojay(t), plan.folder));
  edit(root, 'build.gradle', (t) => withRootPlugin(t, entry.plugin));
  const own = files.find((f) => f.path === 'gradle.properties');
  edit(root, 'gradle.properties', (t) => mergeRootProperties(t, own ? fileText(own) : ''));
  if (plan.gradle) {
    const to = plan.gradle.to;
    edit(root, 'gradle/wrapper/gradle-wrapper.properties', (t) => t.replace(/gradle-[\d.]+(?:-[a-z0-9-]+)?-(bin|all)\.zip/, `gradle-${to}-$1.zip`).replace(/^distributionSha256Sum=.*\n?/m, ''));
  }
  for (const f of files) {
    if (ROOT_ONLY.has(f.path)) continue;
    const content = f.path === 'gradle.properties' ? targetProperties(fileText(f)) : f.path === 'build.gradle' ? targetBuild(fileText(f), entry, modId) : f.content;
    const full = path.join(root, plan.folder, f.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  if (fs.existsSync(path.join(root, '.gitignore'))) edit(root, '.gitignore', withIgnored);
}
