import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projects = [
  { dir: 'bridge/fabric-1.21.1', jar: 'modsmith-bridge-fabric-1.21.1', javaMin: 25 },
  { dir: 'bridge/neoforge-1.21.1', jar: 'modsmith-bridge-neoforge-1.21.1', javaMin: 21 },
  { dir: 'bridge/fabric-1.20.1', jar: 'modsmith-bridge-fabric-1.20.1', javaMin: 25 },
  { dir: 'bridge/forge-1.20.1', jar: 'modsmith-bridge-forge-1.20.1', javaMin: 21, dev: true }
].filter((p) => process.argv.length <= 2 || process.argv.slice(2).some((a) => p.dir.includes(a)));

function findJdk(min) {
  const roots = ['C:\\Program Files\\Java', 'C:\\Program Files\\Eclipse Adoptium', 'C:\\Program Files\\Microsoft', 'C:\\Program Files\\Zulu'];
  const homes = [];
  if (process.env.JAVA_HOME) homes.push(process.env.JAVA_HOME);
  for (const r of roots) if (fs.existsSync(r)) for (const d of fs.readdirSync(r)) homes.push(path.join(r, d));
  for (const h of homes) {
    const rel = path.join(h, 'release');
    if (!fs.existsSync(path.join(h, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac')) || !fs.existsSync(rel)) continue;
    const m = fs.readFileSync(rel, 'utf8').match(/JAVA_VERSION="(\d+)/);
    if (m && Number(m[1]) >= min) return h;
  }
  return null;
}

for (const p of projects) {
  const dir = path.join(root, p.dir);
  const jdk = findJdk(p.javaMin);
  if (!jdk) {
    console.error(`No JDK ${p.javaMin}+ found for ${p.dir}`);
    process.exit(1);
  }
  const java = path.join(jdk, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  const res = spawnSync(java, ['-classpath', path.join(dir, 'gradle', 'wrapper', 'gradle-wrapper.jar'), 'org.gradle.wrapper.GradleWrapperMain', '--console=plain', 'build'], { cwd: dir, stdio: 'inherit', env: { ...process.env, JAVA_HOME: jdk } });
  if (res.status !== 0) process.exit(res.status ?? 1);
  const outDir = path.join(root, 'resources', 'bridge');
  fs.mkdirSync(outDir, { recursive: true });
  const copies = p.dev ? [['devlibs', p.jar], ['libs', `${p.jar}-release`]] : [['libs', p.jar]];
  for (const [folder, name] of copies) {
    fs.copyFileSync(path.join(dir, 'build', folder, `${p.jar}-0.1.0.jar`), path.join(outDir, `${name}.jar`));
    console.log(`bridge jar -> ${path.join(outDir, `${name}.jar`)}`);
  }
}
