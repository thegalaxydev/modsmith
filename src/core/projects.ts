import fs from 'node:fs';
import path from 'node:path';
import type { Diagnostic, OperationInfo } from '../shared/types';
import { PRODUCT } from '../shared/product';
import type { Services } from './context';
import type { WorkspaceService } from './workspace';
import { stateDir } from './workspace';
import { assertGeneratable, isGeneratable } from './catalog';
import { validateScaffold } from './validation';
import type { ScaffoldOptions } from './adapters/types';
import { ManifestSchema, ModRefSchema, ProfileSchema, writeManifest, readManifest, type Manifest, type ModRef } from './manifest';
import { runGradle, wrapperPath, wrapperVersion } from './gradle';
import { execCapture } from './proc';
import { installHint } from './java';
import { downloadVerified } from './http';
import { readJarMetadata, allModIds } from './jarmeta';
import { pickVersion, primaryFile } from './modrinth';
import { cfDistributable, pickCfFile } from './curseforge';
import type { OpContext } from './operations';

export interface CreateProjectInput extends Omit<ScaffoldOptions, 'resolvedDependencyModIds' | 'mavenCoordinates'> {
  runInitialBuild: boolean;
  presetId?: string;
}

export interface DependencyPlanItem {
  ref: ModRef;
  title: string;
  status: 'ok' | 'error' | 'warning';
  detail: string;
  coordinates?: string;
  versionNumber?: string;
}

export class ProjectService {
  constructor(private s: Services, private ws: WorkspaceService) {}

  validateCreate(input: CreateProjectInput): { issues: { field: string; message: string }[] } {
    const issues = validateScaffold(input);
    const entry = this.s.catalog.get(input.catalogEntryId);
    if (!entry) issues.push({ field: 'catalogEntryId', message: `Unknown catalog entry ${input.catalogEntryId}` });
    else {
      if (!isGeneratable(entry)) issues.push({ field: 'catalogEntryId', message: `${entry.id} is ${entry.status}: ${entry.verificationNote}` });
      const adapter = this.s.adapters[entry.loader];
      if (!adapter.implemented) issues.push({ field: 'catalogEntryId', message: `${adapter.displayName} is not implemented yet` });
      const supported = adapter.starterOptions(entry).filter((o) => o.state === 'supported').map((o) => o.id);
      for (const st of input.starters) if (!supported.includes(st)) issues.push({ field: 'starters', message: `Starter "${st}" is not available for ${entry.id}` });
      if (input.starters.includes('datagen') && input.environment === 'server' && entry.loader === 'fabric') issues.push({ field: 'starters', message: 'Data generation requires the client environment' });
    }
    for (const d of input.dependencies) {
      const r = ModRefSchema.safeParse(d);
      if (!r.success) issues.push({ field: 'dependencies', message: r.error.issues.map((i) => i.message).join('; ') });
    }
    return { issues };
  }

  async planDependencies(minecraft: string, loader: string, refs: ModRef[], signal?: AbortSignal): Promise<DependencyPlanItem[]> {
    const out: DependencyPlanItem[] = [];
    for (const ref of refs) {
      if (ref.source === 'modrinth') {
        try {
          const project = await this.s.modrinth.project(ref.projectId, signal);
          const version = ref.versionId ? await this.s.modrinth.version(ref.versionId, signal) : pickVersion(await this.s.modrinth.versions(project.id, { loader, minecraft, signal }), loader, minecraft);
          if (!version) {
            out.push({ ref, title: project.title, status: 'error', detail: `No ${loader} version for Minecraft ${minecraft} on Modrinth` });
            continue;
          }
          const compatible = version.loaders.includes(loader) && version.game_versions.includes(minecraft);
          const req = version.dependencies.filter((d) => d.dependency_type === 'required').length;
          out.push({
            ref: { ...ref, projectId: project.id, versionId: version.id, slug: project.slug, title: project.title },
            title: project.title,
            status: compatible ? 'ok' : 'warning',
            detail: `${version.version_number} (${version.version_type})${compatible ? '' : ' does not declare this platform'}; ${req} required dependencies; ${ref.usage === 'compile' ? 'compile classpath via Modrinth Maven' : 'runtime-only in development instances'}; environment ${ref.environment}`,
            coordinates: ref.usage === 'compile' ? `maven.modrinth:${project.id}:${version.id}` : undefined,
            versionNumber: version.version_number
          });
        } catch (err) {
          out.push({ ref, title: ref.title ?? ref.projectId, status: 'error', detail: (err as Error).message });
        }
      } else if (ref.source === 'local') {
        const exists = fs.existsSync(ref.path);
        let detail = exists ? 'Local JAR' : 'File not found';
        if (exists) {
          try {
            const meta = readJarMetadata(ref.path);
            detail = meta.length ? `${meta[0].loader} mod ${meta[0].id} ${meta[0].version}` : 'No recognizable mod metadata';
          } catch (err) {
            detail = `Unreadable: ${(err as Error).message}`;
          }
        }
        out.push({ ref, title: ref.title ?? path.basename(ref.path), status: exists ? 'ok' : 'error', detail: `${detail}; runtime-only` });
      } else if (ref.source === 'curseforge') {
        if (!this.s.curseforge.configured()) {
          out.push({ ref, title: ref.title ?? `CurseForge ${ref.projectId}`, status: 'error', detail: 'CurseForge API key not configured' });
          continue;
        }
        try {
          const mod = await this.s.curseforge.mod(ref.projectId, signal);
          const files = await this.s.curseforge.files(mod.id, { loader, minecraft, signal });
          const f = ref.fileId ? files.find((x) => String(x.id) === ref.fileId) ?? (await this.s.curseforge.file(mod.id, ref.fileId, signal)) : pickCfFile(files, loader, minecraft);
          if (!f) out.push({ ref, title: mod.name, status: 'error', detail: `No ${loader} file for Minecraft ${minecraft} on CurseForge` });
          else out.push({ ref: { ...ref, fileId: String(f.id), slug: mod.slug, title: mod.name }, title: mod.name, status: cfDistributable(mod, f) ? 'ok' : 'warning', detail: `${f.displayName}; runtime-only in development instances; ${cfDistributable(mod, f) ? 'downloadable through the API' : 'author disallows third-party downloads: manual download required'}` });
        } catch (err) {
          out.push({ ref, title: ref.title ?? ref.projectId, status: 'error', detail: (err as Error).message });
        }
      } else {
        out.push({ ref, title: ref.coordinates, status: 'warning', detail: `Maven dependency (${ref.usage}); resolved by Gradle at build time, not verified in advance` });
      }
    }
    return out;
  }

  create(input: CreateProjectInput): OperationInfo {
    const { issues } = this.validateCreate(input);
    if (issues.length) throw new Error(`Invalid project settings: ${issues.map((i) => `${i.field}: ${i.message}`).join('; ')}`);
    const entry = this.s.catalog.get(input.catalogEntryId)!;
    assertGeneratable(entry);
    const dest = path.resolve(input.destination);
    return this.s.ops.start({ kind: 'project.create', title: `Create ${input.projectName}`, workspace: dest }, async (ctx) => {
      const steps: { step: string; ok: boolean; detail?: string }[] = [];
      const record = (step: string, ok: boolean, detail?: string) => {
        steps.push({ step, ok, detail });
        ctx.log(`${ok ? '[ok]' : '[failed]'} ${step}${detail ? `: ${detail}` : ''}`);
      };
      const writeState = (error?: string) => {
        if (!fs.existsSync(dest)) return;
        const sd = stateDir(dest);
        fs.mkdirSync(path.join(sd, 'logs'), { recursive: true });
        fs.writeFileSync(path.join(sd, 'setup-state.json'), JSON.stringify({ at: new Date().toISOString(), steps, error: error ?? null, catalogEntry: entry.id }, null, 2));
        fs.writeFileSync(path.join(sd, 'logs', `create-${Date.now()}.log`), this.s.ops.fullLog(ctx.id).join('\n'));
      };
      try {
        ctx.progress(0.02, 'Validating template combination');
        record('Validate template combination', true, `${entry.id} (${entry.status}, verified ${entry.verifiedOn})`);
        ctx.progress(0.05, 'Selecting JDK');
        const gradleJava = await this.s.java.select({ minMajor: entry.gradleJavaMin, requireJdk: true });
        if (!gradleJava) throw new Error(`No JDK ${entry.gradleJavaMin}+ found. Loom ${entry.plugin.version} requires Gradle to run on Java ${entry.gradleJavaMin} or newer. ${installHint(entry.gradleJavaMin, true)}, or install a JDK ${entry.gradleJavaMin} and refresh Java detection.`);
        record('Select JDK', true, `${gradleJava.vendor} ${gradleJava.version} at ${gradleJava.home}`);
        ctx.progress(0.1, 'Resolving dependencies');
        const resolvedIds: Record<string, string[]> = {};
        const coords: Record<string, string> = {};
        const deps: ModRef[] = [];
        for (const d of input.dependencies) {
          ctx.throwIfCancelled();
          if (d.source === 'modrinth') {
            const project = await this.s.modrinth.project(d.projectId, ctx.signal);
            const version = d.versionId ? await this.s.modrinth.version(d.versionId, ctx.signal) : pickVersion(await this.s.modrinth.versions(project.id, { loader: entry.loader, minecraft: entry.minecraft, signal: ctx.signal }), entry.loader, entry.minecraft);
            if (!version) throw new Error(`${project.title} has no ${entry.loader} ${entry.minecraft} version`);
            const file = primaryFile(version);
            if (file) {
              const dl = await downloadVerified({ url: file.url, dest: path.join(this.s.paths.downloads, 'modrinth', file.hashes.sha1.slice(0, 2), file.hashes.sha1, file.filename), sha1: file.hashes.sha1, sha512: file.hashes.sha512, size: file.size, signal: ctx.signal });
              resolvedIds[project.id] = allModIds(readJarMetadata(dl.path)).slice(0, 1);
            }
            coords[project.id] = `maven.modrinth:${project.id}:${version.id}`;
            deps.push({ ...d, projectId: project.id, versionId: version.id, slug: project.slug, title: project.title });
            ctx.log(`Resolved ${project.title} ${version.version_number} (${d.usage}, ${d.required ? 'required' : 'optional'})`);
          } else {
            deps.push(d);
          }
        }
        record('Resolve dependencies', true, `${deps.length} dependencies`);
        ctx.progress(0.2, 'Generating project files');
        const opts: ScaffoldOptions = { ...input, destination: dest, dependencies: deps, resolvedDependencyModIds: resolvedIds, mavenCoordinates: coords };
        const files = this.s.adapters[entry.loader].generateProject(opts, entry);
        fs.mkdirSync(dest, { recursive: true });
        if (fs.readdirSync(dest).length) throw new Error('Destination became non-empty before generation; aborting without writing files');
        const wrapperDir = path.join(this.s.paths.resources, 'templates', 'gradle-wrapper');
        for (const f of ['gradlew', 'gradlew.bat', path.join('gradle', 'wrapper', 'gradle-wrapper.jar')]) {
          fs.mkdirSync(path.dirname(path.join(dest, f)), { recursive: true });
          fs.copyFileSync(path.join(wrapperDir, f), path.join(dest, f));
        }
        for (const f of files) {
          const full = path.join(dest, f.path);
          fs.mkdirSync(path.dirname(full), { recursive: true });
          fs.writeFileSync(full, f.content);
        }
        record('Generate Gradle wrapper and project', true, `${files.length + 3} files, Gradle ${entry.gradleVersion}`);
        ctx.progress(0.3, 'Writing manifest and profiles');
        const wantProfiles = input.starters.includes('profiles');
        const profiles = [ProfileSchema.parse({ id: 'dev-client', name: 'Test Client', side: 'client', bridge: input.starters.includes('bridge') })];
        if (wantProfiles && input.environment !== 'client') profiles.push(ProfileSchema.parse({ id: 'dev-server', name: 'Dedicated Server', side: 'server', bridge: input.starters.includes('bridge'), jvm: { memoryMb: 2048, args: [] } }));
        if (input.environment === 'server') profiles.splice(0, 1);
        const manifest: Manifest = ManifestSchema.parse({
          schemaVersion: 1,
          name: input.projectName,
          type: 'mod',
          modId: input.modId,
          platform: { loader: entry.loader, minecraft: entry.minecraft, loaderVersion: entry.loaderVersion, catalogEntry: entry.id },
          source: { kind: 'gradle', root: '.' },
          dependencies: deps,
          profiles,
          preset: input.presetId,
          createdBy: `${PRODUCT.name} ${PRODUCT.version}`
        });
        writeManifest(dest, manifest);
        record('Create isolated run profiles', true, profiles.map((p) => p.id).join(', '));
        this.s.store.setTrusted(this.ws.normalize(dest), true);
        this.s.store.addRecent(this.ws.normalize(dest), input.projectName, 'mod');
        if (input.git) {
          ctx.progress(0.35, 'Initializing Git');
          const r = await gitInit(dest);
          record('Initialize Git', r.ok, r.detail);
        }
        if (input.runInitialBuild) {
          ctx.progress(0.4, 'Running initial build (first run downloads Minecraft and Loom)');
          const res = await runGradle({ projectDir: dest, tasks: ['build'], java: gradleJava, ctx });
          writeDiagnostics(dest, res.diagnostics);
          if (!res.ok) {
            record('Initial build', false, `exit code ${res.exitCode}`);
            throw new Error(`Initial build failed (exit ${res.exitCode}). The generated project was kept at ${dest}; see Problems and the task log.`);
          }
          record('Initial build', true, `${(res.durationMs / 1000).toFixed(1)} s`);
        }
        writeState();
        return { path: this.ws.normalize(dest), steps, catalogEntry: entry.id };
      } catch (err) {
        writeState((err as Error).message);
        throw err;
      }
    });
  }

  async resolveGradleJava(root: string): Promise<{ java: NonNullable<Awaited<ReturnType<Services['java']['select']>>>; note: string }> {
    const { manifest } = readManifest(root);
    const entry = manifest?.platform.catalogEntry ? this.s.catalog.get(manifest.platform.catalogEntry) : undefined;
    const min = entry?.gradleJavaMin ?? 21;
    const java = await this.s.java.select({ minMajor: min, requireJdk: true });
    if (java) return { java, note: entry ? `catalog ${entry.id} requires Java ${min}+ for Gradle` : `defaulting to Java ${min}+` };
    const any = (await this.s.java.list()).filter((j) => j.isJdk).sort((a, b) => b.major - a.major)[0];
    if (!any) throw new Error(`No JDK installations found. ${installHint(min, true)}, or install a JDK ${min} and refresh Java detection.`);
    return { java: any, note: `no JDK ${min}+ found; using newest JDK ${any.major}` };
  }

  build(root: string, opts: { clean?: boolean; tasks?: string[] } = {}): OperationInfo {
    const dir = this.ws.normalize(root);
    this.ws.requireTrusted(dir);
    if (!wrapperPath(dir)) throw new Error('No Gradle wrapper in this workspace');
    return this.s.ops.start({ kind: 'project.build', title: `${opts.clean ? 'Clean build' : 'Build'} ${path.basename(dir)}`, workspace: dir }, async (ctx) => this.runBuild(dir, opts, ctx));
  }

  async runBuild(dir: string, opts: { clean?: boolean; tasks?: string[] }, ctx: OpContext) {
    const { java, note } = await this.resolveGradleJava(dir);
    ctx.log(`Gradle JVM: ${java.version} (${note}); wrapper ${wrapperVersion(dir) ?? 'unknown'}`);
    const tasks = opts.tasks?.length ? opts.tasks : [...(opts.clean ? ['clean'] : []), 'build'];
    const res = await runGradle({ projectDir: dir, tasks, java, ctx });
    writeDiagnostics(dir, res.diagnostics);
    this.s.bus.emit('diagnostics.updated', { workspace: dir, diagnostics: res.diagnostics });
    if (!res.ok) throw new Error(`Build failed with exit code ${res.exitCode}; ${res.diagnostics.filter((d) => d.severity === 'error').length} errors`);
    const libs = path.join(dir, 'build', 'libs');
    const artifacts = fs.existsSync(libs) ? fs.readdirSync(libs).map((f) => path.join(libs, f)) : [];
    return { ok: true, durationMs: res.durationMs, diagnostics: res.diagnostics, artifacts };
  }

  artifacts(root: string) {
    const libs = path.join(this.ws.normalize(root), 'build', 'libs');
    const names = fs.existsSync(libs) ? fs.readdirSync(libs).filter((f) => f.endsWith('.jar') && fs.statSync(path.join(libs, f)).isFile()) : [];
    const files = names.map((name) => {
      const st = fs.statSync(path.join(libs, name));
      const kind = /-sources\.jar$/.test(name) ? 'sources' : /-javadoc\.jar$/.test(name) ? 'javadoc' : /-dev\.jar$/.test(name) ? 'dev' : 'mod';
      return { name, path: path.join(libs, name), size: st.size, mtime: st.mtimeMs, kind };
    });
    files.sort((a, b) => Number(b.kind === 'mod') - Number(a.kind === 'mod') || b.mtime - a.mtime || (a.name < b.name ? -1 : 1));
    return { folder: libs, exists: fs.existsSync(libs), files };
  }

  exportArtifact(root: string, name: string, output: string) {
    if (!name.endsWith('.jar') || /[\\/]/.test(name) || name.startsWith('.')) throw new Error(`${name} is not a JAR in build/libs`);
    const file = path.join(this.ws.normalize(root), 'build', 'libs', name);
    if (!fs.existsSync(file)) throw new Error(`${name} is not in build/libs; build the project first`);
    if (!path.isAbsolute(output)) throw new Error('output must be an absolute path');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(file, output);
    return { output, size: fs.statSync(output).size };
  }

  diagnostics(root: string): Diagnostic[] {
    const f = path.join(stateDir(this.ws.normalize(root)), 'diagnostics.json');
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : [];
  }

  validate(root: string) {
    const dir = this.ws.normalize(root);
    const info = this.ws.inspect(dir);
    const problems: { severity: 'error' | 'warning' | 'info'; message: string }[] = [];
    info.manifestErrors.forEach((m) => problems.push({ severity: 'error', message: m }));
    info.warnings.forEach((m) => problems.push({ severity: 'warning', message: m }));
    if (info.manifest) {
      const entry = info.manifest.platform.catalogEntry ? this.s.catalog.get(info.manifest.platform.catalogEntry) : undefined;
      if (!entry) problems.push({ severity: 'warning', message: 'Manifest does not reference a known compatibility catalog entry' });
      else if (entry.minecraft !== info.manifest.platform.minecraft) problems.push({ severity: 'error', message: `Manifest Minecraft ${info.manifest.platform.minecraft} does not match catalog entry ${entry.id}` });
      if (info.manifest.source.kind === 'gradle' && !wrapperPath(dir)) problems.push({ severity: 'error', message: 'Gradle source project has no wrapper' });
      if (info.manifest.source.kind === 'gradle' && info.detected?.minecraftHint && entry && !info.detected.minecraftHint.includes(entry.minecraft)) problems.push({ severity: 'warning', message: `gradle.properties declares Minecraft ${info.detected.minecraftHint}, manifest says ${info.manifest.platform.minecraft}` });
      for (const p of info.manifest.profiles) {
        if (p.configDir && !fs.existsSync(path.join(dir, p.configDir))) problems.push({ severity: 'warning', message: `Profile ${p.id}: config directory ${p.configDir} does not exist` });
        if (!info.lockProfiles.includes(p.id) && p.mods.length) problems.push({ severity: 'info', message: `Profile ${p.id} has not been resolved yet` });
      }
    } else {
      problems.push({ severity: 'info', message: `No ${PRODUCT.manifestFile}; initialize the workspace to use profiles` });
    }
    for (const fmj of info.detected?.modMetadata ?? []) {
      const full = path.join(dir, fmj.file);
      if (fmj.file.endsWith('fabric.mod.json')) {
        try {
          JSON.parse(fs.readFileSync(full, 'utf8'));
        } catch (err) {
          problems.push({ severity: 'error', message: `${fmj.file}: ${(err as Error).message}` });
        }
      }
    }
    return { workspace: dir, problems, ok: !problems.some((p) => p.severity === 'error') };
  }
}

function writeDiagnostics(dir: string, diagnostics: Diagnostic[]): void {
  const sd = stateDir(dir);
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, 'diagnostics.json'), JSON.stringify(diagnostics, null, 2));
}

async function gitInit(dir: string): Promise<{ ok: boolean; detail: string }> {
  const env = { ...process.env };
  const init = await execCapture('git', ['-C', dir, 'init', '-q'], 20000, env);
  if (init.code !== 0) return { ok: false, detail: init.stderr.trim() || 'git init failed' };
  await execCapture('git', ['-C', dir, 'add', '-A'], 20000, env);
  const name = await execCapture('git', ['-C', dir, 'config', 'user.name'], 5000, env);
  if (name.code !== 0 || !name.stdout.trim()) return { ok: true, detail: 'Repository initialized and files staged; no Git identity configured, so no commit was made' };
  const commit = await execCapture('git', ['-C', dir, 'commit', '-q', '-m', `Initial project generated by ${PRODUCT.name}`], 20000, env);
  return { ok: commit.code === 0, detail: commit.code === 0 ? 'Repository initialized with an initial commit' : commit.stderr.trim() };
}
