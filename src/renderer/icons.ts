import manifest from 'material-icon-theme/dist/material-icons.json';

interface IconManifest {
  iconDefinitions: Record<string, { iconPath: string }>;
  fileNames: Record<string, string>;
  fileExtensions: Record<string, string>;
  languageIds: Record<string, string>;
  folderNames: Record<string, string>;
  folderNamesExpanded: Record<string, string>;
  file: string;
  folder: string;
  folderExpanded: string;
}

const m = manifest as unknown as IconManifest;

const LANGUAGE_BY_EXT: Record<string, string> = {
  java: 'java',
  json: 'json',
  ts: 'typescript',
  tsx: 'typescriptreact',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  md: 'markdown',
  xml: 'xml',
  yml: 'yaml',
  yaml: 'yaml',
  groovy: 'groovy',
  kt: 'kotlin',
  py: 'python',
  html: 'html',
  css: 'css',
  sh: 'shellscript',
  bat: 'bat',
  toml: 'toml'
};

function url(id: string | undefined): string | null {
  if (!id) return null;
  const def = m.iconDefinitions[id];
  if (!def) return null;
  return `material-icons/${def.iconPath.split('/').pop()}`;
}

export function fileIconUrl(name: string): string {
  const lower = name.toLowerCase();
  const direct = url(m.fileNames[lower]);
  if (direct) return direct;
  const parts = lower.split('.');
  for (let i = 1; i < parts.length; i++) {
    const ext = parts.slice(i).join('.');
    const hit = url(m.fileExtensions[ext]);
    if (hit) return hit;
  }
  const ext = parts.length > 1 ? parts[parts.length - 1] : '';
  return url(m.languageIds[LANGUAGE_BY_EXT[ext]]) ?? url(m.file)!;
}

export function folderIconUrl(name: string, open: boolean): string {
  const lower = name.toLowerCase();
  return url((open ? m.folderNamesExpanded : m.folderNames)[lower]) ?? url(open ? m.folderExpanded : m.folder)!;
}
