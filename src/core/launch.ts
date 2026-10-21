import fs from 'node:fs';
import net from 'node:net';
import { zipSync } from 'fflate';
import path from 'node:path';
import type { InstanceInfo, JavaInstallation, LaunchMode, OperationInfo } from '../shared/types';
import { PRODUCT } from '../shared/product';
import type { Services } from './context';
import type { WorkspaceService } from './workspace';
import { instanceDirFor, stateDir } from './workspace';
import type { ProfileService } from './profiles';
import { classpathModIds } from './profiles';
import type { ProjectService } from './projects';
import { readManifest, type LockEntry, type Manifest, type Profile } from './manifest';
import { runGradle } from './gradle';
import { downloadVerified, hashFile } from './http';
import { readJarMetadata, allModIds } from './jarmeta';
import { runProcess } from './proc';
import { buildClientLaunch, ClientInstaller, currentPlatform } from './clientinstall';
import type { OpContext } from './operations';
import { isGeneratable } from './catalog';

export interface RunSpec {
  environment?: Record<string, string>;
  mainClass: string;
  jvmArgs: string[];
  args: string[];
  classpath: string[];
  workingDir: string;
  javaExecutable: string | null;
}

function quoteArgFile(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

async function freePort(start: number): Promise<number> {
  for (let p = start; p < start + 50; p++) {
    const ok = await new Promise<boolean>((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.listen(p, '127.0.0.1', () => srv.close(() => resolve(true)));
    });
    if (ok) return p;
  }
  throw new Error(`No free debug port near ${start}`);
}

export function disableEarlyWindowToml(text: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.length ? text.split(/\r?\n/) : [];
  const idx = lines.findIndex((l) => /^[ \t]*earlyWindowControl[ \t]*=/.test(l));
  if (idx >= 0) lines[idx] = 'earlyWindowControl = false';
  else {
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    lines.push('earlyWindowControl = false', '');
  }
  return lines.join(eol);
}

export function eulaAccepted(instanceDir: string): boolean {
  const f = path.join(instanceDir, 'eula.txt');
  return fs.existsSync(f) && /^\s*eula\s*=\s*true\s*$/m.test(fs.readFileSync(f, 'utf8'));
}

function zipDir(root: string, file: string): void {
  const entries: Record<string, [Uint8Array, { os: number; attrs: number; mtime: Date }]> = {};
  const walk = (d: string) => {
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else {
        const rel = path.relative(root, full).replace(/\\/g, '/');
        entries[rel] = [new Uint8Array(fs.readFileSync(full)), { os: 3, attrs: (rel.endsWith('.sh') ? 0o100755 : 0o100644) << 16, mtime: new Date() }];
      }
    }
  };
  walk(root);
  fs.writeFileSync(`${file}.tmp`, zipSync(entries));
  fs.renameSync(`${file}.tmp`, file);
}

function classpathArgs(java: JavaInstallation, argFile: string, classpath: string): string[] {
  if (java.major < 9) return ['-cp', classpath];
  fs.writeFileSync(argFile, `-cp ${quoteArgFile(classpath)}\n`);
  return [`@${argFile}`];
}

export class LaunchService {
  constructor(private s: Services, private ws: WorkspaceService, private profiles: ProfileService, private projects: ProjectService) {}

  bridgeJar(manifest: Manifest): { path: string; entry: LockEntry } | null {
    const cat = manifest.platform.catalogEntry ? this.s.catalog.get(manifest.platform.catalogEntry) : undefined;
    if (!cat?.bridge.available || !cat.bridge.jar) return null;
    const p = path.join(this.s.paths.resources, 'bridge', cat.bridge.jar);
    if (!fs.existsSync(p)) return null;
    return { path: p, entry: { key: 'bridge', provider: 'bridge', title: `${PRODUCT.name} bridge`, fileName: cat.bridge.jar, modIds: [PRODUCT.bridgeModId], reason: 'development bridge', required: false } };
  }

  acceptEula(root: string, profileId: string, mode: LaunchMode, accept: boolean): { instanceDir: string; accepted: boolean } {
    if (accept !== true) throw new Error('Accepting the Minecraft EULA requires accept: true after the user has read https://aka.ms/MinecraftEULA');
    const dir = this.ws.normalize(root);
    const manifest = this.ws.requireManifest(dir);
    const profile = manifest.profiles.find((p) => p.id === profileId);
    if (!profile) throw new Error(`Unknown profile ${profileId}`);
    if (profile.side !== 'server') throw new Error('EULA acceptance is only needed for server profiles');
    const idir = instanceDirFor(dir, profile.id, mode, 'server');
    fs.mkdirSync(idir, { recursive: true });
    fs.writeFileSync(path.join(idir, 'eula.txt'), `#Accepted by the user through ${PRODUCT.name} on ${new Date().toISOString()} (https://aka.ms/MinecraftEULA)\neula=true\n`);
    return { instanceDir: idir, accepted: true };
  }

  eulaStatus(root: string, profileId: string, mode: LaunchMode): { instanceDir: string; accepted: boolean } {
    const dir = this.ws.normalize(root);
    const idir = instanceDirFor(dir, profileId, mode, 'server');
    return { instanceDir: idir, accepted: eulaAccepted(idir) };
  }

  async runtimeJava(manifest: Manifest, profile: Profile): Promise<JavaInstallation> {
    const cat = manifest.platform.catalogEntry ? this.s.catalog.get(manifest.platform.catalogEntry) : undefined;
    const min = profile.java.minMajor ?? cat?.runtimeJavaMin ?? 21;
    const j = await this.s.java.select({ minMajor: min, preferHome: profile.java.home });
    if (!j) throw new Error(`No Java ${min}+ runtime found for profile ${profile.id}`);
    if (profile.java.home && path.resolve(j.home).toLowerCase() !== path.resolve(profile.java.home).toLowerCase()) throw new Error(`Configured Java ${profile.java.home} for profile ${profile.id} is missing or older than Java ${min}`);
    return j;
  }

  async harnessDir(root: string, manifest: Manifest): Promise<string> {
    const cat = manifest.platform.catalogEntry ? this.s.catalog.get(manifest.platform.catalogEntry) : undefined;
    if (!cat || !isGeneratable(cat)) throw new Error('Modpack launch requires a verified catalog entry for the pack platform');
    const dir = path.join(stateDir(root), 'harness');
    fs.mkdirSync(dir, { recursive: true });
    const wrapperSrc = path.join(this.s.paths.resources, 'templates', 'gradle-wrapper');
    for (const f of ['gradlew', 'gradlew.bat', path.join('gradle', 'wrapper', 'gradle-wrapper.jar')]) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.copyFileSync(path.join(wrapperSrc, f), path.join(dir, f));
    }
    fs.writeFileSync(path.join(dir, 'gradle', 'wrapper', 'gradle-wrapper.properties'), `distributionBase=GRADLE_USER_HOME\ndistributionPath=wrapper/dists\ndistributionUrl=https\\://services.gradle.org/distributions/gradle-${cat.gradleVersion}-bin.zip\nnetworkTimeout=10000\nvalidateDistributionUrl=true\nzipStoreBase=GRADLE_USER_HOME\nzipStorePath=wrapper/dists\n`);
    fs.writeFileSync(path.join(dir, 'settings.gradle'), `pluginManagement {\n\trepositories {\n\t\tmaven {\n\t\t\tname = 'Fabric'\n\t\t\turl = 'https://maven.fabricmc.net/'\n\t\t}\n\t\tmavenCentral()\n\t\tgradlePluginPortal()\n\t}\n}\n\nrootProject.name = 'modsmith-harness'\n`);
    const impl = cat.remap ? 'modImplementation' : 'implementation';
    fs.writeFileSync(path.join(dir, 'build.gradle'), `plugins {\n\tid '${cat.plugin.id}' version '${cat.plugin.version}'\n}\n\ndependencies {\n\tminecraft "com.mojang:minecraft:${cat.minecraft}"\n${cat.mappings === 'mojang' ? '\tmappings loom.officialMojangMappings()\n' : ''}\t${impl} "net.fabricmc:fabric-loader:${manifest.platform.loaderVersion}"\n}\n`);
    return dir;
  }

  async extractSpec(projectDir: string, outDir: string, runName: string, java: JavaInstallation, ctx: OpContext): Promise<RunSpec & { providedModIds: string[]; remapJar?: string }> {
    fs.mkdirSync(outDir, { recursive: true });
    const specFile = path.join(outDir, `${runName}.json`);
    const res = await runGradle({
      projectDir,
      tasks: ['mwbLaunchSpec'],
      java,
      ctx,
      initScript: path.join(this.s.paths.resources, 'gradle', 'modsmith-init.gradle'),
      systemProps: { 'mwb.runs': runName, 'mwb.specOut': specFile }
    });
    if (!res.ok) {
      const d = path.join(projectDir, '.modsmith');
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'diagnostics.json'), JSON.stringify(res.diagnostics, null, 2));
      this.s.bus.emit('diagnostics.updated', { workspace: projectDir, diagnostics: res.diagnostics });
      throw new Error(`Gradle failed while preparing ${runName} (exit ${res.exitCode}); ${res.diagnostics.filter((x) => x.severity === 'error').length} errors`);
    }
    if (!fs.existsSync(specFile)) throw new Error('Gradle did not produce a launch specification. The project may not apply Fabric Loom or NeoForge ModDevGradle in its root project.');
    const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
    const run = spec.runs?.[runName] as RunSpec | undefined;
    if (!run) throw new Error(`The project has no ${runName} task (missing: ${(spec.missing ?? []).join(', ')})`);
    return { ...run, providedModIds: classpathModIds(run.classpath), remapJar: spec.remapJar ?? spec.jar };
  }

  launch(root: string, profileId: string, opts: { mode?: LaunchMode; source?: string } = {}): OperationInfo {
    const dir = this.ws.normalize(root);
    const manifest = this.ws.requireManifest(dir);
    const profile = manifest.profiles.find((p) => p.id === profileId);
    if (!profile) throw new Error(`Unknown profile ${profileId}`);
    if (!this.s.adapters[manifest.platform.loader].implemented) throw new Error(`${manifest.platform.loader} launch is not implemented`);
    const mode = opts.mode ?? profile.mode;
    if (manifest.source.kind === 'gradle' || mode === 'development') this.ws.requireTrusted(dir);
    const idir = instanceDirFor(dir, profile.id, mode, profile.side);
    const busy = this.s.instances.activeForDir(idir);
    if (busy) throw new Error(`Profile ${profile.id} already has a running ${profile.side} (instance ${busy.id}). Stop it or clone the profile to run another copy.`);
    if (profile.side === 'server' && !eulaAccepted(idir)) {
      throw new Error(`The Minecraft EULA has not been accepted for ${idir}. Read https://aka.ms/MinecraftEULA and accept it explicitly (instance_accept_eula) before starting a server.`);
    }
    return this.s.ops.start({ kind: 'instance.launch', title: `Launch ${profile.name} (${mode})`, workspace: dir }, async (ctx) => {
      const runtimeJava = await this.runtimeJava(manifest, profile);
      ctx.log(`Runtime Java: ${runtimeJava.vendor} ${runtimeJava.version} (${runtimeJava.home})`);
      let info: InstanceInfo;
      if (mode === 'development') info = await this.launchDev(dir, manifest, profile, idir, runtimeJava, ctx);
      else if (profile.side === 'client') info = await this.launchProdClient(dir, manifest, profile, idir, runtimeJava, ctx);
      else info = await this.launchProdServer(dir, manifest, profile, idir, runtimeJava, ctx);
      return info;
    });
  }

  private async launchDev(dir: string, manifest: Manifest, profile: Profile, idir: string, runtimeJava: JavaInstallation, ctx: OpContext): Promise<InstanceInfo> {
    const runName = profile.side === 'client' ? 'runClient' : 'runServer';
    const useSource = manifest.source.kind === 'gradle' && profile.includeSourceMod;
    if (!useSource && manifest.platform.loader !== 'fabric') throw new Error(`Launching a ${manifest.platform.loader} profile without the source mod needs a development harness, which is only implemented for Fabric`);
    const sourceProject = useSource ? dir : await this.harnessDir(dir, manifest);
    ctx.progress(0.05, sourceProject === dir ? 'Compiling and preparing the launch configuration' : 'Preparing development harness');
    const { java: gradleJava, note } = await this.projects.resolveGradleJava(dir);
    ctx.log(`Gradle JVM: ${gradleJava.version} (${note})`);
    const spec = await this.extractSpec(sourceProject, path.join(stateDir(dir), 'launch'), runName, gradleJava, ctx);
    ctx.progress(0.6, 'Resolving profile mods');
    const bridge = profile.bridge ? this.bridgeJar(manifest) : null;
    if (profile.bridge && !bridge) ctx.log('[warning] Bridge requested but no bridge JAR is available for this platform; launching without it');
    const res = await this.profiles.resolve(dir, profile.id, ctx, { mode: 'development', providedModIds: spec.providedModIds, extraEntries: bridge ? [bridge.entry] : [] });
    const errors = res.issues.filter((i) => i.severity === 'error');
    if (errors.length) throw new Error(`Profile resolution has errors: ${errors.map((e) => e.message).join('; ')}`);
    ctx.progress(0.75, 'Syncing isolated instance');
    const files = Object.entries(res.files).map(([key, source]) => ({ name: res.entries.find((e) => e.key === key)?.fileName ?? path.basename(source), source }));
    if (bridge) files.push({ name: bridge.entry.fileName, source: bridge.path });
    this.profiles.syncInstance(idir, files, ctx);
    this.profiles.overlay(dir, profile, idir, ctx);
    if (manifest.platform.loader === 'neoforge' && profile.side === 'client') this.disableEarlyWindow(dir, profile, idir, ctx);
    const argFile = path.join(stateDir(dir), 'launch', `${profile.id}-${profile.side}.classpath.args`);
    const cpArgs = classpathArgs(runtimeJava, argFile, spec.classpath.join(path.delimiter));
    const jvm = spec.jvmArgs.filter((a) => !a.startsWith('-Duser.') && !a.startsWith('-Xmx') && !a.startsWith('-Xms'));
    jvm.push(`-Xmx${profile.jvm.memoryMb}M`, ...profile.jvm.args);
    let debugPort: number | undefined;
    if (profile.debug.enabled) {
      debugPort = await freePort(profile.debug.port);
      jvm.push(`-agentlib:jdwp=transport=dt_socket,server=y,suspend=${profile.debug.suspend ? 'y' : 'n'},address=127.0.0.1:${debugPort}`);
    }
    const args = [...jvm, ...cpArgs, spec.mainClass, ...spec.args, ...profile.programArgs];
    if (profile.side === 'server' && manifest.platform.loader === 'fabric' && !args.includes('nogui')) args.push('nogui');
    ctx.progress(0.9, 'Starting Java process');
    const info = this.s.instances.launch({ workspace: dir, profileId: profile.id, side: profile.side, mode: 'development', instanceDir: idir, java: runtimeJava.executable, args, env: spec.environment ?? {}, bridge: !!bridge, debugPort, operationId: ctx.id });
    ctx.log(`Started ${profile.side} pid ${info.pid} in ${idir}`);
    return info;
  }

  disableEarlyWindow(dir: string, profile: Profile, idir: string, ctx: OpContext): void {
    if (profile.configDir && fs.existsSync(path.join(dir, profile.configDir, 'fml.toml'))) {
      ctx.log('Keeping the profile-supplied config/fml.toml (early loading window settings unchanged)');
      return;
    }
    const file = path.join(idir, 'config', 'fml.toml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const next = disableEarlyWindowToml(text);
    if (next !== text) fs.writeFileSync(file, next);
    ctx.log('NeoForge early loading window disabled for this development instance (config/fml.toml earlyWindowControl = false) to avoid an intermittent early-display startup failure');
  }

  async installFabricServer(idir: string, manifest: Manifest, java: JavaInstallation, ctx: OpContext): Promise<string> {
    const launcher = path.join(idir, 'fabric-server-launch.jar');
    const marker = path.join(idir, '.modsmith-server.json');
    const want = { minecraft: manifest.platform.minecraft, loader: manifest.platform.loaderVersion };
    if (fs.existsSync(launcher) && fs.existsSync(marker) && JSON.stringify(JSON.parse(fs.readFileSync(marker, 'utf8'))) === JSON.stringify(want)) return launcher;
    const installers = await this.s.http.getJson<{ version: string; stable: boolean; maven: string }[]>('https://meta.fabricmc.net/v2/versions/installer', { signal: ctx.signal, maxAgeMs: 24 * 3600 * 1000 });
    const inst = installers.data.find((i) => i.stable) ?? installers.data[0];
    if (!inst) throw new Error('Fabric meta returned no installer versions');
    const url = `https://maven.fabricmc.net/net/fabricmc/fabric-installer/${inst.version}/fabric-installer-${inst.version}.jar`;
    const shaRes = await fetch(`${url}.sha1`, { signal: ctx.signal });
    if (!shaRes.ok) throw new Error(`Could not fetch installer checksum (${shaRes.status})`);
    const sha1 = (await shaRes.text()).trim().slice(0, 40);
    const jar = await downloadVerified({ url, dest: path.join(this.s.paths.downloads, 'fabric-installer', inst.version, `fabric-installer-${inst.version}.jar`), sha1, signal: ctx.signal });
    ctx.log(`Fabric installer ${inst.version} ${jar.cached ? '(cached)' : 'downloaded'} and verified`);
    const r = await runProcess(java.executable, ['-jar', jar.path, 'server', '-dir', idir, '-mcversion', manifest.platform.minecraft, '-loader', manifest.platform.loaderVersion, '-downloadMinecraft'], { cwd: idir, signal: ctx.signal, onLine: (l) => ctx.log(l) });
    if (r.code !== 0 || !fs.existsSync(launcher)) throw new Error(`Fabric server installation failed (exit ${r.code})`);
    fs.writeFileSync(marker, JSON.stringify(want));
    return launcher;
  }

  async installNeoForgeServer(idir: string, manifest: Manifest, java: JavaInstallation, ctx: OpContext): Promise<string[]> {
    const v = manifest.platform.loaderVersion;
    const argsFile = path.join(idir, 'libraries', 'net', 'neoforged', 'neoforge', v, process.platform === 'win32' ? 'win_args.txt' : 'unix_args.txt');
    const marker = path.join(idir, '.modsmith-server.json');
    const want = { minecraft: manifest.platform.minecraft, loader: `neoforge-${v}` };
    const ready = fs.existsSync(argsFile) && fs.existsSync(marker) && JSON.stringify(JSON.parse(fs.readFileSync(marker, 'utf8'))) === JSON.stringify(want);
    if (!ready) {
      const url = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${v}/neoforge-${v}-installer.jar`;
      const shaRes = await fetch(`${url}.sha1`, { signal: ctx.signal });
      if (!shaRes.ok) throw new Error(`Could not fetch NeoForge installer checksum (${shaRes.status})`);
      const sha1 = (await shaRes.text()).trim().slice(0, 40);
      const jar = await downloadVerified({ url, dest: path.join(this.s.paths.downloads, 'neoforge-installer', v, `neoforge-${v}-installer.jar`), sha1, signal: ctx.signal });
      ctx.log(`NeoForge installer ${v} ${jar.cached ? '(cached)' : 'downloaded'} and verified`);
      fs.mkdirSync(idir, { recursive: true });
      const r = await runProcess(java.executable, ['-jar', jar.path, '--install-server', idir], { cwd: idir, signal: ctx.signal, onLine: (l) => ctx.log(l) });
      if (r.code !== 0 || !fs.existsSync(argsFile)) throw new Error(`NeoForge server installation failed (exit ${r.code})`);
      fs.writeFileSync(marker, JSON.stringify(want));
    }
    const userArgs = path.join(idir, 'user_jvm_args.txt');
    return [...(fs.existsSync(userArgs) ? [`@${userArgs}`] : []), `@${argsFile}`];
  }

  private async releaseExtras(dir: string, manifest: Manifest, profile: Profile, ctx: OpContext): Promise<{ extra: LockEntry[]; extraFiles: { name: string; source: string }[] }> {
    const extra: LockEntry[] = [];
    const extraFiles: { name: string; source: string }[] = [];
    if (manifest.source.kind === 'gradle' && profile.includeSourceMod) {
      ctx.progress(0.05, 'Building the release JAR');
      const build = await this.projects.runBuild(dir, {}, ctx);
      const info = await this.projectArtifact(dir, ctx);
      if (!info) throw new Error(`Build produced no mod JAR; artifacts: ${build.artifacts.join(', ')}`);
      const meta = readJarMetadata(info);
      if (!meta.length) throw new Error(`${path.basename(info)} has no ${manifest.platform.loader === 'fabric' ? 'fabric.mod.json' : 'META-INF/neoforge.mods.toml'}; packaging is broken`);
      extra.push({ key: 'source', provider: 'local', title: `${manifest.name} (built)`, fileName: path.basename(info), sha1: await hashFile(info, 'sha1'), size: fs.statSync(info).size, modIds: allModIds(meta), reason: 'source mod production JAR', required: true });
      extraFiles.push({ name: path.basename(info), source: info });
      ctx.log(`Release JAR: ${info} (mod ${meta[0].id} ${meta[0].version})`);
    }
    const bridge = profile.bridge ? this.bridgeJar(manifest) : null;
    if (bridge) {
      extra.push(bridge.entry);
      extraFiles.push({ name: bridge.entry.fileName, source: bridge.path });
    }
    return { extra, extraFiles };
  }

  private async launchProdClient(dir: string, manifest: Manifest, profile: Profile, idir: string, runtimeJava: JavaInstallation, ctx: OpContext): Promise<InstanceInfo> {
    const loader = manifest.platform.loader;
    if (loader !== 'fabric' && loader !== 'neoforge') throw new Error(`Release client launch is not implemented for ${loader}`);
    const { extra, extraFiles } = await this.releaseExtras(dir, manifest, profile, ctx);
    ctx.progress(0.3, 'Resolving the release profile');
    const res = await this.profiles.resolve(dir, profile.id, ctx, { mode: 'production', providedModIds: [], extraEntries: extra });
    const errors = res.issues.filter((i) => i.severity === 'error');
    if (errors.length) throw new Error(`Profile resolution has errors: ${errors.map((e) => e.message).join('; ')}`);
    const installer = new ClientInstaller(this.s.http, path.join(this.s.paths.cache, 'minecraft'));
    const client = await installer.install(loader, manifest.platform.minecraft, manifest.platform.loaderVersion, runtimeJava.executable, ctx);
    if (client.version.javaVersion && client.version.javaVersion.majorVersion > runtimeJava.major) throw new Error(`Minecraft ${manifest.platform.minecraft} needs Java ${client.version.javaVersion.majorVersion}; the selected runtime is Java ${runtimeJava.major}`);
    ctx.progress(0.88, 'Syncing isolated instance');
    const files = [...Object.entries(res.files).map(([key, source]) => ({ name: res.entries.find((e) => e.key === key)?.fileName ?? path.basename(source), source })), ...extraFiles];
    this.profiles.syncInstance(idir, files, ctx);
    this.profiles.overlay(dir, profile, idir, ctx);
    if (loader === 'neoforge') this.disableEarlyWindow(dir, profile, idir, ctx);
    const nativesDir = path.join(idir, 'natives');
    fs.mkdirSync(nativesDir, { recursive: true });
    const spec = buildClientLaunch(client.version, { librariesDir: client.librariesDir, clientJar: client.clientJar, gameDir: idir, assetsDir: client.assetsDir, nativesDir, username: 'Player', platform: currentPlatform(), launcherName: PRODUCT.id, launcherVersion: PRODUCT.version });
    const argFile = path.join(stateDir(dir), 'launch', `${profile.id}-release-client.args`);
    fs.mkdirSync(path.dirname(argFile), { recursive: true });
    const jvm: string[] = [];
    for (let i = 0; i < spec.jvmArgs.length; i++) {
      if ((spec.jvmArgs[i] === '-cp' || spec.jvmArgs[i] === '-classpath') && i + 1 < spec.jvmArgs.length) {
        jvm.push(...classpathArgs(runtimeJava, argFile, spec.jvmArgs[i + 1]));
        i++;
      } else jvm.push(spec.jvmArgs[i]);
    }
    const args = [`-Xmx${profile.jvm.memoryMb}M`, ...profile.jvm.args];
    let debugPort: number | undefined;
    if (profile.debug.enabled) {
      debugPort = await freePort(profile.debug.port);
      args.push(`-agentlib:jdwp=transport=dt_socket,server=y,suspend=${profile.debug.suspend ? 'y' : 'n'},address=127.0.0.1:${debugPort}`);
    }
    args.push(...jvm, spec.mainClass, ...spec.gameArgs, ...profile.programArgs);
    ctx.log(`Release client: Minecraft ${manifest.platform.minecraft}, ${loader} ${manifest.platform.loaderVersion}, offline player "Player" (no account sign-in; online-mode servers will refuse the connection)`);
    ctx.progress(0.95, 'Starting Java process');
    const info = this.s.instances.launch({ workspace: dir, profileId: profile.id, side: 'client', mode: 'production', instanceDir: idir, java: runtimeJava.executable, args, bridge: extra.some((e) => e.provider === 'bridge'), debugPort, operationId: ctx.id });
    ctx.log(`Started release client pid ${info.pid} in ${idir}`);
    return info;
  }

  private async launchProdServer(dir: string, manifest: Manifest, profile: Profile, idir: string, runtimeJava: JavaInstallation, ctx: OpContext): Promise<InstanceInfo> {
    const extra: LockEntry[] = [];
    const extraFiles: { name: string; source: string }[] = [];
    if (manifest.source.kind === 'gradle' && profile.includeSourceMod) {
      ctx.progress(0.05, 'Building distributable JAR');
      const build = await this.projects.runBuild(dir, {}, ctx);
      const info = await this.projectArtifact(dir, ctx);
      if (!info) throw new Error(`Build produced no mod JAR; artifacts: ${build.artifacts.join(', ')}`);
      const meta = readJarMetadata(info);
      if (!meta.length) throw new Error(`${path.basename(info)} has no ${manifest.platform.loader === 'fabric' ? 'fabric.mod.json' : 'META-INF/neoforge.mods.toml'}; packaging is broken`);
      extra.push({ key: 'source', provider: 'local', title: `${manifest.name} (built)`, fileName: path.basename(info), sha1: await hashFile(info, 'sha1'), size: fs.statSync(info).size, modIds: allModIds(meta), reason: 'source mod production JAR', required: true });
      extraFiles.push({ name: path.basename(info), source: info });
      ctx.log(`Production JAR: ${info} (mod ${meta[0].id} ${meta[0].version})`);
    }
    const bridge = profile.bridge ? this.bridgeJar(manifest) : null;
    if (bridge) {
      extra.push(bridge.entry);
      extraFiles.push({ name: bridge.entry.fileName, source: bridge.path });
    }
    ctx.progress(0.4, 'Resolving production profile');
    const res = await this.profiles.resolve(dir, profile.id, ctx, { mode: 'production', providedModIds: [], extraEntries: extra });
    const errors = res.issues.filter((i) => i.severity === 'error');
    if (errors.length) throw new Error(`Profile resolution has errors: ${errors.map((e) => e.message).join('; ')}`);
    ctx.progress(0.6, `Installing ${manifest.platform.loader === 'fabric' ? 'Fabric' : 'NeoForge'} server`);
    const serverArgs = manifest.platform.loader === 'fabric' ? ['-jar', await this.installFabricServer(idir, manifest, runtimeJava, ctx)] : await this.installNeoForgeServer(idir, manifest, runtimeJava, ctx);
    const files = [...Object.entries(res.files).map(([key, source]) => ({ name: res.entries.find((e) => e.key === key)?.fileName ?? path.basename(source), source })), ...extraFiles];
    this.profiles.syncInstance(idir, files, ctx);
    this.profiles.overlay(dir, profile, idir, ctx);
    const args = [`-Xmx${profile.jvm.memoryMb}M`, ...profile.jvm.args];
    let debugPort: number | undefined;
    if (profile.debug.enabled) {
      debugPort = await freePort(profile.debug.port);
      args.push(`-agentlib:jdwp=transport=dt_socket,server=y,suspend=${profile.debug.suspend ? 'y' : 'n'},address=127.0.0.1:${debugPort}`);
    }
    args.push(...serverArgs, 'nogui', ...profile.programArgs);
    const info = this.s.instances.launch({ workspace: dir, profileId: profile.id, side: 'server', mode: 'production', instanceDir: idir, java: runtimeJava.executable, args, bridge: !!bridge, debugPort, operationId: ctx.id });
    ctx.log(`Started production server pid ${info.pid}`);
    return info;
  }

  async projectArtifact(dir: string, ctx: OpContext): Promise<string | null> {
    const libs = path.join(dir, 'build', 'libs');
    if (!fs.existsSync(libs)) return null;
    const candidates = fs.readdirSync(libs).filter((f) => f.endsWith('.jar') && !/-(sources|dev|javadoc)\.jar$/.test(f)).map((f) => path.join(libs, f));
    candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (candidates.length > 1) ctx.log(`Multiple JARs in build/libs; using newest ${path.basename(candidates[0])}`);
    return candidates[0] ?? null;
  }

  datagen(root: string): OperationInfo {
    const dir = this.ws.normalize(root);
    this.ws.requireTrusted(dir);
    const { manifest } = readManifest(dir);
    if (manifest?.source.kind === 'none') throw new Error('Data generation requires a Gradle source project');
    return this.s.ops.start({ kind: 'project.datagen', title: `Run data generation for ${path.basename(dir)}`, workspace: dir }, async (ctx) => {
      const { java } = await this.projects.resolveGradleJava(dir);
      const task = manifest?.platform.loader === 'neoforge' ? 'runData' : 'runDatagen';
      const res = await runGradle({ projectDir: dir, tasks: [task], java, ctx });
      if (!res.ok) throw new Error(`${task} failed (exit ${res.exitCode}). The project may not configure data generation.`);
      return { ok: true, durationMs: res.durationMs };
    });
  }

  exportServerPack(root: string, profileId: string, output: string, zip = false): OperationInfo {
    const dir = this.ws.normalize(root);
    const manifest = this.ws.requireManifest(dir);
    const profile = manifest.profiles.find((p) => p.id === profileId);
    if (!profile) throw new Error(`Unknown profile ${profileId}`);
    const loader = manifest.platform.loader;
    if (loader !== 'fabric' && loader !== 'neoforge') throw new Error(`Server pack export is not implemented for ${loader}`);
    if (profile.side !== 'server') throw new Error(`Profile ${profileId} is not a server profile`);
    if (manifest.source.kind === 'gradle') this.ws.requireTrusted(dir);
    if (!output.trim()) throw new Error('Choose an output folder for the server pack');
    const out = path.resolve(output);
    if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error(`${out} is not empty; choose a new or empty folder`);
    return this.s.ops.start({ kind: 'server.export_pack', title: `Export server pack (${profile.name})`, workspace: dir }, async (ctx) => {
      try {
        return await this.exportServerPackInto(dir, manifest, profile, out, zip, ctx);
      } catch (e) {
        fs.rmSync(out, { recursive: true, force: true });
        throw e;
      }
    });
  }

  private async exportServerPackInto(dir: string, manifest: Manifest, original: Profile, out: string, zip: boolean, ctx: OpContext) {
    const java = await this.runtimeJava(manifest, original);
    const profile: Profile = { ...original, bridge: false };
    const { extra, extraFiles } = await this.releaseExtras(dir, manifest, profile, ctx);
    ctx.progress(0.3, 'Resolving the server profile');
    const res = await this.profiles.resolve(dir, profile.id, ctx, { mode: 'production', providedModIds: [], extraEntries: extra });
    const errors = res.issues.filter((i) => i.severity === 'error');
    if (errors.length) throw new Error(`Profile resolution has errors: ${errors.map((e) => e.message).join('; ')}`);
    fs.mkdirSync(out, { recursive: true });
    const fabric = manifest.platform.loader === 'fabric';
    ctx.progress(0.5, `Installing the ${fabric ? 'Fabric' : 'NeoForge'} server`);
    const loaderVersion = manifest.platform.loaderVersion;
    if (fabric) await this.installFabricServer(out, manifest, java, ctx);
    else await this.installNeoForgeServer(out, manifest, java, ctx);
    ctx.progress(0.8, 'Copying mods and configs');
    const files = [...Object.entries(res.files).map(([key, source]) => ({ name: res.entries.find((e) => e.key === key)?.fileName ?? path.basename(source), source })), ...extraFiles];
    this.profiles.syncInstance(out, files, ctx);
    this.profiles.overlay(dir, profile, out, ctx);
    const world = profile.world?.name;
    if (world) {
      const saved = path.join(out, 'saves', world);
      if (fs.existsSync(saved)) {
        fs.cpSync(saved, path.join(out, 'world'), { recursive: true, force: true });
        fs.rmSync(path.join(out, 'saves'), { recursive: true, force: true });
      }
    }
    for (const marker of [path.join(out, '.modsmith-server.json'), path.join(out, 'mods', '.modsmith-managed.json')]) fs.rmSync(marker, { force: true });
    for (const f of fs.readdirSync(out)) if (f.endsWith('-installer.jar.log')) fs.rmSync(path.join(out, f), { force: true });
    const memory = String(profile.jvm.memoryMb);
    const quote = (a: string) => (a.includes(' ') ? `"${a}"` : a);
    const jvm = profile.jvm.args.map(quote);
    const program = profile.programArgs.map(quote);
    let unixCmd: string;
    let winCmd: string;
    if (fabric) {
      const base = [`-Xmx${memory}M`, ...jvm, '-jar', 'fabric-server-launch.jar', 'nogui', ...program].join(' ');
      unixCmd = `java ${base}`;
      winCmd = `java ${base}`;
    } else {
      const userArgs = path.join(out, 'user_jvm_args.txt');
      let text = fs.existsSync(userArgs) ? fs.readFileSync(userArgs, 'utf8') : '';
      if (text && !text.endsWith('\n')) text += '\n';
      text += `-Xmx${memory}M\n${jvm.map((a) => `${a}\n`).join('')}`;
      fs.writeFileSync(userArgs, text);
      const libs = `libraries/net/neoforged/neoforge/${loaderVersion}`;
      const tail = ['nogui', ...program].join(' ');
      unixCmd = `java @user_jvm_args.txt @${libs}/unix_args.txt ${tail}`;
      winCmd = `java @user_jvm_args.txt @${libs.replace(/\//g, '\\')}\\win_args.txt ${tail}`;
    }
    const startSh = path.join(out, 'start.sh');
    fs.writeFileSync(startSh, `#!/usr/bin/env sh\ncd "$(dirname "$0")"\nexec ${unixCmd} "$@"\n`);
    if (process.platform !== 'win32') fs.chmodSync(startSh, 0o755);
    fs.writeFileSync(path.join(out, 'start.bat'), `@echo off\r\ncd /d "%~dp0"\r\n${winCmd} %*\r\npause\r\n`);
    const cat = manifest.platform.catalogEntry ? this.s.catalog.get(manifest.platform.catalogEntry) : undefined;
    const javaMin = profile.java.minMajor ?? cat?.runtimeJavaMin ?? 21;
    const mods = [...new Set(files.map((f) => f.name))].sort((a, b) => a.localeCompare(b));
    const minecraft = manifest.platform.minecraft;
    const readme = [
      `${manifest.name} server`,
      '',
      `Minecraft ${minecraft}, ${fabric ? 'Fabric Loader' : 'NeoForge'} ${loaderVersion}`,
      `Java ${javaMin} or newer`,
      `Memory: ${memory} MB (change -Xmx in ${fabric ? 'start.sh and start.bat' : 'user_jvm_args.txt'})`,
      '',
      'Start',
      '  Linux and macOS: ./start.sh',
      '  Windows: start.bat',
      '',
      'The first start stops after creating eula.txt. Read https://aka.ms/MinecraftEULA, set eula=true in eula.txt if you agree, and start again.',
      '',
      `Mods (${mods.length})`,
      ...mods.map((n) => `  ${n}`),
      '',
      `Exported by ${PRODUCT.name} on ${new Date().toISOString()}.`,
      '',
    ].join('\n');
    fs.writeFileSync(path.join(out, 'README.txt'), readme);
    ctx.log(`Server pack written to ${out} (${mods.length} mods)`);
    let zipFile: string | null = null;
    if (zip) {
      ctx.progress(0.92, 'Writing the zip');
      zipFile = `${out}.zip`;
      zipDir(out, zipFile);
      ctx.log(`Zipped to ${zipFile}`);
    }
    return { output: out, zip: zipFile, mods, minecraft, loader: manifest.platform.loader, loaderVersion, javaMin };
  }

  async stop(instanceId: string, force: boolean): Promise<InstanceInfo> {
    const info = this.s.instances.get(instanceId);
    if (!info) throw new Error(`Unknown instance ${instanceId}`);
    return this.s.instances.stop(instanceId, {
      force,
      graceful: async () => {
        if (!info.bridge.connected) return false;
        await this.s.bridge.call(instanceId, 'game.shutdown', {}, 5000);
        return true;
      }
    });
  }
}
