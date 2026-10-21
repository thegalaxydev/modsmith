import { useStore } from '../store';

export function JavaDownloads() {
  const ops = useStore((s) => s.operations.filter((o) => o.kind === 'java.install' && o.status === 'running'));
  if (!ops.length) return null;
  return (
    <div className="col tight">
      {ops.map((o) => (
        <div key={o.id} className="java-download">
          <span className="small grow ellipsis">{o.message || o.title}</span>
          <div className={`progress ${o.progress === null ? 'indeterminate' : ''}`}>
            <div style={o.progress === null ? undefined : { width: `${Math.round(o.progress * 100)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}
