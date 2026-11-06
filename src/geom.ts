import type { DashKind, Obj, Stroke } from './types';

/** 2D affine: x' = a x + c y + e ; y' = b x + d y + f */
export type Mat = [number, number, number, number, number, number];
export const mul = (m: Mat, n: Mat): Mat => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
export const translateM = (x: number, y: number): Mat => [1, 0, 0, 1, x, y];
export const scaleM = (sx: number, sy: number): Mat => [sx, 0, 0, sy, 0, 0];
export const rotateM = (a: number): Mat => [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
export const about = (px: number, py: number, m: Mat): Mat => mul(translateM(px, py), mul(m, translateM(-px, -py)));

export function transformStroke(s: Stroke, m: Mat): Stroke {
  const pts = new Array<number>(s.pts.length);
  for (let i = 0; i < pts.length; i += 2) {
    const x = s.pts[i], y = s.pts[i + 1];
    pts[i] = m[0] * x + m[2] * y + m[4];
    pts[i + 1] = m[1] * x + m[3] * y + m[5];
  }
  return { ...s, pts }; // thickness is a style, not geometry: it stays the same when scaling
}

/** Transform a stroke or image by an affine matrix (images just compose the matrix). */
export function transformObj(o: Obj, m: Mat): Obj {
  return o.type === 'stroke' ? transformStroke(o, m) : { ...o, m: mul(m, o.m) };
}

/** World-space corners of an image (TL, TR, BR, BL). */
export function imageCorners(o: { iw: number; ih: number; m: Mat }): [number, number][] {
  const { iw, ih, m } = o;
  return ([[0, 0], [iw, 0], [iw, ih], [0, ih]] as [number, number][]).map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
}

export interface BB { minX: number; minY: number; maxX: number; maxY: number }
const bbCache = new WeakMap<Obj, BB>();
const pathCache = new WeakMap<Stroke, Path2D>();

/** Call after mutating a stroke in place. */
export function invalidate(s: Stroke) { bbCache.delete(s); pathCache.delete(s); }

export function objBB(s: Obj): BB {
  let b = bbCache.get(s);
  if (!b && s.type === 'image') {
    const c = imageCorners(s);
    b = { minX: Math.min(...c.map(p => p[0])), maxX: Math.max(...c.map(p => p[0])), minY: Math.min(...c.map(p => p[1])), maxY: Math.max(...c.map(p => p[1])) };
    bbCache.set(s, b);
  }
  if (!b && s.type === 'stroke') {
    b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (let i = 0; i < s.pts.length; i += 2) {
      b.minX = Math.min(b.minX, s.pts[i]); b.maxX = Math.max(b.maxX, s.pts[i]);
      b.minY = Math.min(b.minY, s.pts[i + 1]); b.maxY = Math.max(b.maxY, s.pts[i + 1]);
    }
    const h = s.width / 2;
    b.minX -= h; b.minY -= h; b.maxX += h; b.maxY += h;
    bbCache.set(s, b);
  }
  return b!;
}
export const unionBB = (a: BB | null, b: BB): BB => a
  ? { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) }
  : { ...b };

const r = (n: number) => +n.toFixed(2);
/** Smoothed SVG path (quadratic through midpoints). Used for canvas (Path2D) and SVG export. */
export function pathD(p: number[]): string {
  const n = p.length / 2;
  if (n === 1) return `M${r(p[0])} ${r(p[1])}L${r(p[0])} ${r(p[1])}`;
  let d = `M${r(p[0])} ${r(p[1])}`;
  for (let i = 1; i < n - 1; i++) {
    d += `Q${r(p[2 * i])} ${r(p[2 * i + 1])} ${r((p[2 * i] + p[2 * i + 2]) / 2)} ${r((p[2 * i + 1] + p[2 * i + 3]) / 2)}`;
  }
  return d + `L${r(p[2 * n - 2])} ${r(p[2 * n - 1])}`;
}
export function strokePath(s: Stroke): Path2D {
  let p = pathCache.get(s);
  if (!p) { p = new Path2D(pathD(s.pts)); pathCache.set(s, p); }
  return p;
}

export function pointInPoly(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Line dash pattern in canvas units. Proportional to the stroke width; accounts for the round caps adding w/2 on each end. */
export function dashPattern(kind: DashKind | undefined, w: number): number[] {
  const dot = 0.001;
  switch (kind) {
    case 'dashed': return [2.5 * w, 3 * w];
    case 'dotted': return [dot, 2.2 * w];
    case 'dashdot': return [3 * w, 2.2 * w, dot, 2.2 * w];
    case 'longdash': return [6 * w, 3 * w];
    default: return [];
  }
}
