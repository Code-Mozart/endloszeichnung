/** Hold-to-snap shape recognition: closed strokes that look like a rectangle or ellipse/circle. */
export type Snap = { kind: 'shape'; pts: number[] } | { kind: 'open' } | { kind: 'none' };

const ELLIPSE_MAX_ERR = 0.12; // mean |normalized radius - 1|
const RECT_MAX_ERR = 0.05; // mean distance to nearest side / mean side length
const RECT_BIAS = 3; // a circle fits a square box with ~0.05 error, a square fits an ellipse with ~0.15

function resample(pts: number[], n: number): [number, number][] {
  const m = pts.length / 2, cum = [0];
  for (let i = 1; i < m; i++) cum.push(cum[i - 1] + Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1]));
  const L = cum[m - 1], out: [number, number][] = [];
  let j = 1;
  for (let k = 0; k < n; k++) {
    const d = (L * k) / (n - 1);
    while (j < m - 1 && cum[j] < d) j++;
    const seg = cum[j] - cum[j - 1] || 1, t = (d - cum[j - 1]) / seg;
    out.push([pts[2 * j - 2] + (pts[2 * j] - pts[2 * j - 2]) * t, pts[2 * j - 1] + (pts[2 * j + 1] - pts[2 * j - 1]) * t]);
  }
  return out;
}

/** step = desired node spacing in world units. */
export function snapShape(pts: number[], step: number): Snap {
  const n = pts.length / 2;
  if (n < 4) return { kind: 'open' };
  let L = 0;
  for (let i = 1; i < n; i++) L += Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1]);
  const gap = Math.hypot(pts[0] - pts[2 * n - 2], pts[1] - pts[2 * n - 1]);
  if (L < step * 8 || gap > 0.2 * L) return { kind: 'open' }; // tiny or not closed: behaves like a line

  const P = resample(pts, 72);
  let bestE = { err: Infinity, th: 0 }, bestR = { err: Infinity, th: 0 };
  for (let deg = 0; deg < 90; deg += 3) {
    const th = (deg * Math.PI) / 180, c = Math.cos(th), s = Math.sin(th);
    const Q = P.map(([x, y]) => [x * c + y * s, -x * s + y * c]);
    const minX = Math.min(...Q.map(q => q[0])), maxX = Math.max(...Q.map(q => q[0]));
    const minY = Math.min(...Q.map(q => q[1])), maxY = Math.max(...Q.map(q => q[1]));
    const w = maxX - minX, h = maxY - minY;
    if (w < 1e-6 || h < 1e-6) continue;
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    let e = 0, r = 0;
    for (const [x, y] of Q) {
      e += Math.abs(Math.hypot((x - cx) / (w / 2), (y - cy) / (h / 2)) - 1);
      r += Math.min(x - minX, maxX - x, y - minY, maxY - y);
    }
    e /= Q.length; r /= Q.length * ((w + h) / 2);
    if (e < bestE.err) bestE = { err: e, th };
    if (r < bestR.err) bestR = { err: r, th };
  }
  const useEllipse = bestE.err < RECT_BIAS * bestR.err;
  if (useEllipse ? bestE.err > ELLIPSE_MAX_ERR : bestR.err > RECT_MAX_ERR) return { kind: 'none' };

  const th = useEllipse ? bestE.th : bestR.th, c = Math.cos(th), s = Math.sin(th);
  const Q = P.map(([x, y]) => [x * c + y * s, -x * s + y * c]);
  const minX = Math.min(...Q.map(q => q[0])), maxX = Math.max(...Q.map(q => q[0]));
  const minY = Math.min(...Q.map(q => q[1])), maxY = Math.max(...Q.map(q => q[1]));
  const back = (x: number, y: number): [number, number] => [x * c - y * s, x * s + y * c]; // rotate back by +th
  const out: number[] = [];
  const cap = (k: number) => Math.min(4000, Math.max(2, Math.ceil(k)));
  if (useEllipse) {
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    let rx = (maxX - minX) / 2, ry = (maxY - minY) / 2;
    if (Math.abs(rx - ry) / Math.max(rx, ry) < 0.12) rx = ry = (rx + ry) / 2; // near-circle -> true circle
    const k = Math.max(24, cap((2 * Math.PI * Math.sqrt((rx * rx + ry * ry) / 2)) / step));
    for (let i = 0; i <= k; i++) { const t = (i / k) * 2 * Math.PI; out.push(...back(cx + rx * Math.cos(t), cy + ry * Math.sin(t))); }
  } else {
    const corners: [number, number][] = [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY]];
    for (let e = 0; e < 4; e++) {
      const [x0, y0] = corners[e], [x1, y1] = corners[e + 1], k = cap(Math.hypot(x1 - x0, y1 - y0) / step);
      for (let i = 0; i < k; i++) out.push(...back(x0 + ((x1 - x0) * i) / k, y0 + ((y1 - y0) * i) / k));
    }
    out.push(...back(minX, minY));
  }
  return { kind: 'shape', pts: out };
}
