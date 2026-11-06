import { Stroke } from './types';
import { pathD, strokeBB, strokePath, unionBB, BB } from './geom';

export function bounds(strokes: Stroke[], pad = 20): BB {
  let b: BB | null = null;
  for (const s of strokes) b = unionBB(b, strokeBB(s));
  b = b ?? { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  return { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad };
}

export function toSVG(strokes: Stroke[]): string {
  const b = bounds(strokes), w = b.maxX - b.minX, h = b.maxY - b.minY;
  const body = strokes.map(s => `<path d="${pathD(s.pts)}" stroke="${s.color}" stroke-width="${+s.width.toFixed(2)}"/>`).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${b.minX} ${b.minY} ${w} ${h}" width="${w}" height="${h}" fill="none" stroke-linecap="round" stroke-linejoin="round">\n${body}\n</svg>`;
}

function raster(strokes: Stroke[], maxSide: number, bg: string | null): HTMLCanvasElement {
  const b = bounds(strokes), w = b.maxX - b.minX, h = b.maxY - b.minY;
  const k = Math.min(2, maxSide / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
  const ctx = c.getContext('2d')!;
  if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, c.width, c.height); }
  ctx.setTransform(k, 0, 0, k, -b.minX * k, -b.minY * k);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const s of strokes) { ctx.strokeStyle = s.color; ctx.lineWidth = s.width; ctx.stroke(strokePath(s)); }
  return c;
}
export const thumbnail = (strokes: Stroke[]) => raster(strokes, 240, '#fff').toDataURL('image/jpeg', 0.7);
export const toBlob = (strokes: Stroke[], type: 'image/png' | 'image/jpeg') =>
  new Promise<Blob>(res => raster(strokes, 3000, type === 'image/jpeg' ? '#fff' : null).toBlob(b => res(b!), type, 0.92));

export function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
