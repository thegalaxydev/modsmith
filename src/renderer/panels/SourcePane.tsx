import { useEffect, useRef, useState } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { java } from '@codemirror/lang-java';
import { store, useStore } from '../store';
import { javaClient } from '../lsp';
import { build } from '../actions';
import { themedEditor } from '../theme/editor';
import { forgetSources, loadSource, navContext, readOnlySource, registerEditorView, unregisterEditorView } from '../javaNav';
import { containerLabel, parseJdtUri, sourceOrigin, type SourceOrigin } from '../sourceUri';
import { Button, Notice } from '../ui/controls';

export function SourcePane({ uri, visible = true }: { uri: string; visible?: boolean }) {
  const ws = useStore((s) => s.workspace)!;
  const host = useRef<HTMLDivElement>(null);
  const [origin, setOrigin] = useState<SourceOrigin | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const jdt = parseJdtUri(uri);
  const tab = `src:${uri}`;

  useEffect(() => {
    let alive = true;
    let view: EditorView | null = null;
    setError(null);
    (async () => {
      const client = await javaClient(ws.path);
      const ctx = client && navContext(client);
      if (!client || !ctx) throw new Error('Library sources need the Java language server. Open a Java file in this project to start it.');
      const text = await loadSource(client, ctx, uri);
      if (!alive) return;
      setOrigin(sourceOrigin(text));
      view = new EditorView({
        parent: host.current!,
        state: EditorState.create({ doc: text, extensions: [basicSetup, java(), themedEditor, readOnlySource, client.plugin(uri, 'java')] })
      });
      registerEditorView(tab, view);
    })().catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
      if (view) {
        unregisterEditorView(tab, view);
        view.destroy();
      }
    };
  }, [ws.path, uri, reload]);

  const loomMinecraft = origin === 'decompiled' && ws.manifest?.platform.loader === 'fabric' && !!jdt && /^minecraft-/.test(jdt.container);
  const generate = async () => {
    setGenerating('Generating Minecraft sources with Loom (genSources). This takes a few minutes the first time.');
    try {
      const done = await build({ tasks: ['genSources'] });
      if (done?.status !== 'succeeded') return;
      const client = await javaClient(ws.path);
      const ctx = client && navContext(client);
      if (client && ctx) {
        setGenerating('Reloading the project in the Java language server…');
        client.notification('java/projectConfigurationUpdate', { uri: `${ctx.rootUri}/build.gradle` });
        await new Promise((r) => setTimeout(r, 10000));
      }
      forgetSources();
      setReload((n) => n + 1);
      store.toast('success', 'Minecraft sources generated');
    } finally {
      setGenerating(null);
    }
  };

  const where = jdt ? containerLabel(jdt) : uri;
  return (
    <div className="editor source-view" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="editor-bar">
        <span className="crumbs ellipsis" title={jdt?.qualifiedName ?? uri}>
          {(jdt ? [...jdt.pkg.split('.').filter(Boolean), jdt.binaryName] : [uri]).map((seg, i, arr) => (
            <span key={i} className={i === arr.length - 1 ? 'crumb-last' : 'crumb'}>
              {seg}
              {i < arr.length - 1 && <span className="crumb-sep">.</span>}
            </span>
          ))}
        </span>
        <span className="source-badge">Read-only</span>
        {origin && <span className={`source-badge ${origin === 'decompiled' ? 'warn' : ''}`}>{origin === 'decompiled' ? 'Decompiled' : 'Source'}</span>}
        <span className="source-from ellipsis" title={jdt?.containerPath ?? where}>
          from {where}
        </span>
      </div>
      {loomMinecraft && (
        <div className="source-note">
          <Notice
            tone="info"
            action={
              <Button size="sm" busy={!!generating} onClick={() => void generate()}>
                Generate sources
              </Button>
            }
          >
            {generating ?? 'No Minecraft sources were found, so this class was decompiled on the fly. Loom can generate sources for the whole game once; they are then used here.'}
          </Notice>
        </div>
      )}
      {error ? (
        <div className="source-error">
          <Notice tone="error">{error}</Notice>
        </div>
      ) : (
        <div className="cm-host" ref={host} key={reload} />
      )}
    </div>
  );
}
