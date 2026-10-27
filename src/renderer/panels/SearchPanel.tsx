import { useEffect, useRef, useState, type ReactNode } from 'react';
import { store, useStore } from '../store';
import { Ico, type IconName } from '../ui/icons';
import { fileIconUrl } from '../icons';
import { revealMatch } from '../javaNav';
import { ask } from '../dialogs';

interface Match {
  line: number;
  column: number;
  length: number;
  text: string;
  offset: number;
}

interface FileResult {
  file: string;
  matches: Match[];
}

interface Result {
  files: FileResult[];
  fileCount: number;
  matchCount: number;
  searchedFiles: number;
  truncated: boolean;
}

interface Options {
  query: string;
  replacement: string;
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  include: string;
  exclude: string;
  showReplace: boolean;
  showFilters: boolean;
}

const saved: { options: Options; pending: { replace: boolean; query?: string } | null } = {
  options: { query: '', replacement: '', regex: false, caseSensitive: false, wholeWord: false, include: '', exclude: '', showReplace: false, showFilters: false },
  pending: null
};

export function openSearch(replace: boolean, query?: string) {
  saved.pending = { replace, query };
  store.showTool('search');
  window.dispatchEvent(new Event('mwb:search-focus'));
}

function previewReplacement(o: Options, matched: string): string {
  if (!o.regex) return o.replacement;
  try {
    const re = new RegExp(o.wholeWord ? `\\b(?:${o.query})\\b` : o.query, `${o.caseSensitive ? '' : 'i'}u`);
    return matched.replace(re, o.replacement.replace(/\\n/g, '\n').replace(/\\t/g, '\t'));
  } catch {
    return o.replacement;
  }
}

function Toggle({ icon, label, on, onChange }: { icon: IconName; label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" className={`search-toggle ${on ? 'on' : ''}`} aria-pressed={on} aria-label={label} title={label} onClick={() => onChange(!on)}>
      <Ico name={icon} size={15} />
    </button>
  );
}

export function SearchPanel() {
  const ws = useStore((s) => s.workspace)!;
  const fileVersion = useStore((s) => s.fileVersion);
  const [o, setO] = useState<Options>(saved.options);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const queryInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const replacing = useRef(false);

  const update = (patch: Partial<Options>) => setO((prev) => ({ ...prev, ...patch }));

  useEffect(() => {
    saved.options = o;
  }, [o]);

  useEffect(() => {
    const focus = () => {
      const p = saved.pending;
      saved.pending = null;
      if (p) setO((prev) => ({ ...prev, showReplace: p.replace || prev.showReplace, query: p.query || prev.query }));
      requestAnimationFrame(() => {
        const el = p?.replace && p.query ? replaceInput.current : queryInput.current;
        el?.focus();
        el?.select();
      });
    };
    focus();
    window.addEventListener('mwb:search-focus', focus);
    return () => window.removeEventListener('mwb:search-focus', focus);
  }, []);

  const run = async (opts: Options = o) => {
    const id = ++seq.current;
    if (!opts.query) {
      setResult(null);
      setError(null);
      return;
    }
    setBusy(true);
    try {
      const r = await store.call<Result>('workspace.search', { path: ws.path, query: opts.query, regex: opts.regex, caseSensitive: opts.caseSensitive, wholeWord: opts.wholeWord, include: opts.include || undefined, exclude: opts.exclude || undefined }, { quiet: true });
      if (id !== seq.current) return;
      setResult(r);
      setError(null);
      setHidden(new Set());
    } catch (err) {
      if (id !== seq.current) return;
      setResult(null);
      setError((err as Error).message);
    } finally {
      if (id === seq.current) setBusy(false);
    }
  };

  useEffect(() => {
    const t = setTimeout(() => void run(), 250);
    return () => clearTimeout(t);
  }, [ws.path, o.query, o.regex, o.caseSensitive, o.wholeWord, o.include, o.exclude]);

  useEffect(() => {
    if (!replacing.current && o.query) {
      const t = setTimeout(() => void run(), 600);
      return () => clearTimeout(t);
    }
  }, [fileVersion]);

  const visibleFiles = (result?.files ?? []).map((f) => ({ ...f, matches: f.matches.filter((m) => !hidden.has(`${f.file}:${m.line}:${m.column}`)) })).filter((f) => f.matches.length && !hidden.has(f.file));
  const shownMatches = visibleFiles.reduce((n, f) => n + f.matches.length, 0);

  const replace = async (scope: { files?: string[]; match?: { file: string; line: number; column: number } }) => {
    const targets = scope.match ? [scope.match.file] : scope.files ?? visibleFiles.map((f) => f.file);
    const dirty = targets.filter((f) => store.state.dirtyFiles.includes(f));
    const files = targets.filter((f) => !dirty.includes(f));
    if (!files.length) {
      store.toast('error', `Save ${dirty.join(', ')} first. Replace works on saved files.`);
      return;
    }
    if (!scope.match) {
      const count = visibleFiles.filter((f) => files.includes(f.file)).reduce((n, f) => n + f.matches.length, 0);
      if (!(await ask(`Replace ${count} match${count === 1 ? '' : 'es'} in ${files.length} file${files.length === 1 ? '' : 's'} with "${o.replacement}"?`, { yes: 'Replace', no: 'Cancel' }))) return;
    }
    replacing.current = true;
    try {
      const r = await store.call<{ replacements: number; files: { file: string }[] }>('workspace.replace', { path: ws.path, query: o.query, replacement: o.replacement, regex: o.regex, caseSensitive: o.caseSensitive, wholeWord: o.wholeWord, ...(scope.match ? { match: scope.match } : { files }) });
      if (!scope.match) store.toast('success', `Replaced ${r.replacements} match${r.replacements === 1 ? '' : 'es'} in ${r.files.length} file${r.files.length === 1 ? '' : 's'}${dirty.length ? `. Skipped ${dirty.join(', ')} because of unsaved changes` : ''}`);
      await run();
    } finally {
      replacing.current = false;
    }
  };

  const toggleCollapsed = (file: string) => {
    const next = new Set(collapsed);
    if (next.has(file)) next.delete(file);
    else next.add(file);
    setCollapsed(next);
  };
  const hide = (key: string) => setHidden(new Set(hidden).add(key));

  const highlight = (m: Match): ReactNode => {
    const start = m.column - m.offset;
    const before = m.text.slice(0, start);
    const lead = before.length > 40 ? `…${before.slice(-40).trimStart()}` : before.trimStart();
    const matched = m.text.slice(start, start + m.length);
    const after = m.text.slice(start + m.length);
    const replaced = o.showReplace && o.replacement !== '' ? previewReplacement(o, matched) : null;
    return (
      <>
        <span className="dim">{lead}</span>
        {replaced !== null ? (
          <>
            <del className="search-hit removed">{matched}</del>
            <ins className="search-hit added">{replaced}</ins>
          </>
        ) : (
          <mark className="search-hit">{matched}</mark>
        )}
        <span className="dim">{after}</span>
      </>
    );
  };

  return (
    <div className="search-panel">
      <div className="search-form">
        <button type="button" className="search-expand" aria-expanded={o.showReplace} aria-label={o.showReplace ? 'Hide replace' : 'Show replace'} title={o.showReplace ? 'Hide replace' : 'Show replace (Ctrl+Shift+H)'} onClick={() => update({ showReplace: !o.showReplace })}>
          <Ico name={o.showReplace ? 'chevronDown' : 'chevronRight'} size={14} />
        </button>
        <div className="col tight grow">
          <div className="search-box">
            <input
              ref={queryInput}
              value={o.query}
              placeholder="Search"
              aria-label="Search in project files"
              spellCheck={false}
              onChange={(e) => update({ query: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void run();
                if (e.altKey && e.key.toLowerCase() === 'c') update({ caseSensitive: !o.caseSensitive });
                if (e.altKey && e.key.toLowerCase() === 'w') update({ wholeWord: !o.wholeWord });
                if (e.altKey && e.key.toLowerCase() === 'r') update({ regex: !o.regex });
              }}
            />
            <Toggle icon="caseSensitive" label="Match case (Alt+C)" on={o.caseSensitive} onChange={(v) => update({ caseSensitive: v })} />
            <Toggle icon="wholeWord" label="Match whole word (Alt+W)" on={o.wholeWord} onChange={(v) => update({ wholeWord: v })} />
            <Toggle icon="regex" label="Use regular expression (Alt+R)" on={o.regex} onChange={(v) => update({ regex: v })} />
          </div>
          {o.showReplace && (
            <div className="search-box">
              <input
                ref={replaceInput}
                value={o.replacement}
                placeholder="Replace"
                aria-label="Replace with"
                spellCheck={false}
                onChange={(e) => update({ replacement: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.ctrlKey && e.altKey) void replace({});
                }}
              />
              <button type="button" className="search-toggle" aria-label="Replace all (Ctrl+Alt+Enter)" title="Replace all (Ctrl+Alt+Enter)" disabled={!shownMatches} onClick={() => void replace({})}>
                <Ico name="replaceAll" size={15} />
              </button>
            </div>
          )}
          <button type="button" className="link-btn search-filters-toggle" onClick={() => update({ showFilters: !o.showFilters })} aria-expanded={o.showFilters}>
            {o.showFilters ? 'Hide file filters' : o.include || o.exclude ? 'File filters are on' : 'Files to include or exclude'}
          </button>
          {o.showFilters && (
            <>
              <label className="field">
                <span>Files to include</span>
                <input value={o.include} placeholder="e.g. *.java, src/main/resources" spellCheck={false} onChange={(e) => update({ include: e.target.value })} />
              </label>
              <label className="field">
                <span>Files to exclude</span>
                <input value={o.exclude} placeholder="e.g. **/lang/**, *.json" spellCheck={false} onChange={(e) => update({ exclude: e.target.value })} />
              </label>
            </>
          )}
        </div>
      </div>

      <div className="search-summary">
        <span className="grow small dim">
          {busy && !result ? 'Searching…' : error ? <span className="err">{error}</span> : result ? (shownMatches ? `${shownMatches} result${shownMatches === 1 ? '' : 's'} in ${visibleFiles.length} file${visibleFiles.length === 1 ? '' : 's'}` : `No results in ${result.searchedFiles} files`) : 'Type to search the project files. Build outputs and caches are skipped.'}
          {result?.truncated ? ' (stopped at 5000; narrow the search)' : ''}
        </span>
        {result && visibleFiles.length > 0 && (
          <button type="button" className="search-toggle" aria-label="Collapse all" title="Collapse all" onClick={() => setCollapsed(new Set(visibleFiles.map((f) => f.file)))}>
            <Ico name="collapseAll" size={15} />
          </button>
        )}
        <button type="button" className="search-toggle" aria-label="Search again" title="Search again" onClick={() => void run()} disabled={!o.query}>
          <Ico name="restart" size={14} />
        </button>
      </div>

      <div className="search-results" role="tree" aria-label="Search results">
        {visibleFiles.map((f) => {
          const name = f.file.split('/').pop()!;
          const dir = f.file.split('/').slice(0, -1).join('/');
          const open = !collapsed.has(f.file);
          return (
            <div key={f.file} role="treeitem" aria-expanded={open}>
              <div className="search-file" onClick={() => toggleCollapsed(f.file)} title={f.file}>
                <Ico name={open ? 'chevronDown' : 'chevronRight'} size={13} />
                <img className="file-icon" src={fileIconUrl(name)} alt="" />
                <span className="ellipsis">{name}</span>
                <span className="mute small ellipsis grow">{dir}</span>
                <span className="search-actions">
                  {o.showReplace && (
                    <button type="button" className="search-toggle" aria-label={`Replace all in ${name}`} title={`Replace all in ${name}`} onClick={(e) => (e.stopPropagation(), void replace({ files: [f.file] }))}>
                      <Ico name="replaceAll" size={14} />
                    </button>
                  )}
                  <button type="button" className="search-toggle" aria-label={`Dismiss ${name}`} title="Dismiss" onClick={(e) => (e.stopPropagation(), hide(f.file))}>
                    <Ico name="close" size={14} />
                  </button>
                </span>
                <span className="count">{f.matches.length}</span>
              </div>
              {open &&
                f.matches.map((m) => {
                  const key = `${f.file}:${m.line}:${m.column}`;
                  return (
                    <div key={key} className="search-match" role="treeitem" tabIndex={0} title={`Line ${m.line}`} aria-label={`Line ${m.line}: ${m.text.trim()}`} onClick={() => void revealMatch(f.file, m.line, m.column, m.length)} onKeyDown={(e) => e.key === 'Enter' && void revealMatch(f.file, m.line, m.column, m.length)}>
                      <span className="search-line mute">{m.line}</span>
                      <span className="ellipsis grow search-preview">{highlight(m)}</span>
                      <span className="search-actions">
                        {o.showReplace && (
                          <button type="button" className="search-toggle" aria-label="Replace" title="Replace" onClick={(e) => (e.stopPropagation(), void replace({ match: { file: f.file, line: m.line, column: m.column } }))}>
                            <Ico name="replace" size={14} />
                          </button>
                        )}
                        <button type="button" className="search-toggle" aria-label="Dismiss" title="Dismiss" onClick={(e) => (e.stopPropagation(), hide(key))}>
                          <Ico name="close" size={14} />
                        </button>
                      </span>
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
