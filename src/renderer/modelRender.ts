export interface ResolvedModel {
  id: string;
  chain: string[];
  generated: boolean;
  builtin: string | null;
  elements: Element[] | null;
  textures: Record<string, string>;
  display: { rotation?: number[]; scale?: number[] } | null;
  guiLight: string | null;
  images: Record<string, string>;
  missing: string[];
}

interface Face {
  texture?: string;
  uv?: number[];
  rotation?: number;
  tintindex?: number;
}

interface Element {
  from: number[];
  to: number[];
  rotation?: { origin?: number[]; axis?: 'x' | 'y' | 'z'; angle?: number };
  faces?: Partial<Record<Dir, Face>>;
}

type Dir = 'north' | 'south' | 'east' | 'west' | 'up' | 'down';
type V3 = [number, number, number];
type V2 = [number, number];

const SHADE: Record<Dir, number> = { up: 0, down: 0.5, north: 0.2, south: 0.2, east: 0.4, west: 0.4 };
const TINT = '#7cbd6b';

export async function loadImages(images: Record<string, string>): Promise<Map<string, HTMLImageElement>> {
  const out = new Map<string, HTMLImageElement>();
  await Promise.all(
    Object.entries(images).map(
      ([id, b64]) =>
        new Promise<void>((resolve) => {
          const img = new Image();
          img.onload = () => (out.set(id, img), resolve());
          img.onerror = () => resolve();
          img.src = `data:image/png;base64,${b64}`;
        })
    )
  );
  return out;
}

function frame(img: HTMLImageElement) {
  return { w: img.naturalWidth, h: Math.min(img.naturalHeight, img.naturalWidth) };
}

const variants = new WeakMap<HTMLImageElement, Map<string, HTMLCanvasElement | HTMLImageElement>>();

function shaded(img: HTMLImageElement, tinted: boolean, shade: number): HTMLCanvasElement | HTMLImageElement {
  if (!tinted && shade <= 0) return img;
  let cache = variants.get(img);
  if (!cache) variants.set(img, (cache = new Map()));
  const key = `${tinted}|${shade}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const g = c.getContext('2d')!;
  g.drawImage(img, 0, 0);
  g.globalCompositeOperation = 'multiply';
  if (tinted) {
    g.fillStyle = TINT;
    g.fillRect(0, 0, c.width, c.height);
  }
  if (shade > 0) {
    const v = Math.round(255 * (1 - shade));
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(0, 0, c.width, c.height);
  }
  g.globalCompositeOperation = 'destination-in';
  g.drawImage(img, 0, 0);
  cache.set(key, c);
  return c;
}

function corners(dir: Dir, f: number[], t: number[]): [V3, V3, V3, V3] {
  const [x0, y0, z0] = f;
  const [x1, y1, z1] = t;
  switch (dir) {
    case 'north':
      return [[x1, y1, z0], [x0, y1, z0], [x0, y0, z0], [x1, y0, z0]];
    case 'south':
      return [[x0, y1, z1], [x1, y1, z1], [x1, y0, z1], [x0, y0, z1]];
    case 'west':
      return [[x0, y1, z0], [x0, y1, z1], [x0, y0, z1], [x0, y0, z0]];
    case 'east':
      return [[x1, y1, z1], [x1, y1, z0], [x1, y0, z0], [x1, y0, z1]];
    case 'up':
      return [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]];
    case 'down':
      return [[x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x0, y0, z0]];
  }
}

function defaultUv(dir: Dir, f: number[], t: number[]): number[] {
  const [x0, y0, z0] = f;
  const [x1, y1, z1] = t;
  switch (dir) {
    case 'north':
      return [16 - x1, 16 - y1, 16 - x0, 16 - y0];
    case 'south':
      return [x0, 16 - y1, x1, 16 - y0];
    case 'west':
      return [z0, 16 - y1, z1, 16 - y0];
    case 'east':
      return [16 - z1, 16 - y1, 16 - z0, 16 - y0];
    case 'up':
      return [x0, z0, x1, z1];
    case 'down':
      return [x0, 16 - z1, x1, 16 - z0];
  }
}

function rotateAround(p: V3, origin: number[], axis: 'x' | 'y' | 'z', deg: number): V3 {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const [x, y, z] = [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]];
  let r: V3;
  if (axis === 'x') r = [x, y * c - z * s, y * s + z * c];
  else if (axis === 'y') r = [x * c + z * s, y, -x * s + z * c];
  else r = [x * c - y * s, x * s + y * c, z];
  return [r[0] + origin[0], r[1] + origin[1], r[2] + origin[2]];
}

function view(p: V3, rx: number, ry: number): V3 {
  const [x, y, z] = [p[0] - 8, p[1] - 8, p[2] - 8];
  const cy = Math.cos(ry);
  const sy = Math.sin(ry);
  const x1 = x * cy + z * sy;
  const z1 = -x * sy + z * cy;
  const cx = Math.cos(rx);
  const sx = Math.sin(rx);
  return [x1, y * cx - z1 * sx, y * sx + z1 * cx];
}

function texFor(model: ResolvedModel, ref: string | undefined, images: Map<string, HTMLImageElement>) {
  if (!ref) return null;
  const key = ref.startsWith('#') ? ref.slice(1) : ref;
  const id = model.textures[key] ?? (ref.startsWith('#') ? undefined : ref.includes(':') ? ref : `minecraft:${ref}`);
  return id ? (images.get(id) ?? null) : null;
}

function drawFlat(g: CanvasRenderingContext2D, size: number, model: ResolvedModel, images: Map<string, HTMLImageElement>) {
  const layers = Object.keys(model.textures)
    .filter((k) => /^layer\d+$/.test(k))
    .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
  const pad = size * 0.1;
  for (const k of layers) {
    const img = images.get(model.textures[k]);
    if (!img) continue;
    const { w, h } = frame(img);
    g.drawImage(img, 0, 0, w, h, pad, pad, size - 2 * pad, size - 2 * pad);
  }
  return layers.some((k) => images.has(model.textures[k]));
}

export function drawModel(canvas: HTMLCanvasElement, model: ResolvedModel, images: Map<string, HTMLImageElement>): boolean {
  const size = canvas.width;
  const g = canvas.getContext('2d')!;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, size, size);
  g.imageSmoothingEnabled = false;
  if (model.generated) return drawFlat(g, size, model, images);
  const elements = model.elements ?? [];
  if (!elements.length) return false;
  const rot = model.display?.rotation ?? [30, 225, 0];
  const rx = (rot[0] * Math.PI) / 180;
  const ry = (-rot[1] * Math.PI) / 180;
  const faces: { pts: V3[]; dir: Dir; face: Face; el: Element; depth: number }[] = [];
  for (const el of elements) {
    for (const [dir, face] of Object.entries(el.faces ?? {}) as [Dir, Face][]) {
      if (!face) continue;
      let pts = corners(dir, el.from, el.to) as V3[];
      if (el.rotation?.axis && el.rotation.angle) pts = pts.map((p) => rotateAround(p, el.rotation!.origin ?? [8, 8, 8], el.rotation!.axis!, el.rotation!.angle!));
      const v = pts.map((p) => view(p, rx, ry));
      const nx = (v[1][0] - v[0][0]) * (v[3][1] - v[0][1]) - (v[1][1] - v[0][1]) * (v[3][0] - v[0][0]);
      if (nx >= 0) continue;
      faces.push({ pts: v, dir, face, el, depth: v.reduce((s, p) => s + p[2], 0) / 4 });
    }
  }
  if (!faces.length) return false;
  faces.sort((a, b) => a.depth - b.depth);
  const all = faces.flatMap((f) => f.pts);
  const minX = Math.min(...all.map((p) => p[0]));
  const maxX = Math.max(...all.map((p) => p[0]));
  const minY = Math.min(...all.map((p) => -p[1]));
  const maxY = Math.max(...all.map((p) => -p[1]));
  const scale = (size * 0.84) / Math.max(maxX - minX, maxY - minY, 1);
  const ox = size / 2 - ((minX + maxX) / 2) * scale;
  const oy = size / 2 - ((minY + maxY) / 2) * scale;
  const screen = (p: V3): V2 => [ox + p[0] * scale, oy - p[1] * scale];
  let drew = false;
  for (const { pts, dir, face, el } of faces) {
    const img = texFor(model, face.texture, images);
    const s = pts.map(screen);
    g.save();
    g.beginPath();
    g.moveTo(s[0][0], s[0][1]);
    for (let i = 1; i < 4; i++) g.lineTo(s[i][0], s[i][1]);
    g.closePath();
    g.clip();
    if (img) {
      const { w, h } = frame(img);
      const uv = face.uv ?? defaultUv(dir, el.from, el.to);
      const c: V2[] = [
        [uv[0], uv[1]],
        [uv[2], uv[1]],
        [uv[2], uv[3]],
        [uv[0], uv[3]]
      ];
      const k = (((face.rotation ?? 0) / 90) % 4 + 4) % 4;
      const A = c[k];
      const B = c[(k + 1) % 4];
      const D = c[(k + 3) % 4];
      const du: V2 = [B[0] - A[0], B[1] - A[1]];
      const dv: V2 = [D[0] - A[0], D[1] - A[1]];
      const det = du[0] * dv[1] - du[1] * dv[0];
      if (Math.abs(det) > 1e-9) {
        const sa = s[0];
        const sb = s[1];
        const sd = s[3];
        const e: V2 = [sb[0] - sa[0], sb[1] - sa[1]];
        const f: V2 = [sd[0] - sa[0], sd[1] - sa[1]];
        const m11 = (e[0] * dv[1] - f[0] * du[1]) / det;
        const m12 = (f[0] * du[0] - e[0] * dv[0]) / det;
        const m21 = (e[1] * dv[1] - f[1] * du[1]) / det;
        const m22 = (f[1] * du[0] - e[1] * dv[0]) / det;
        const px = 16 / w;
        const py = 16 / h;
        const tx = sa[0] - (m11 * A[0] + m12 * A[1]);
        const ty = sa[1] - (m21 * A[0] + m22 * A[1]);
        g.setTransform(m11 * px, m21 * px, m12 * py, m22 * py, tx, ty);
        g.drawImage(shaded(img, face.tintindex !== undefined, model.guiLight === 'front' ? 0 : SHADE[dir]), 0, 0, w, h, 0, 0, w, h);
        g.setTransform(1, 0, 0, 1, 0, 0);
        drew = true;
      }
    } else {
      g.fillStyle = '#d000d0';
      g.fill();
    }
    g.restore();
  }
  return drew;
}
