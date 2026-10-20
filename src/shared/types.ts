export type LoaderId = 'fabric' | 'neoforge' | 'forge';
export type WorkspaceType = 'mod' | 'modpack' | 'combined';
export type Side = 'client' | 'server';
export type LaunchMode = 'development' | 'production';
export type CapabilityState = 'supported' | 'planned' | 'unsupported';
export type ActivitySource = 'ui' | 'mcp' | 'cli' | 'system';

export interface Capability {
  id: string;
  label: string;
  state: CapabilityState;
  detail?: string;
}

export interface JavaInstallation {
  home: string;
  executable: string;
  version: string;
  major: number;
  vendor: string;
  arch: string;
  isJdk: boolean;
  sources: string[];
}

export interface CatalogEntry {
  id: string;
  schema: 1;
  loader: LoaderId;
  minecraft: string;
  loaderVersion: string;
  status: 'verified' | 'tested' | 'unverified';
  verifiedOn?: string;
  verificationNote: string;
  gradleVersion: string;
  plugin: { id: string; version: string };
  mappings: 'mojang' | 'parchment' | 'none';
  parchment?: { minecraft: string; version: string };
  remap: boolean;
  javaRelease: number;
  gradleJavaMin: number;
  runtimeJavaMin: number;
  fabricApiVersion?: string;
  fabric?: { splitSources: boolean; logger: 'slf4j' | 'log4j'; identifier: 'ResourceLocation.new' | 'ResourceLocation.fromNamespaceAndPath' | 'Identifier.fromNamespaceAndPath' };
  templateSource: string;
  starters: string[];
  bridge: { available: boolean; jar?: string };
}

export type OperationStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface OperationInfo {
  id: string;
  kind: string;
  title: string;
  workspace?: string;
  status: OperationStatus;
  progress: number | null;
  message: string;
  startedAt: number;
  endedAt?: number;
  error?: string;
  result?: unknown;
  logTail: string[];
}

export interface Diagnostic {
  severity: 'error' | 'warning' | 'info';
  message: string;
  file?: string;
  line?: number;
  column?: number;
  source: string;
}

export interface LogLine {
  seq: number;
  ts: number;
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
  time?: string;
  thread?: string;
  level?: string;
  logger?: string;
  message?: string;
}

export type InstanceStatus = 'preparing' | 'starting' | 'running' | 'stopping' | 'exited' | 'crashed' | 'failed';

export interface InstanceInfo {
  id: string;
  workspace: string;
  profileId: string;
  side: Side;
  mode: LaunchMode;
  status: InstanceStatus;
  pid?: number;
  instanceDir: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  bridge: { connected: boolean; protocol?: number; game?: Record<string, unknown>; lastError?: string };
  debugPort?: number;
  javaExecutable?: string;
  operationId?: string;
  crashReport?: string;
  logFile: string;
}

export interface ActivityEntry {
  id: number;
  ts: number;
  source: ActivitySource;
  action: string;
  params: string;
  status: 'ok' | 'error';
  summary: string;
}

export interface FileNode {
  name: string;
  path: string;
  dir: boolean;
  children?: FileNode[];
}
