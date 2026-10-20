import { useState } from 'react';
import { store, useStore } from '../store';
import { Button } from '../ui/controls';

export function InitManifest() {
  const ws = useStore((s) => s.workspace)!;
  const [type, setType] = useState<'mod' | 'modpack' | 'combined'>(ws.detected?.buildSystem === 'gradle' ? 'mod' : 'modpack');
  const [mc, setMc] = useState(ws.detected?.minecraftHint?.replace(/^[~^>=<\s]+/, '') ?? '1.21.1');
  const [lv, setLv] = useState(ws.detected?.loaderVersionHint ?? '0.19.5');
  return (
    <div className="form-stack">
      <label className="field">
        <span>Project type</span>
        <select value={type} onChange={(e) => setType(e.target.value as 'mod')}>
          <option value="mod">Mod project</option>
          <option value="modpack">Modpack</option>
          <option value="combined">Mod tested inside a modpack</option>
        </select>
      </label>
      <div className="row wrap">
        <label className="field grow">
          <span>Minecraft version</span>
          <input value={mc} onChange={(e) => setMc(e.target.value)} />
        </label>
        <label className="field grow">
          <span>Loader version</span>
          <input value={lv} onChange={(e) => setLv(e.target.value)} />
        </label>
      </div>
      <div>
        <Button variant="primary" icon="success" onClick={() => void store.call('workspace.init', { path: ws.path, type, minecraft: mc, loaderVersion: lv }).then(() => store.refreshWorkspace())}>
          Set up project
        </Button>
      </div>
      <div className="small dim">Creates modsmith.json and adds .modsmith/ to .gitignore. Build files are not changed.</div>
    </div>
  );
}
