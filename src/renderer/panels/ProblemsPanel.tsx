import { store, useAsync, useStore } from '../store';

export function ProblemsPanel({ onOpenFile }: { onOpenFile: (p: string) => void }) {
  const ws = useStore((s) => s.workspace)!;
  const diagnostics = useStore((s) => s.diagnostics);
  const validation = useAsync(() => store.call<{ problems: { severity: string; message: string }[]; ok: boolean }>('project.validate', { path: ws.path }, { quiet: true }), [ws.path, JSON.stringify(ws.manifest), ws.lockProfiles.join()]);
  const rel = (f?: string) => (f && f.toLowerCase().startsWith(ws.path.toLowerCase()) ? f.slice(ws.path.length + 1).replace(/\\/g, '/') : f);
  return (
    <div className="panel-body">
      <table className="grid">
        <thead>
          <tr>
            <th style={{ width: 80 }}>Severity</th>
            <th>Message</th>
            <th style={{ width: 280 }}>Location</th>
            <th style={{ width: 90 }}>Source</th>
          </tr>
        </thead>
        <tbody>
          {diagnostics.map((d, i) => (
            <tr key={`d${i}`}>
              <td className={d.severity === 'error' ? 'err' : d.severity === 'warning' ? 'warn' : 'dim'}>{d.severity}</td>
              <td style={{ whiteSpace: 'pre-wrap' }}>{d.message}</td>
              <td className="mono">
                {d.file ? (
                  <a onClick={() => rel(d.file) && !rel(d.file)!.includes(':') && onOpenFile(rel(d.file)!)}>
                    {rel(d.file)}
                    {d.line ? `:${d.line}` : ''}
                  </a>
                ) : (
                  ''
                )}
              </td>
              <td className="dim">{d.source}</td>
            </tr>
          ))}
          {validation.data?.problems.map((p, i) => (
            <tr key={`v${i}`}>
              <td className={p.severity === 'error' ? 'err' : p.severity === 'warning' ? 'warn' : 'dim'}>{p.severity}</td>
              <td>{p.message}</td>
              <td />
              <td className="dim">validation</td>
            </tr>
          ))}
          {!diagnostics.length && !validation.data?.problems.length && (
            <tr>
              <td colSpan={4} className="mute">
                No problems. Build diagnostics appear here after a build; workspace validation runs automatically.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
