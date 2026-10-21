import { LSPClient, languageServerExtensions, type Transport } from '@codemirror/lsp-client';
import type { Extension } from '@codemirror/state';
import { useEffect, useState } from 'react';
import { store } from './store';
import { semanticTokens } from './theme/editor';
import { ModsmithWorkspace, javaNavigation } from './javaNav';

export interface LspStatus {
  language: string;
  server: string;
  version: string;
  size: number;
  installed: boolean;
  javaMin: number;
  java: string | null;
  trusted: boolean;
  session: string | null;
}

export type LspPhase = 'off' | 'starting' | 'importing' | 'ready' | 'error' | 'stopped';

interface Connection {
  workspace: string;
  session: string;
  rootUri: string;
  client: LSPClient;
  phase: LspPhase;
  message: string;
  dispose: () => void;
}

const connections = new Map<string, Promise<Connection>>();
const phaseListeners = new Set<() => void>();
let current: { workspace: string; phase: LspPhase; message: string } = { workspace: '', phase: 'off', message: '' };

function setPhase(workspace: string, phase: LspPhase, message = '') {
  current = { workspace, phase, message };
  phaseListeners.forEach((l) => l());
}

export function useLspPhase(workspace: string) {
  const [, tick] = useState(0);
  useEffect(() => {
    const l = () => tick((n) => n + 1);
    phaseListeners.add(l);
    return () => void phaseListeners.delete(l);
  }, []);
  return current.workspace === workspace ? current : { workspace, phase: 'off' as LspPhase, message: '' };
}

export function documentUri(rootUri: string, file: string) {
  return `${rootUri}/${file.split('/').map(encodeURIComponent).join('/')}`;
}

export async function stopLanguageServers(except?: string) {
  for (const [key, pending] of [...connections.entries()]) {
    const workspace = key.split('|')[0];
    if (workspace === except) continue;
    connections.delete(key);
    const c = await pending.catch(() => null);
    c?.dispose();
  }
}

async function connect(workspace: string, language: string): Promise<Connection> {
  setPhase(workspace, 'starting', 'Starting the Java language server');
  const r = await store.call<{ session: string; rootUri: string; initializationOptions: unknown }>('lsp.start', { path: workspace, language }, { quiet: true });
  const handlers = new Set<(value: string) => void>();
  let alive = true;
  let initFailed = false;
  const listener = (session: string, message: string | null) => {
    if (session !== r.session) return;
    if (message === null) {
      alive = false;
      connections.delete(`${workspace}|${language}`);
      setPhase(workspace, 'stopped', 'The Java language server stopped');
      return;
    }
    handlers.forEach((h) => h(message));
  };
  store.lspListeners.add(listener);
  const transport: Transport = {
    send(message: string) {
      if (alive) void store.call('lsp.send', { session: r.session, message }, { quiet: true }).catch(() => undefined);
    },
    subscribe(handler) {
      handlers.add(handler);
    },
    unsubscribe(handler) {
      handlers.delete(handler);
    }
  };
  const client = new LSPClient({
    rootUri: r.rootUri,
    initializationOptions: r.initializationOptions,
    timeout: 120000,
    extensions: [...languageServerExtensions(), semanticTokens(), javaNavigation()],
    workspace: (c) => new ModsmithWorkspace(c, { workspace, rootUri: r.rootUri }),
    notificationHandlers: {
      'language/status': (_c, params: { type?: string; message?: string }) => {
        if (initFailed) return true;
        const type = params?.type ?? '';
        if (type === 'Started' || type === 'ServiceReady') setPhase(workspace, 'ready', 'Java language server ready');
        else if (type === 'Error') setPhase(workspace, 'error', params.message ?? 'The Java language server reported an error');
        else if (current.phase !== 'ready') setPhase(workspace, 'importing', params.message ?? 'Importing the Gradle project');
        return true;
      },
      'language/progressReport': () => true,
      'language/eventNotification': () => true,
      'language/actionableNotification': () => true
    },
    unhandledNotification: () => undefined
  }).connect(transport);
  const connection: Connection = {
    workspace,
    session: r.session,
    rootUri: r.rootUri,
    client,
    phase: 'starting',
    message: '',
    dispose: () => {
      alive = false;
      store.lspListeners.delete(listener);
      client.disconnect();
      void store.call('lsp.stop', { session: r.session }, { quiet: true }).catch(() => undefined);
      if (current.workspace === workspace) setPhase(workspace, 'off');
    }
  };
  client.initializing.then(
    () => {
      if (current.phase === 'starting') setPhase(workspace, 'importing', 'Importing the Gradle project');
    },
    (e: Error) => {
      initFailed = true;
      connections.delete(`${workspace}|${language}`);
      connection.dispose();
      setPhase(workspace, 'error', `The Java language server did not start: ${e.message}`);
    }
  );
  return connection;
}

export async function languageServerFor(workspace: string, file: string, language = 'java'): Promise<Extension> {
  await stopLanguageServers(workspace);
  const key = `${workspace}|${language}`;
  let pending = connections.get(key);
  if (!pending) {
    pending = connect(workspace, language);
    connections.set(key, pending);
    pending.catch((e: Error) => {
      connections.delete(key);
      setPhase(workspace, 'error', e.message);
    });
  }
  const c = await pending;
  return c.client.plugin(documentUri(c.rootUri, file), language);
}

export async function javaClient(workspace: string, language = 'java'): Promise<LSPClient | null> {
  const pending = connections.get(`${workspace}|${language}`);
  if (!pending) return null;
  const c = await pending.catch(() => null);
  if (!c) return null;
  await c.client.initializing.catch(() => undefined);
  return c.client;
}

export async function startLanguageServer(workspace: string, language = 'java') {
  const st = await lspStatus(workspace, language);
  if (!st.installed || !st.trusted || !st.java) return st;
  await stopLanguageServers(workspace);
  const key = `${workspace}|${language}`;
  if (!connections.has(key)) {
    const pending = connect(workspace, language);
    connections.set(key, pending);
    pending.catch((e: Error) => {
      connections.delete(key);
      setPhase(workspace, 'error', e.message);
    });
  }
  return st;
}

export function lspStatus(workspace: string, language = 'java') {
  return store.call<LspStatus>('lsp.status', { path: workspace, language }, { quiet: true });
}
