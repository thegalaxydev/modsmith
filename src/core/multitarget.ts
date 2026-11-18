import type { CatalogEntry } from '../shared/types';
import type { GeneratedFile, ProjectTarget } from './adapters/types';
import type { CompatibilityCatalog } from './catalog';
import type { ModRef } from './manifest';
import { toClassName } from './validation';

export interface TargetPart {
  entry: CatalogEntry;
  files: GeneratedFile[];
}

export interface MultiOptions {
  projectName: string;
  modId: string;
  packageName: string;
  description: string;
}

export const LOADER_NAME: Record<string, string> = { fabric: 'Fabric Loader', neoforge: 'NeoForge', forge: 'Forge' };
export const ROOT_ONLY = new Set(['settings.gradle', 'gradle/wrapper/gradle-wrapper.properties', '.gitignore', 'README.md', 'LICENSE']);

export function targetFolder(entry: CatalogEntry): string {
  return `${entry.loader}-${entry.minecraft}`;
}

export function pluginConflict(entries: CatalogEntry[]): string | null {
  const seen = new Map<string, CatalogEntry>();
  for (const e of entries) {
    const prev = seen.get(e.plugin.id);
    if (prev && prev.plugin.version !== e.plugin.version) return `${prev.id} and ${e.id} need different versions of ${e.plugin.id} (${prev.plugin.version} and ${e.plugin.version}), so they cannot share one Gradle build`;
    if (!prev) seen.set(e.plugin.id, e);
  }
  return null;
}

export function targetJavaMin(catalog: CompatibilityCatalog, targets: ProjectTarget[]): number {
  return Math.max(0, ...targets.map((t) => catalog.select(t.loader, t.minecraft, { allowUnverified: true })?.gradleJavaMin ?? 0));
}

export function unpinned(ref: ModRef): ModRef {
  if (ref.source === 'modrinth') {
    const { versionId: _v, ...rest } = ref;
    return rest;
  }
  if (ref.source === 'curseforge') {
    const { fileId: _f, ...rest } = ref;
    return rest;
  }
  return ref;
}

export function newestGradle(entries: CatalogEntry[]): string {
  return [...entries].sort((a, b) => compareVersions(b.gradleVersion, a.gradleVersion))[0].gradleVersion;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export function fileText(f: GeneratedFile): string {
  return typeof f.content === 'string' ? f.content : f.content.toString('utf8');
}

export function memoryMb(line: string): number {
  const m = line.match(/-Xmx(\d+)([gGmM])/);
  return m ? Number(m[1]) * (m[2].toLowerCase() === 'g' ? 1024 : 1) : 0;
}

function rootProperties(parts: TargetPart[]): string {
  const perPart = parts.map((p) => {
    const props = fileText(p.files.find((f) => f.path === 'gradle.properties') ?? { path: '', content: '' });
    return props.split('\n').filter((l) => l.startsWith('org.gradle.'));
  });
  const jvm = perPart.map((lines) => lines.find((l) => l.startsWith('org.gradle.jvmargs=')) ?? '').sort((a, b) => memoryMb(b) - memoryMb(a))[0];
  const keys: string[] = [];
  for (const lines of perPart) for (const l of lines) {
    const key = l.split('=')[0];
    if (key !== 'org.gradle.jvmargs' && !keys.includes(key)) keys.push(key);
  }
  const shared = keys.filter((k) => perPart.every((lines) => lines.includes(`${k}=true`)));
  return [...(jvm ? [jvm] : []), ...shared.map((k) => `${k}=true`)].join('\n') + '\n';
}

export function targetProperties(content: string): string {
  return content.split('\n').filter((l) => !l.startsWith('org.gradle.')).join('\n').replace(/^\n+/, '');
}

export function targetBuild(content: string, entry: CatalogEntry, id: string): string {
  const pid = entry.plugin.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stripped = content
    .replace(new RegExp(`(\\bid\\s+'${pid}')\\s+version\\s+(?:"[^"\\n]*"|'[^'\\n]*')`), '$1')
    .replace('from("LICENSE")', 'from(rootProject.file("LICENSE"))')
    .replace(/tasks\.named\('wrapper', Wrapper\)\.configure \{[^}]*\}\n+/, '');
  return `${stripped.replace(/\n*$/, '\n')}${COMMON_SOURCES}
base {
\tarchivesName = '${id}-${targetFolder(entry)}'
}
`;
}

export const COMMON_SOURCES = `
sourceSets {
\tmain {
\t\tjava {
\t\t\tsrcDir rootProject.file('common/src/main/java')
\t\t}
\t\tresources {
\t\t\tsrcDir rootProject.file('common/src/main/resources')
\t\t}
\t}
}

tasks.named('processResources') {
\tduplicatesStrategy = DuplicatesStrategy.EXCLUDE
}
`;

export function composeTargets(opts: MultiOptions, parts: TargetPart[]): GeneratedFile[] {
  const conflict = pluginConflict(parts.map((p) => p.entry));
  if (conflict) throw new Error(conflict);
  const out: GeneratedFile[] = [];
  const first = parts[0];
  const folders = parts.map((p) => targetFolder(p.entry));
  const fabric = parts.some((p) => p.entry.loader === 'fabric');
  const modded = parts.some((p) => p.entry.loader !== 'fabric');
  const plugins: CatalogEntry['plugin'][] = [];
  for (const p of parts) if (!plugins.some((x) => x.id === p.entry.plugin.id)) plugins.push(p.entry.plugin);
  const newest = [...parts].sort((a, b) => compareVersions(b.entry.gradleVersion, a.entry.gradleVersion))[0];
  const gradleJava = Math.max(...parts.map((p) => p.entry.gradleJavaMin));

  out.push({
    path: 'settings.gradle',
    content: `pluginManagement {
\trepositories {
${fabric ? "\t\tmaven {\n\t\t\tname = 'Fabric'\n\t\t\turl = 'https://maven.fabricmc.net/'\n\t\t}\n\t\tmavenCentral()\n" : ''}\t\tgradlePluginPortal()
\t}
}
${modded ? "\nplugins {\n\tid 'org.gradle.toolchains.foojay-resolver-convention' version '1.0.0'\n}\n" : ''}
rootProject.name = '${opts.modId}'

include ${folders.map((f) => `'${f}'`).join(', ')}
`
  });
  out.push({ path: 'build.gradle', content: `plugins {\n${plugins.map((p) => `\tid '${p.id}' version '${p.version}' apply false`).join('\n')}\n}\n\ntasks.named('wrapper', Wrapper).configure {\n\tdistributionType = Wrapper.DistributionType.BIN\n}\n` });
  out.push({ path: 'gradle.properties', content: rootProperties(parts) });
  for (const name of ['gradle/wrapper/gradle-wrapper.properties', '.gitignore', 'LICENSE']) {
    const src = (name.startsWith('gradle/') ? newest : first).files.find((f) => f.path === name);
    if (src) out.push({ path: name, content: src.content });
  }
  const list = parts.map((p) => `- \`${targetFolder(p.entry)}\`: ${LOADER_NAME[p.entry.loader] ?? p.entry.loader} ${p.entry.loaderVersion} on Minecraft ${p.entry.minecraft}`).join('\n');
  out.push({
    path: 'README.md',
    content: `# ${opts.projectName}\n\n${opts.description}\n\nThis project builds the mod for several loaders and Minecraft versions. Each target is a Gradle subproject:\n\n${list}\n\nCode in \`common/src/main/java\` and files in \`common/src/main/resources\` are compiled into every target, so they must work on all of them. A file in a target's own \`src/main/resources\` replaces the common file at the same path.\n\nGenerated by Modsmith from catalog entries ${parts.map((p) => `\`${p.entry.id}\``).join(', ')}.\n\nBuild every target with \`./gradlew build\`, or one with \`./gradlew :${folders[0]}:build\`. Gradle must run on Java ${gradleJava} or newer.\n`
  });
  const cls = `${toClassName(opts.projectName)}Common`;
  out.push({
    path: `common/src/main/java/${opts.packageName.replace(/\./g, '/')}/${cls}.java`,
    content: `package ${opts.packageName};\n\npublic final class ${cls} {\n\tpublic static final String MOD_ID = "${opts.modId}";\n\n\tprivate ${cls}() {\n\t}\n}\n`
  });

  for (const p of parts) {
    const folder = targetFolder(p.entry);
    for (const f of p.files) {
      if (ROOT_ONLY.has(f.path)) continue;
      const content = f.path === 'gradle.properties' ? targetProperties(fileText(f)) : f.path === 'build.gradle' ? targetBuild(fileText(f), p.entry, opts.modId) : f.content;
      out.push({ ...f, path: `${folder}/${f.path}`, content });
    }
  }
  return out;
}
