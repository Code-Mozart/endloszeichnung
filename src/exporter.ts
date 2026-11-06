import type { Layer, Stroke } from './types';
import { groupByLayer, paintLayers, scratchCanvas } from './scene';
import { pathD, strokeBB, strokePath, unionBB, BB } from './geom';

export function bounds(strokes: Stroke[], pad = 20): BB {
  let b: BB | null = null;
  for (const s of strokes) b = unionBB(b, strokeBB(s));
  b = b ?? { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  return { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad };
}

const visibleStrokes = (strokes: Stroke[], layers: Layer[]) => {
  const g = groupByLayer(strokes, layers);
  return layers.filter(l => l.visible).flatMap(l => g.get(l.id) ?? []);
};

export function toSVG(strokes: Stroke[], layers: Layer[]): string {
  const b = bounds(visibleStrokes(strokes, layers)), w = b.maxX - b.minX, h = b.maxY - b.minY;
  const g = groupByLayer(strokes, layers);
  const body = layers.filter(l => l.visible && g.get(l.id)?.length).map(l =>
    `<g${l.opacity < 0.999 ? ` opacity="${+l.opacity.toFixed(3)}"` : ''}>\n` + g.get(l.id)!.map(s =>
      `<path d="${pathD(s.pts)}" stroke="${s.color}" stroke-width="${+s.width.toFixed(2)}"${(s.alpha ?? 1) < 0.999 ? ` stroke-opacity="${+(s.alpha ?? 1).toFixed(3)}"` : ''}/>`).join('\n') + '\n</g>').join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${b.minX} ${b.minY} ${w} ${h}" width="${w}" height="${h}" fill="none" stroke-linecap="round" stroke-linejoin="round">\n${body}\n</svg>`;
}

function raster(strokes: Stroke[], layers: Layer[], maxSide: number, bg: string | null): HTMLCanvasElement {
  const b = bounds(visibleStrokes(strokes, layers)), w = b.maxX - b.minX, h = b.maxY - b.minY;
  const k = Math.min(2, maxSide / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
  const ctx = c.getContext('2d')!;
  if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, c.width, c.height); }
  const setup = (x: CanvasRenderingContext2D) => { x.setTransform(k, 0, 0, k, -b.minX * k, -b.minY * k); x.lineCap = 'round'; x.lineJoin = 'round'; };
  setup(ctx);
  paintLayers(ctx, layers, groupByLayer(strokes, layers), () => scratchCanvas(c.width, c.height), setup, (x, s) => {
    x.globalAlpha = s.alpha ?? 1; x.strokeStyle = s.color; x.lineWidth = s.width; x.stroke(strokePath(s)); x.globalAlpha = 1;
  });
  return c;
}
export const thumbnail = (strokes: Stroke[], layers: Layer[]) => raster(strokes, layers, 240, '#fff').toDataURL('image/jpeg', 0.7);
export const toBlob = (strokes: Stroke[], layers: Layer[], type: 'image/png' | 'image/jpeg') =>
  new Promise<Blob>(res => raster(strokes, layers, 3000, type === 'image/jpeg' ? '#fff' : null).toBlob(b => res(b!), type, 0.92));

export function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
