import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mwb-test-'));
process.env.MODSMITH_DATA_DIR = path.join(root, 'data');
process.env.MODSMITH_CACHE_DIR = path.join(root, 'cache');
process.env.MODSMITH_RESOURCES_DIR = path.resolve(__dirname, '..', 'resources');
