import type { Layer, Obj } from './types';

/** Group strokes by layer (unknown layers fall back to the bottom layer), keeping insertion order. */
export function groupByLayer(strokes: Iterable<Obj>, layers: Layer[]): Map<string, Obj[]> {
  const ids = new Set(layers.map(l => l.id)), out = new Map<string, Obj[]>();
  for (const s of strokes) {
    const id = s.layer && ids.has(s.layer) ? s.layer : layers[0].id;
    let a = out.get(id); if (!a) out.set(id, (a = []));
    a.push(s);
  }
  return out;
}

/**
 * Paint layers bottom -> top. Layers with opacity < 1 are drawn to a scratch canvas first
 * so overlapping strokes inside one layer don't double-blend, then composited with the layer opacity.
 */
export function paintLayers(
  ctx: CanvasRenderingContext2D, layers: Layer[], groups: Map<string, Obj[]>,
  getScratch: () => HTMLCanvasElement, setup: (c: CanvasRenderingContext2D) => void,
  drawOne: (c: CanvasRenderingContext2D, s: Obj) => void,
) {
  for (const l of layers) {
    const g = groups.get(l.id);
    if (!l.visible || !g || !g.length) continue;
    if (l.opacity >= 0.999) { for (const s of g) drawOne(ctx, s); continue; }
    const sc = getScratch(), c = sc.getContext('2d')!;
    c.setTransform(1, 0, 0, 1, 0, 0); c.globalAlpha = 1; c.clearRect(0, 0, sc.width, sc.height);
    setup(c);
    for (const s of g) drawOne(c, s);
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = l.opacity; ctx.drawImage(sc, 0, 0); ctx.restore();
  }
}

let scratch: HTMLCanvasElement | null = null;
export function scratchCanvas(w: number, h: number): HTMLCanvasElement {
  if (!scratch) scratch = document.createElement('canvas');
  if (scratch.width !== w || scratch.height !== h) { scratch.width = w; scratch.height = h; }
  return scratch;
}
