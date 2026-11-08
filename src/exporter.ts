import type { Layer, Obj } from './types';
import { groupByLayer, paintLayers, scratchCanvas } from './scene';
import { dashPattern, pathD, objBB, strokeFill, strokePath, unionBB, BB } from './geom';
import { getBitmap, preload } from './images';
import { getImageBlob } from './persist';

export function bounds(objs: Obj[], pad = 20): BB {
  let b: BB | null = null;
  for (const s of objs) b = unionBB(b, objBB(s));
  b = b ?? { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  return { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad };
}

const visibleStrokes = (strokes: Obj[], layers: Layer[]) => {
  const g = groupByLayer(strokes, layers);
  return layers.filter(l => l.visible).flatMap(l => g.get(l.id) ?? []);
};
const imageIds = (objs: Obj[]) => objs.flatMap(o => (o.type === 'image' ? [o.img] : []));
const blobToDataURL = (b: Blob) => new Promise<string>(res => { const r = new FileReader(); r.onload = () => res(r.result as string); r.readAsDataURL(b); });

export async function toSVG(strokes: Obj[], layers: Layer[]): Promise<string> {
  const vis = visibleStrokes(strokes, layers), b = bounds(vis), w = b.maxX - b.minX, h = b.maxY - b.minY;
  const urls = new Map<string, string>();
  for (const id of new Set(imageIds(vis))) { const bl = await getImageBlob(id); if (bl) urls.set(id, await blobToDataURL(bl)); }
  const g = groupByLayer(strokes, layers);
  const one = (s: Obj) => s.type === 'stroke'
    ? (() => {
        const a = s.alpha ?? 1, fl = strokeFill(s);
        return `<path d="${pathD(s.pts)}"${fl ? ` fill="${fl.color}"${fl.alpha < 0.999 ? ` fill-opacity="${+fl.alpha.toFixed(3)}"` : ''}` : ''} stroke="${s.color}" stroke-width="${+s.width.toFixed(2)}"${a < 0.999 ? ` stroke-opacity="${+a.toFixed(3)}"` : ''}${s.dash && s.dash !== 'solid' ? ` stroke-dasharray="${dashPattern(s.dash, s.width).map(v => +v.toFixed(3)).join(' ')}"` : ''}/>`;
      })()
    : urls.has(s.img) ? `<image href="${urls.get(s.img)}" width="${s.iw}" height="${s.ih}" transform="matrix(${s.m.map(v => +v.toFixed(5)).join(' ')})"${(s.alpha ?? 1) < 0.999 ? ` opacity="${+(s.alpha ?? 1).toFixed(3)}"` : ''}/>` : '';
  const body = layers.filter(l => l.visible && g.get(l.id)?.length).map(l =>
    `<g${l.opacity < 0.999 ? ` opacity="${+l.opacity.toFixed(3)}"` : ''}>\n` + g.get(l.id)!.map(one).join('\n') + '\n</g>').join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${b.minX} ${b.minY} ${w} ${h}" width="${w}" height="${h}" fill="none" stroke-linecap="round" stroke-linejoin="round">\n${body}\n</svg>`;
}

function raster(strokes: Obj[], layers: Layer[], maxSide: number, bg: string | null): HTMLCanvasElement {
  const b = bounds(visibleStrokes(strokes, layers)), w = b.maxX - b.minX, h = b.maxY - b.minY;
  const k = Math.min(2, maxSide / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
  const ctx = c.getContext('2d')!;
  if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, c.width, c.height); }
  const setup = (x: CanvasRenderingContext2D) => { x.setTransform(k, 0, 0, k, -b.minX * k, -b.minY * k); x.lineCap = 'round'; x.lineJoin = 'round'; x.imageSmoothingQuality = 'high'; };
  setup(ctx);
  paintLayers(ctx, layers, groupByLayer(strokes, layers), () => scratchCanvas(c.width, c.height), setup, (x, s) => {
    if (s.type === 'stroke') {
      const fl = strokeFill(s), path = strokePath(s);
      if (fl) { x.globalAlpha = fl.alpha; x.fillStyle = fl.color; x.fill(path); }
      x.globalAlpha = s.alpha ?? 1; x.setLineDash(dashPattern(s.dash, s.width)); x.strokeStyle = s.color; x.lineWidth = s.width; x.stroke(path); x.globalAlpha = 1; x.setLineDash([]);
    } else {
      const bm = getBitmap(s.img); if (!bm) return;
      x.save(); x.transform(...s.m); x.globalAlpha = s.alpha ?? 1; x.drawImage(bm, 0, 0, s.iw, s.ih); x.restore();
    }
  });
  return c;
}
/** Sync: images that are not decoded yet are simply left out of the thumbnail. */
export const thumbnail = (strokes: Obj[], layers: Layer[]) => raster(strokes, layers, 240, '#fff').toDataURL('image/jpeg', 0.7);
export async function toBlob(strokes: Obj[], layers: Layer[], type: 'image/png' | 'image/jpeg') {
  await preload(imageIds(strokes));
  return new Promise<Blob>(res => raster(strokes, layers, 3000, type === 'image/jpeg' ? '#fff' : null).toBlob(b => res(b!), type, 0.92));
}

/**
 * Draw the objects of one layer into a small canvas, ignoring the layer's opacity and visibility. `box` is the world area to show
 * (the same for all layers, so the thumbnails line up); thin strokes are kept at least ~1.6px wide so they stay visible.
 */
export function drawLayerThumb(canvas: HTMLCanvasElement, objs: Obj[], box: BB) {
  const ctx = canvas.getContext('2d')!, W = canvas.width, H = canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  const w = Math.max(1, box.maxX - box.minX), h = Math.max(1, box.maxY - box.minY), k = Math.min(W / w, H / h);
  ctx.setTransform(k, 0, 0, k, (W - w * k) / 2 - box.minX * k, (H - h * k) / 2 - box.minY * k);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const s of objs) {
    if (s.type === 'stroke') {
      const fl = strokeFill(s), path = strokePath(s);
      if (fl) { ctx.globalAlpha = fl.alpha; ctx.fillStyle = fl.color; ctx.fill(path); }
      ctx.globalAlpha = s.alpha ?? 1; ctx.strokeStyle = s.color; ctx.lineWidth = Math.max(s.width, 1.6 / k); ctx.stroke(path);
    } else {
      const bm = getBitmap(s.img);
      if (bm) { ctx.save(); ctx.globalAlpha = s.alpha ?? 1; ctx.transform(...s.m); ctx.drawImage(bm, 0, 0, s.iw, s.ih); ctx.restore(); }
    }
  }
  ctx.globalAlpha = 1;
}

export function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
