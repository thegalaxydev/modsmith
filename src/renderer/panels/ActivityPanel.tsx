import { useState } from 'react';
import { useStore } from '../store';

export function ActivityPanel() {
  const activity = useStore((s) => s.activity);
  const [source, setSource] = useState('');
  const rows = activity.filter((a) => !source || a.source === source);
  return (
    <div className="col" style={{ flex: 1, minHeight: 0, gap: 0 }}>
      <div className="toolbar">
        <select value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">All sources</option>
          <option value="ui">UI</option>
          <option value="mcp">MCP (assistants)</option>
          <option value="cli">CLI</option>
        </select>
        <span className="mute">Actions from every interface go through the same service and are recorded here. Secrets are redacted.</span>
      </div>
      <div className="panel-body">
        <table className="grid">
          <thead>
            <tr>
              <th style={{ width: 90 }}>Time</th>
              <th style={{ width: 60 }}>Source</th>
              <th style={{ width: 200 }}>Action</th>
              <th>Parameters</th>
              <th style={{ width: 280 }}>Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id}>
                <td className="dim">{new Date(a.ts).toLocaleTimeString()}</td>
                <td>
                  <span className={`badge ${a.source === 'mcp' ? 'accent' : ''}`}>{a.source}</span>
                </td>
                <td className="mono">{a.action}</td>
                <td className="mono dim" style={{ fontSize: 11.5, wordBreak: 'break-all' }}>
                  {a.params.length > 220 ? a.params.slice(0, 220) + '…' : a.params}
                </td>
                <td className={a.status === 'error' ? 'err' : 'dim'} style={{ fontSize: 12 }}>
                  {a.summary}
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={5} className="mute">
                  No activity recorded.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
