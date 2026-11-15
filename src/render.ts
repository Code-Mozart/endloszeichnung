import type { App } from './app';
import { PERIOD as P, Obj } from './types';
import { dashPattern, imageCorners, objBB, strokeFill, strokePath, strokePathAt } from './geom';
import { getBitmap } from './images';
import { groupByLayer, paintLayers, scratchCanvas } from './scene';

function rng(min: number, max: number, vmin: number, vmax: number, wrap: boolean): [number, number] {
  if (!wrap) return max < vmin || min > vmax ? [1, 0] : [0, 0];
  const a = Math.ceil((vmin - max) / P), b = Math.floor((vmax - min) / P);
  return [a, Math.min(b, a + 11)];
}

let sceneCache: HTMLCanvasElement | null = null, sceneKey = '';

export function render(ctx: CanvasRenderingContext2D, app: App) {
  const { view, wrap } = app, { zoom, rot, cx, cy } = view.cam;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.setTransform(app.dpr, 0, 0, app.dpr, 0, 0);
  ctx.translate(view.w / 2, view.h / 2); ctx.rotate(rot); ctx.scale(zoom, zoom); ctx.translate(-cx, -cy);
  const vb = view.bounds();

  if (app.grid) {
    // faint reference grid
    let step = 250;
    while (step * zoom < 50) step *= 2;
    while (step * zoom > 250) step /= 2;
    ctx.lineWidth = 1 / zoom; ctx.strokeStyle = 'rgba(0,0,0,.07)'; ctx.beginPath();
    for (let x = Math.floor(vb.minX / step) * step; x <= vb.maxX; x += step) { ctx.moveTo(x, vb.minY); ctx.lineTo(x, vb.maxY); }
    for (let y = Math.floor(vb.minY / step) * step; y <= vb.maxY; y += step) { ctx.moveTo(vb.minX, y); ctx.lineTo(vb.maxX, y); }
    ctx.stroke();
  }

  const setup = (c: CanvasRenderingContext2D) => {
    c.setTransform(app.dpr, 0, 0, app.dpr, 0, 0);
    c.translate(view.w / 2, view.h / 2); c.rotate(rot); c.scale(zoom, zoom); c.translate(-cx, -cy);
    c.lineCap = 'round'; c.lineJoin = 'round';
  };
  setup(ctx);
  const drawOne = (c: CanvasRenderingContext2D, s: Obj) => {
    const bb = objBB(s), sel = app.selection.has(s.id);
    const path = s.type === 'stroke' ? strokePathAt(s, zoom) : null, bmp = s.type === 'image' ? getBitmap(s.img) : null;
    const [i0, i1] = rng(bb.minX, bb.maxX, vb.minX, vb.maxX, wrap.x);
    const [j0, j1] = rng(bb.minY, bb.maxY, vb.minY, vb.maxY, wrap.y);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      c.save(); if (i || j) c.translate(i * P, j * P);
      if (s.type === 'stroke') {
        if (sel) { c.globalAlpha = 1; c.setLineDash([]); c.strokeStyle = 'rgba(41,121,255,.35)'; c.lineWidth = s.width + 9 / zoom; c.stroke(path!); }
        const fl = strokeFill(s);
        if (fl) { c.globalAlpha = fl.alpha; c.fillStyle = fl.color; c.fill(path!); } // fill under the outline, with its own color and opacity
        c.globalAlpha = s.alpha ?? 1; c.setLineDash(dashPattern(s.dash, s.width)); c.strokeStyle = s.color; c.lineWidth = s.width; c.stroke(path!);
      } else {
        if (bmp) { c.save(); c.transform(...s.m); c.globalAlpha = s.alpha ?? 1; c.imageSmoothingQuality = 'high'; c.drawImage(bmp, 0, 0, s.iw, s.ih); c.restore(); }
        if (sel || !bmp) {
          const q = imageCorners(s); c.globalAlpha = 1; c.beginPath(); q.forEach(([x, y], k) => (k ? c.lineTo(x, y) : c.moveTo(x, y))); c.closePath();
          c.strokeStyle = sel ? 'rgba(41,121,255,.7)' : 'rgba(0,0,0,.25)'; c.lineWidth = 3 / zoom; c.stroke();
        }
      }
      c.restore();
    }
  };
  const all = [...app.store.strokes.values()].map(s => app.preview.get(s.id) ?? s);
  const liveObj = app.liveId ? app.store.strokes.get(app.liveId) : undefined;
  const paint = (c: CanvasRenderingContext2D, objs: Obj[]) =>
    paintLayers(c, app.store.layers, groupByLayer(objs, app.store.layers), () => scratchCanvas(ctx.canvas.width, ctx.canvas.height), setup, drawOne);
  // While the pen draws, everything else is static: keep it in a bitmap and only redraw the live stroke on top.
  // Only valid when no visible layer above the live stroke's has content, and its own layer is drawn at full opacity.
  const { layers } = app.store, li = liveObj ? layers.findIndex(l => l.id === app.store.layerOf(liveObj)) : -1;
  const groups = liveObj ? groupByLayer(all, layers) : null;
  const cacheOk = !!liveObj && li >= 0 && layers[li].visible && layers[li].opacity >= 0.999 && !app.selection.size && app.preview.size === 0 &&
    layers.slice(li + 1).every(l => !l.visible || !groups!.get(l.id)?.length);
  if (cacheOk) {
    const key = [app.store.rev, app.liveId, cx, cy, zoom, rot, view.w, view.h, app.dpr, wrap.x, wrap.y, app.grid, JSON.stringify(layers)].join('|');
    if (!sceneCache || sceneKey !== key || sceneCache.width !== ctx.canvas.width || sceneCache.height !== ctx.canvas.height) {
      sceneCache ??= document.createElement('canvas');
      sceneCache.width = ctx.canvas.width; sceneCache.height = ctx.canvas.height;
      const sc = sceneCache.getContext('2d')!;
      sc.setTransform(1, 0, 0, 1, 0, 0); sc.globalAlpha = 1; sc.setLineDash([]);
      sc.drawImage(ctx.canvas, 0, 0); // background + grid already painted on ctx
      setup(sc); paint(sc, all.filter(o => o.id !== app.liveId));
      sceneKey = key;
    }
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(sceneCache, 0, 0); ctx.restore();
    setup(ctx); drawOne(ctx, liveObj!);
  } else paint(ctx, all);

  // subtle seam lines
  if (wrap.x || wrap.y) {
    ctx.lineWidth = 1.5 / zoom; ctx.strokeStyle = 'rgba(90,90,170,.5)'; ctx.setLineDash([10 / zoom, 8 / zoom]); ctx.beginPath();
    if (wrap.x) for (let k = Math.floor(vb.minX / P), e = Math.min(k + 60, Math.ceil(vb.maxX / P)); k <= e; k++) { ctx.moveTo(k * P, vb.minY); ctx.lineTo(k * P, vb.maxY); }
    if (wrap.y) for (let k = Math.floor(vb.minY / P), e = Math.min(k + 60, Math.ceil(vb.maxY / P)); k <= e; k++) { ctx.moveTo(vb.minX, k * P); ctx.lineTo(vb.maxX, k * P); }
    ctx.stroke(); ctx.setLineDash([]);
  }
  app.activeTool().overlay?.(ctx);
}
