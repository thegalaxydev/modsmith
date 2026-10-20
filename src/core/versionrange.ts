type Part = number | string;

function parts(v: string): { core: Part[]; pre: Part[] } {
  const clean = v.trim().replace(/^v/i, '').split('+')[0];
  const dash = clean.indexOf('-');
  const split = (s: string) => s.split(/[.\-_]/).filter(Boolean).map((p) => (/^\d+$/.test(p) ? Number(p) : p.toLowerCase()));
  return dash >= 0 ? { core: split(clean.slice(0, dash)), pre: split(clean.slice(dash + 1)) } : { core: split(clean), pre: [] };
}

function cmpPart(a: Part | undefined, b: Part | undefined): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return typeof b === 'number' && b === 0 ? 0 : -1;
  if (b === undefined) return typeof a === 'number' && a === 0 ? 0 : 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'number') return 1;
  if (typeof b === 'number') return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareVersions(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.core.length, pb.core.length); i++) {
    const c = cmpPart(pa.core[i], pb.core[i]);
    if (c) return c;
  }
  if (!pa.pre.length && pb.pre.length) return 1;
  if (pa.pre.length && !pb.pre.length) return -1;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const c = cmpPart(pa.pre[i], pb.pre[i]);
    if (c) return c;
  }
  return 0;
}

function bump(v: string, index: number): string {
  const nums = parts(v).core.map((p) => (typeof p === 'number' ? p : 0));
  while (nums.length <= index) nums.push(0);
  nums[index]++;
  return nums.slice(0, index + 1).join('.');
}

function comparator(term: string, version: string): boolean | null {
  const m = /^(>=|<=|>|<|=|~|\^)?\s*(.+)$/.exec(term.trim());
  if (!m) return null;
  const op = m[1] ?? '=';
  const target = m[2];
  if (target === '*' || /^x$/i.test(target)) return true;
  if (/[.\-]x$|[.\-]\*$/i.test(target) && (op === '=' || !m[1])) {
    const prefix = target.replace(/[.\-](x|\*)$/i, '');
    const v = parts(version).core;
    const p = parts(prefix).core;
    return p.every((x, i) => cmpPart(v[i], x) === 0);
  }
  if (!/\d/.test(target)) return null;
  const c = compareVersions(version, target);
  switch (op) {
    case '>=':
      return c >= 0;
    case '<=':
      return c <= 0;
    case '>':
      return c > 0;
    case '<':
      return c < 0;
    case '~':
      return c >= 0 && compareVersions(version, bump(target, Math.min(1, parts(target).core.length - 1))) < 0;
    case '^': {
      const first = parts(target).core.findIndex((p) => p !== 0);
      return c >= 0 && compareVersions(version, bump(target, Math.max(0, first))) < 0;
    }
    default:
      return c === 0;
  }
}

function mavenRange(range: string, version: string): boolean | null {
  const sets = range.match(/[[(][^\])]*[\])]/g);
  if (!sets) return null;
  return sets.some((set) => {
    const lowInc = set.startsWith('[');
    const highInc = set.endsWith(']');
    const [low, high] = set.slice(1, -1).split(',').map((s) => s?.trim());
    if (high === undefined) return low ? compareVersions(version, low) === 0 : true;
    if (low && (lowInc ? compareVersions(version, low) < 0 : compareVersions(version, low) <= 0)) return false;
    if (high && (highInc ? compareVersions(version, high) > 0 : compareVersions(version, high) >= 0)) return false;
    return true;
  });
}

export function satisfies(version: string, predicate: string): boolean | null {
  const p = predicate.trim();
  if (!p || p === '*') return true;
  if (!version || !/\d/.test(version)) return null;
  if (/^[[(]/.test(p)) return mavenRange(p, version);
  let unknown = false;
  for (const alt of p.split('||')) {
    const terms = alt.trim().split(/\s+/).filter(Boolean);
    if (!terms.length) continue;
    let all = true;
    for (const t of terms) {
      const r = comparator(t, version);
      if (r === null) unknown = true;
      if (r !== true) all = false;
    }
    if (all) return true;
  }
  return unknown ? null : false;
}
