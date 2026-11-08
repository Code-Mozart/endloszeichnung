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
  let verts: number[] | undefined;
  if (s.verts) { verts = new Array<number>(s.verts.length); for (let i = 0; i < verts.length; i += 2) { const x = s.verts[i], y = s.verts[i + 1]; verts[i] = m[0] * x + m[2] * y + m[4]; verts[i + 1] = m[1] * x + m[3] * y + m[5]; } }
  return verts ? { ...s, pts, verts } : { ...s, pts }; // thickness is a style, not geometry: it stays the same when scaling
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

/** A drawn path counts as a closed shape when its ends are close together compared to its length (15%) and it really goes around. */
export const CLOSE_RATIO = 0.15;
/** Total turning of a path in radians (a loop is about 2π, a U or a hairpin about π). Scale independent: segments are len/32 long. */
export function turning(p: number[]): number {
  const n = p.length / 2; let len = 0;
  for (let i = 1; i < n; i++) len += Math.hypot(p[2 * i] - p[2 * i - 2], p[2 * i + 1] - p[2 * i - 1]);
  if (!len) return 0;
  const minSeg = len / 32, pts: [number, number][] = [[p[0], p[1]]];
  let lx = p[0], ly = p[1];
  for (let i = 1; i < n; i++) { const x = p[2 * i], y = p[2 * i + 1]; if (Math.hypot(x - lx, y - ly) >= minSeg) { pts.push([x, y]); lx = x; ly = y; } }
  let tot = 0;
  for (let i = 2; i < pts.length; i++) {
    const ax = pts[i - 1][0] - pts[i - 2][0], ay = pts[i - 1][1] - pts[i - 2][1], bx = pts[i][0] - pts[i - 1][0], by = pts[i][1] - pts[i - 1][1];
    tot += Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
  }
  return Math.abs(tot);
}
export const MIN_LOOP_TURNING = 4.2; // about 240 degrees
export function isClosedPts(p: number[]): boolean {
  const n = p.length / 2;
  if (n < 8) return false;
  let len = 0;
  for (let i = 1; i < n; i++) len += Math.hypot(p[2 * i] - p[2 * i - 2], p[2 * i + 1] - p[2 * i - 1]);
  return len > 0 && Math.hypot(p[0] - p[2 * n - 2], p[1] - p[2 * n - 1]) <= CLOSE_RATIO * len && turning(p) >= MIN_LOOP_TURNING;
}
export const strokeClosed = (s: Stroke): boolean => s.closed ?? isClosedPts(s.pts);

/** The fill of a stroke, if it has one and is a closed shape. (`true` is the older format: fill in the line color.) */
export function strokeFill(s: Stroke): { color: string; alpha: number } | null {
  if (!s.fill || !strokeClosed(s)) return null;
  return s.fill === true ? { color: s.color, alpha: s.alpha ?? 1 } : { color: s.fill, alpha: s.fillAlpha ?? 1 };
}
