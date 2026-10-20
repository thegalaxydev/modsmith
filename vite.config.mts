import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { cpSync, copyFileSync } from 'node:fs';
import path from 'node:path';

function materialIcons(): Plugin {
  return {
    name: 'material-icons',
    closeBundle() {
      const src = path.resolve('node_modules/material-icon-theme');
      const out = path.resolve('dist/renderer/material-icons');
      cpSync(path.join(src, 'icons'), out, { recursive: true });
      copyFileSync(path.join(src, 'LICENSE'), path.join(out, 'LICENSE.material-icon-theme.txt'));
    }
  };
}

export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react(), materialIcons()],
  publicDir: false,
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000
  },
  server: { port: 5173, strictPort: true }
});
