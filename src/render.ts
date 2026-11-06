import type { App } from './app';
import { PERIOD as P, Stroke } from './types';
import { strokeBB, strokePath } from './geom';
import { groupByLayer, paintLayers, scratchCanvas } from './scene';

function rng(min: number, max: number, vmin: number, vmax: number, wrap: boolean): [number, number] {
  if (!wrap) return max < vmin || min > vmax ? [1, 0] : [0, 0];
  const a = Math.ceil((vmin - max) / P), b = Math.floor((vmax - min) / P);
  return [a, Math.min(b, a + 11)];
}

export function render(ctx: CanvasRenderingContext2D, app: App) {
  const { view, wrap } = app, { zoom, rot, cx, cy } = view.cam;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.setTransform(app.dpr, 0, 0, app.dpr, 0, 0);
  ctx.translate(view.w / 2, view.h / 2); ctx.rotate(rot); ctx.scale(zoom, zoom); ctx.translate(-cx, -cy);
  const vb = view.bounds();

  // faint reference grid
  let step = 250;
  while (step * zoom < 50) step *= 2;
  while (step * zoom > 250) step /= 2;
  ctx.lineWidth = 1 / zoom; ctx.strokeStyle = 'rgba(0,0,0,.07)'; ctx.beginPath();
  for (let x = Math.floor(vb.minX / step) * step; x <= vb.maxX; x += step) { ctx.moveTo(x, vb.minY); ctx.lineTo(x, vb.maxY); }
  for (let y = Math.floor(vb.minY / step) * step; y <= vb.maxY; y += step) { ctx.moveTo(vb.minX, y); ctx.lineTo(vb.maxX, y); }
  ctx.stroke();

  const setup = (c: CanvasRenderingContext2D) => {
    c.setTransform(app.dpr, 0, 0, app.dpr, 0, 0);
    c.translate(view.w / 2, view.h / 2); c.rotate(rot); c.scale(zoom, zoom); c.translate(-cx, -cy);
    c.lineCap = 'round'; c.lineJoin = 'round';
  };
  setup(ctx);
  const drawOne = (c: CanvasRenderingContext2D, s: Stroke) => {
    const bb = strokeBB(s), sel = app.selection.has(s.id), path = strokePath(s);
    const [i0, i1] = rng(bb.minX, bb.maxX, vb.minX, vb.maxX, wrap.x);
    const [j0, j1] = rng(bb.minY, bb.maxY, vb.minY, vb.maxY, wrap.y);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      c.save(); c.translate(i * P, j * P);
      if (sel) { c.globalAlpha = 1; c.strokeStyle = 'rgba(41,121,255,.35)'; c.lineWidth = s.width + 9 / zoom; c.stroke(path); }
      c.globalAlpha = s.alpha ?? 1; c.strokeStyle = s.color; c.lineWidth = s.width; c.stroke(path);
      c.restore();
    }
  };
  const strokes = [...app.store.strokes.values()].map(s => app.preview.get(s.id) ?? s);
  paintLayers(ctx, app.store.layers, groupByLayer(strokes, app.store.layers),
    () => scratchCanvas(ctx.canvas.width, ctx.canvas.height), setup, drawOne);

  // subtle seam lines
  if (wrap.x || wrap.y) {
    ctx.lineWidth = 1.5 / zoom; ctx.strokeStyle = 'rgba(90,90,170,.5)'; ctx.setLineDash([10 / zoom, 8 / zoom]); ctx.beginPath();
    if (wrap.x) for (let k = Math.floor(vb.minX / P), e = Math.min(k + 60, Math.ceil(vb.maxX / P)); k <= e; k++) { ctx.moveTo(k * P, vb.minY); ctx.lineTo(k * P, vb.maxY); }
    if (wrap.y) for (let k = Math.floor(vb.minY / P), e = Math.min(k + 60, Math.ceil(vb.maxY / P)); k <= e; k++) { ctx.moveTo(vb.minX, k * P); ctx.lineTo(vb.maxX, k * P); }
    ctx.stroke(); ctx.setLineDash([]);
  }
  app.activeTool().overlay?.(ctx);
}
