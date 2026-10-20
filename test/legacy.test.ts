import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { migrateDataDir, migrateProject } from '../src/core/legacy';
import { tmpDir } from './helpers';

describe('legacy name migration', () => {
  it('renames project files, state folder and build references', () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, 'modworkbench.json'), '{"schemaVersion":1}');
    fs.writeFileSync(path.join(root, 'modworkbench.lock.json'), '{}');
    fs.writeFileSync(path.join(root, 'modworkbench.dependencies.gradle'), 'dependencies {}');
    fs.writeFileSync(path.join(root, 'build.gradle'), "plugins {}\napply from: 'modworkbench.dependencies.gradle'\n");
    fs.writeFileSync(path.join(root, '.gitignore'), 'build/\n.modworkbench/\n');
    fs.mkdirSync(path.join(root, '.modworkbench', 'instances'), { recursive: true });
    migrateProject(root);
    expect(fs.readdirSync(root).sort()).toEqual(['.gitignore', '.modsmith', 'build.gradle', 'modsmith.dependencies.gradle', 'modsmith.json', 'modsmith.lock.json']);
    expect(fs.readFileSync(path.join(root, 'build.gradle'), 'utf8')).toContain("apply from: 'modsmith.dependencies.gradle'");
    expect(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')).toBe('build/\n.modsmith/\n');
    expect(fs.existsSync(path.join(root, '.modsmith', 'instances'))).toBe(true);
  });

  it('leaves projects that already use the current name alone', () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, 'modworkbench.json'), 'old');
    fs.writeFileSync(path.join(root, 'modsmith.json'), 'new');
    migrateProject(root);
    expect(fs.readFileSync(path.join(root, 'modsmith.json'), 'utf8')).toBe('new');
    expect(fs.existsSync(path.join(root, 'modworkbench.json'))).toBe(true);
  });

  it('copies the database from the old data folder once', () => {
    const legacy = tmpDir();
    const data = path.join(tmpDir(), 'Modsmith');
    fs.writeFileSync(path.join(legacy, 'workbench.sqlite'), 'db');
    fs.writeFileSync(path.join(legacy, 'service.json'), '{}');
    migrateDataDir(legacy, data);
    expect(fs.readdirSync(data)).toEqual(['workbench.sqlite']);
    fs.writeFileSync(path.join(legacy, 'workbench.sqlite'), 'changed');
    migrateDataDir(legacy, data);
    expect(fs.readFileSync(path.join(data, 'workbench.sqlite'), 'utf8')).toBe('db');
  });
});
