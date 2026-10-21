import { useEffect, useRef, useState } from 'react';
import { store, useStore } from '../store';
import { drawModel, loadImages, type ResolvedModel } from '../modelRender';

const MODEL_FILE = /(?:^|\/)assets\/([a-z0-9_.-]+)\/models\/(.+)\.json$/;
const BLOCKSTATE_FILE = /(?:^|\/)assets\/[a-z0-9_.-]+\/blockstates\/.+\.json$/;
const ITEM_FILE = /(?:^|\/)assets\/[a-z0-9_.-]+\/items\/.+\.json$/;

export function isPreviewable(file: string) {
  const f = file.replace(/\\/g, '/');
  return MODEL_FILE.test(f) || BLOCKSTATE_FILE.test(f) || ITEM_FILE.test(f);
}

function firstModel(json: unknown): string | null {
  if (Array.isArray(json)) {
    for (const v of json) {
      const m = firstModel(v);
      if (m) return m;
    }
  } else if (json && typeof json === 'object') {
    for (const [k, v] of Object.entries(json)) {
      if (k === 'model' && typeof v === 'string') return v;
      const m = firstModel(v);
      if (m) return m;
    }
  }
  return null;
}

export function previewTarget(file: string, text: string): string | null {
  const f = file.replace(/\\/g, '/');
  const m = MODEL_FILE.exec(f);
  if (m) return `${m[1]}:${m[2]}`;
  try {
    return firstModel(JSON.parse(text));
  } catch {
    return null;
  }
}

export function ModelPreview({ file, text }: { file: string; text: string }) {
  const ws = useStore((s) => s.workspace)!;
  const fileVersion = useStore((s) => s.fileVersion);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [model, setModel] = useState<ResolvedModel | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const target = previewTarget(file, text);

  useEffect(() => {
    let alive = true;
    if (!target) {
      setModel(null);
      setState('empty');
      return;
    }
    setState('loading');
    store
      .call<ResolvedModel>('assets.model', { path: ws.path, model: target }, { quiet: true })
      .then(async (r) => {
        const images = await loadImages(r.images);
        if (!alive) return;
        setModel(r);
        const drew = canvas.current ? drawModel(canvas.current, r, images) : false;
        setState(drew ? 'ready' : 'empty');
      })
      .catch((e: Error) => {
        if (!alive) return;
        setError(e.message);
        setState('error');
      });
    return () => {
      alive = false;
    };
  }, [ws.path, target, fileVersion]);

  return (
    <aside className="model-preview" aria-label="Model preview">
      <div className="model-preview-head">
        <span className="small dim">Preview</span>
        {target && <span className="mono small ellipsis" title={target}>{target}</span>}
      </div>
      <canvas ref={canvas} width={192} height={192} className="model-preview-canvas" />
      {state === 'loading' && <div className="small dim">Loading…</div>}
      {state === 'error' && <div className="small err">{error}</div>}
      {state === 'empty' && (
        <div className="small dim">
          {!target ? 'No model in this file.' : model?.builtin ? `Drawn by the game in code (${model.builtin}); no preview.` : 'Nothing to draw for this model.'}
        </div>
      )}
      {model && model.missing.length > 0 && (
        <div className="model-preview-missing small">
          <span className="warn">Missing</span>
          {model.missing.map((m) => (
            <div key={m} className="mono ellipsis" title={m}>
              {m}
            </div>
          ))}
        </div>
      )}
      {model && model.chain.length > 1 && (
        <div className="small dim model-preview-chain" title={model.chain.join(' → ')}>
          Parents: {model.chain.slice(1).join(' → ')}
        </div>
      )}
    </aside>
  );
}
