import type { ComponentType } from 'react';
import { LOGO } from '../../shared/logo';
import { CurseForgeMark, ModrinthMark, type BrandIconProps } from './brands';
import {
  MonitorPlay,
  House,
  Download,
  Files,
  CodeXml,
  Play,
  Square,
  RotateCw,
  Hammer,
  BrushCleaning,
  RefreshCw,
  Settings,
  Package,
  PackagePlus,
  SlidersHorizontal,
  Server,
  ScanSearch,
  Bug,
  Terminal,
  CircleAlert,
  FlaskConical,
  History,
  Plug,
  Upload,
  FolderOpen,
  Search,
  Ellipsis,
  PanelsTopLeft,
  PanelLeftClose,
  LoaderCircle,
  CircleCheck,
  CircleHelp,
  ChevronDown,
  ChevronRight,
  X,
  Plus,
  Trash2,
  Copy,
  ExternalLink,
  Camera,
  Unplug,
  TriangleAlert,
  Info,
  PanelBottom,
  PanelRight,
  FileUp,
  Wrench,
  AppWindow,
  Filter,
  FilePlus,
  Puzzle,
  BadgeCheck,
  Activity,
  Link,
  Users,
  type LucideIcon
} from 'lucide-react';

export const Icon = {
  home: House,
  files: Files,
  code: CodeXml,
  play: Play,
  stop: Square,
  restart: RotateCw,
  build: Hammer,
  cleanBuild: BrushCleaning,
  apply: RefreshCw,
  settings: Settings,
  mods: Package,
  addMod: PackagePlus,
  profiles: SlidersHorizontal,
  server: Server,
  inspect: ScanSearch,
  debug: Bug,
  diagnostics: Activity,
  link: Link,
  console: Terminal,
  problems: CircleAlert,
  tests: FlaskConical,
  activity: History,
  mcp: Plug,
  mcpOff: Unplug,
  export: Upload,
  openFolder: FolderOpen,
  search: Search,
  more: Ellipsis,
  layout: PanelsTopLeft,
  collapse: PanelLeftClose,
  loading: LoaderCircle,
  success: CircleCheck,
  help: CircleHelp,
  chevronDown: ChevronDown,
  chevronRight: ChevronRight,
  close: X,
  add: Plus,
  remove: Trash2,
  copy: Copy,
  external: ExternalLink,
  screenshot: Camera,
  warning: TriangleAlert,
  info: Info,
  drawer: PanelBottom,
  inspector: PanelRight,
  importJar: FileUp,
  datagen: Wrench,
  minecraft: MonitorPlay,
  modrinth: ModrinthMark,
  curseforge: CurseForgeMark,
  detached: AppWindow,
  filter: Filter,
  newFile: FilePlus,
  download: Download,
  multiplayer: Users,
  extension: Puzzle,
  verified: BadgeCheck
} satisfies Record<string, LucideIcon | ComponentType<BrandIconProps>>;

export type IconName = keyof typeof Icon;

export const ICON_STROKE = 1.75;

export function Ico({ name, size = 16, className, label }: { name: IconName; size?: number; className?: string; label?: string }) {
  const C = Icon[name];
  return <C size={size} strokeWidth={ICON_STROKE} className={className} aria-hidden={label ? undefined : true} aria-label={label} focusable={false} />;
}

export function SourceIcon({ source, size = 14 }: { source: string; size?: number }) {
  if (source === 'modrinth') return <Ico name="modrinth" size={size} />;
  if (source === 'curseforge') return <Ico name="curseforge" size={size} />;
  return null;
}

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox={LOGO.viewBox} xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path fill={LOGO.dark} d={LOGO.base} />
      {LOGO.faces.map((d) => (
        <path key={d} fill={LOGO.light} d={d} />
      ))}
    </svg>
  );
}

export function AppMark({ size = 28 }: { size?: number }) {
  return (
    <span className="app-mark" style={{ width: size, height: size }} aria-hidden="true">
      <Logo size={size} />
    </span>
  );
}

export function ProjectMark({ src, size = 28 }: { src?: string | null; size?: number }) {
  if (!src) return <AppMark size={size} />;
  return (
    <img
      src={src}
      width={size}
      height={size}
      className="project-mark"
      style={{ borderRadius: Math.round(size * 0.26) }}
      alt=""
      aria-hidden="true"
      draggable={false}
      onLoad={(e) => {
        if (e.currentTarget.naturalWidth < size) e.currentTarget.style.imageRendering = 'pixelated';
      }}
    />
  );
}
