export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const clamp = (n: number, lo = 0, hi = 255) => Math.min(hi, Math.max(lo, n));

export function parseColor(input: string | null | undefined): Rgba | null {
  if (!input) return null;
  const s = input.trim().toLowerCase();
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    const h = m[1];
    if (h.length === 3 || h.length === 4) {
      const v = [...h].map((c) => parseInt(c + c, 16));
      return { r: v[0], g: v[1], b: v[2], a: h.length === 4 ? v[3] / 255 : 1 };
    }
    if (h.length === 6 || h.length === 8) {
      const v = [0, 2, 4, 6].map((i) => parseInt(h.slice(i, i + 2), 16));
      return { r: v[0], g: v[1], b: v[2], a: h.length === 8 ? v[3] / 255 : 1 };
    }
    return null;
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(s);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: clamp(+m[1]), g: clamp(+m[2]), b: clamp(+m[3]), a: clamp(a, 0, 1) };
  }
  return null;
}

const hex = (n: number) => Math.round(clamp(n)).toString(16).padStart(2, '0');

export function toCss(c: Rgba): string {
  if (c.a >= 0.999) return `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`;
  return `#${hex(c.r)}${hex(c.g)}${hex(c.b)}${hex(c.a * 255)}`;
}

export function normalizeColor(input: string | null | undefined): string | null {
  const c = parseColor(input);
  return c ? toCss(c) : null;
}

export function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a + bottom.a * (1 - top.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const ch = (t: number, b: number) => (t * top.a + b * bottom.a * (1 - top.a)) / a;
  return { r: ch(top.r, bottom.r), g: ch(top.g, bottom.g), b: ch(top.b, bottom.b), a };
}

export function mix(a: string, b: string, amount: number): string {
  const x = parseColor(a);
  const y = parseColor(b);
  if (!x || !y) return a;
  return toCss({ r: x.r + (y.r - x.r) * amount, g: x.g + (y.g - x.g) * amount, b: x.b + (y.b - x.b) * amount, a: x.a + (y.a - x.a) * amount });
}

export function withAlpha(color: string, alpha: number): string {
  const c = parseColor(color);
  return c ? toCss({ ...c, a: c.a * alpha }) : color;
}

export function opaque(color: string, background: string): string {
  const c = parseColor(color);
  const b = parseColor(background);
  if (!c || !b) return color;
  return toCss(over(c, { ...b, a: 1 }));
}

export function luminance(color: string): number {
  const c = parseColor(color);
  if (!c) return 0;
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

export function contrast(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
