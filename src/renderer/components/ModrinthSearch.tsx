import { useEffect, useState } from 'react';
import { store, useAsync } from '../store';
import { Segmented } from '../ui/controls';

export interface Hit {
  id: string;
  slug: string;
  title: string;
  description: string;
  author: string;
  downloads: number;
  iconUrl?: string;
  clientSide: string;
  serverSide: string;
  license: string;
  distribution: 'direct' | 'manual';
  url?: string;
  provider: 'modrinth' | 'curseforge';
}

export function ModrinthSearch({ loader, minecraft, onPick, actionLabel }: { loader: string; minecraft: string; onPick: (hit: Hit) => void; actionLabel: string }) {
  const [q, setQ] = useState('');
  const [provider, setProvider] = useState<'modrinth' | 'curseforge'>((localStorage.getItem('mwb.provider') as 'modrinth') ?? 'modrinth');
  const [hits, setHits] = useState<Hit[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const status = useAsync(() => store.call<{ providers: { id: string; usable: boolean; detail: string }[] }>('provider.status', {}, { quiet: true }), []);
  const cf = status.data?.providers.find((p) => p.id === 'curseforge');

  useEffect(() => {
    if (provider === 'curseforge' && cf && !cf.usable) {
      setHits([]);
      setError(cf.detail);
      return;
    }
    const t = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const r = await store.call<{ hits: Omit<Hit, 'provider'>[]; total: number; stale?: boolean; fetchedAt: number }>('dependency.search', { query: q, provider, loader, minecraft, limit: 15 }, { quiet: true });
        setHits(r.hits.map((h) => ({ ...h, provider })));
        setTotal(r.total);
        setNote(r.stale ? `Offline: showing cached results from ${new Date(r.fetchedAt).toLocaleString()}` : null);
      } catch (err) {
        setError((err as Error).message);
        setHits([]);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [q, loader, minecraft, provider, cf?.usable]);

  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="toolbar">
        <Segmented
          label="Mod source"
          value={provider}
          options={[
            { value: 'modrinth', label: 'Modrinth', icon: 'modrinth' },
            { value: 'curseforge', label: cf && !cf.usable ? 'CurseForge (needs key)' : 'CurseForge', icon: 'curseforge' }
          ]}
          onChange={(v) => {
            setProvider(v);
            localStorage.setItem('mwb.provider', v);
          }}
        />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search (${loader} ${minecraft})`} className="grow" />
        <span className="mute">{loading ? 'Searching...' : `${total} results`}</span>
      </div>
      {note && <div className="callout" style={{ margin: 8 }}>{note}</div>}
      {error && <div className="callout err" style={{ margin: 8 }}>{error}</div>}
      <div style={{ maxHeight: 300, overflow: 'auto' }}>
        {hits.map((h) => (
          <div key={h.id} className="mod-hit">
            {h.iconUrl ? <img src={h.iconUrl} alt="" /> : <div style={{ width: 32, height: 32, borderRadius: 6, background: 'var(--bg-3)' }} />}
            <div className="grow">
              <div>
                <b>{h.title}</b> <span className="mute">by {h.author}</span>
              </div>
              <div className="dim" style={{ fontSize: 12 }}>
                {h.description}
              </div>
              <div className="row wrap" style={{ marginTop: 3 }}>
                <span className="badge">{h.downloads.toLocaleString()} downloads</span>
                {h.clientSide !== 'unknown' && <span className="badge">client {h.clientSide}</span>}
                {h.serverSide !== 'unknown' && <span className="badge">server {h.serverSide}</span>}
                {h.license && <span className="badge">{h.license}</span>}
                {h.distribution === 'manual' && <span className="badge warn" title="The author disallows third-party downloads; you will need to download the file manually">manual download</span>}
              </div>
            </div>
            <button className="small" onClick={() => onPick(h)}>
              {actionLabel}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
