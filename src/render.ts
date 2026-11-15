import type { App } from './app';
import { PERIOD as P, Obj, Layer } from './types';
import type { BB } from './geom';
import { dashPattern, imageCorners, objBB, strokeFill, strokePath, strokePathAt } from './geom';
import { getBitmap } from './images';
import { groupByLayer, scratchCanvas } from './scene';

function rng(min: number, max: number, vmin: number, vmax: number, wrap: boolean): [number, number] {
  if (!wrap) return max < vmin || min > vmax ? [1, 0] : [0, 0];
  const a = Math.ceil((vmin - max) / P), b = Math.floor((vmax - min) / P);
  return [a, Math.min(b, a + 11)];
}

// ---- per-layer bitmap caches ----------------------------------------------------------------------------------------
// Big layers are kept as bitmaps (a bit larger than the screen). Frames just blit them (with the camera delta while the
// view moves), draw the few "dynamic" objects (being drawn / selected / previewed) on top, and rebuild sharp bitmaps in
// small time slices once the camera has settled or objects were removed. Small layers are simply drawn every frame.
const SMALL = 60, BUDGET_MS = 6, MARGIN = 0.2, SETTLE_MS = 120;
interface Job { cv: HTMLCanvasElement; mat: DOMMatrix; vb: BB; list: Obj[]; i: number; camKey: string; ver: string }
interface LC { cv: HTMLCanvasElement | null; spare: HTMLCanvasElement | null; mat: DOMMatrix | null; camKey: string; drawn: Set<Obj>; ver: string; extra: Obj[]; stale: boolean; want: Obj[]; job: Job | null }
const caches = new Map<string, LC>();
let globalKey = '', imgRev = 0, lastCam = '', camChangedAt = 0, groupRev = -1, groupMemo = new Map<string, Obj[]>(), groupLayers = '';
/** Call when an image finished decoding: cached bitmaps contain placeholders for it. */
export const bumpImages = () => { imgRev++; };

const camMat = (app: App, dx: number, dy: number) => {
  const { view, dpr } = app, { cx, cy, zoom, rot } = view.cam;
  return new DOMMatrix().translateSelf(dx, dy).scaleSelf(dpr).translateSelf(view.w / 2, view.h / 2).rotateSelf((rot * 180) / Math.PI).scaleSelf(zoom).translateSelf(-cx, -cy);
};
function worldBox(mat: DOMMatrix, w: number, h: number): BB {
  const inv = mat.inverse(), pts = [[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => inv.transformPoint(new DOMPoint(x, y)));
  return { minX: Math.min(...pts.map(q => q.x)), maxX: Math.max(...pts.map(q => q.x)), minY: Math.min(...pts.map(q => q.y)), maxY: Math.max(...pts.map(q => q.y)) };
}

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
  const drawOne = (c: CanvasRenderingContext2D, s: Obj, box: BB = vb) => {
    const bb = objBB(s), sel = app.selection.has(s.id);
    // far too small to see: skip it, or draw a dot of its color
    if (!sel && s.type === 'stroke') {
      const px = Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY) * zoom;
      if (px < 1.2) {
        if (px >= 0.3 || s.width * zoom >= 1) { // (a hairline-thin tiny stroke is invisible anyway)
          const [i0, i1] = rng(bb.minX, bb.maxX, box.minX, box.maxX, wrap.x), [j0, j1] = rng(bb.minY, bb.maxY, box.minY, box.maxY, wrap.y);
          c.globalAlpha = (s.alpha ?? 1) * 0.8; c.fillStyle = s.color;
          const d = Math.max(1.2 / zoom, s.width);
          for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) c.fillRect((bb.minX + bb.maxX) / 2 + i * P - d / 2, (bb.minY + bb.maxY) / 2 + j * P - d / 2, d, d);
        }
        return;
      }
    }
    const path = s.type === 'stroke' ? strokePathAt(s, zoom) : null, bmp = s.type === 'image' ? getBitmap(s.img) : null;
    const [i0, i1] = rng(bb.minX, bb.maxX, box.minX, box.maxX, wrap.x);
    const [j0, j1] = rng(bb.minY, bb.maxY, box.minY, box.maxY, wrap.y);
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

  const { store } = app, { layers } = store;
  const W = ctx.canvas.width, H = ctx.canvas.height, mx = Math.ceil(W * MARGIN), my = Math.ceil(H * MARGIN), cw = W + 2 * mx, ch = H + 2 * my;
  const gKey = [W, H, app.dpr, view.w, view.h, wrap.x, wrap.y, imgRev].join('|');
  if (gKey !== globalKey) { globalKey = gKey; caches.clear(); }
  for (const id of [...caches.keys()]) if (!layers.some(l => l.id === id)) caches.delete(id);
  const camKey = `${cx}|${cy}|${zoom}|${rot}`, now = performance.now();
  if (camKey !== lastCam) { lastCam = camKey; camChangedAt = now; }
  const settled = now - camChangedAt > SETTLE_MS;
  const lsig = layers.map(l => l.id).join(',');
  if (groupRev !== store.rev || groupLayers !== lsig) { groupRev = store.rev; groupLayers = lsig; groupMemo = groupByLayer(store.strokes.values(), layers); }
  // dynamic objects: drawn live on top of the bitmaps (the stroke being drawn, the selection, previews of moves)
  const dynIds = new Set<string>(app.selection); if (app.liveId) dynIds.add(app.liveId); for (const id of app.preview.keys()) dynIds.add(id);
  const dyn = new Map<string, Obj[]>();
  for (const id of dynIds) {
    const o = app.preview.get(id) ?? store.strokes.get(id); if (!o) continue;
    const lid = store.layerOf(o); let a = dyn.get(lid); if (!a) dyn.set(lid, (a = [])); a.push(o);
  }
  const ver = store.rev + '|' + [...dynIds].join(',');
  let busy = false, waiting = false;
  const t0 = now;

  const cacheCtx = (cv: HTMLCanvasElement) => cv.getContext('2d')!;
  const newCanvas = (spare: HTMLCanvasElement | null) => {
    const cv = spare ?? document.createElement('canvas');
    if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; } else { const c = cacheCtx(cv); c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, cw, ch); }
    return cv;
  };
  const prepare = (c: CanvasRenderingContext2D, mat: DOMMatrix) => { c.setTransform(mat); c.globalAlpha = 1; c.setLineDash([]); c.lineCap = 'round'; c.lineJoin = 'round'; };

  /** Bring the bitmaps of a big layer up to date; returns the pieces to composite. */
  function layerBitmap(l: Layer, g: Obj[]) {
    let lc = caches.get(l.id);
    if (!lc) caches.set(l.id, (lc = { cv: null, spare: null, mat: null, camKey: '', drawn: new Set(), ver: '', extra: [], stale: false, want: [], job: null }));
    if (lc.ver !== ver) {
      lc.ver = ver;
      lc.want = dynIds.size ? g.filter(o => !dynIds.has(o.id)) : g;
      const ws = new Set(lc.want);
      for (const o of lc.drawn) if (!ws.has(o)) { lc.stale = true; break; }
      const add = lc.want.filter(o => !lc!.drawn.has(o));
      lc.extra = [];
      if (add.length) {
        if (lc.cv && lc.camKey === camKey) {
          const c = cacheCtx(lc.cv); prepare(c, lc.mat!);
          const box = worldBox(lc.mat!, cw, ch);
          for (const o of add) { drawOne(c, o, box); lc.drawn.add(o); }
        } else lc.extra = add;
      }
      if (lc.job && lc.job.ver !== ver) lc.job = null;
    }
    const needs = !lc.cv || lc.stale || lc.camKey !== camKey;
    if (needs && lc.job && lc.job.camKey !== camKey) lc.job = null;
    if (needs && !lc.job) {
      if (!lc.cv || settled) {
        const mat = camMat(app, mx, my);
        lc.job = { cv: newCanvas(lc.spare), mat, vb: worldBox(mat, cw, ch), list: lc.want, i: 0, camKey, ver };
        lc.spare = null;
      } else waiting = true;
    }
    const job = lc.job;
    if (job) {
      const c = cacheCtx(job.cv); prepare(c, job.mat);
      let k = 0;
      while (job.i < job.list.length) {
        drawOne(c, job.list[job.i++], job.vb);
        if ((++k & 15) === 0 && performance.now() - t0 > BUDGET_MS) break;
      }
      if (job.i >= job.list.length) { // done: swap in the sharp bitmap
        lc.spare = lc.cv; lc.cv = job.cv; lc.mat = job.mat; lc.camKey = job.camKey; lc.drawn = new Set(job.list); lc.extra = []; lc.stale = false; lc.job = null;
      } else busy = true;
    }
    return { cv: lc.cv ?? job?.cv ?? null, mat: lc.cv ? lc.mat! : job?.mat ?? null, extra: lc.extra };
  }

  const blit = (c: CanvasRenderingContext2D, cv: HTMLCanvasElement, mat: DOMMatrix) => {
    c.save(); c.setTransform(camMat(app, 0, 0).multiply(mat.inverse())); c.globalAlpha = 1; c.drawImage(cv, 0, 0); c.restore();
  };

  for (const l of layers) {
    if (!l.visible) continue;
    const g = groupMemo.get(l.id) ?? [], d = dyn.get(l.id) ?? [];
    if (!g.length && !d.length) continue;
    const big = g.length >= SMALL;
    const paintContent = (c: CanvasRenderingContext2D) => {
      if (big) {
        const b = layerBitmap(l, g);
        if (b.cv) blit(c, b.cv, b.mat!);
        setup(c);
        for (const o of b.extra) drawOne(c, o);
        for (const o of d) drawOne(c, o);
      } else for (const o of g) drawOne(c, app.preview.get(o.id) ?? o);
    };
    if (l.opacity >= 0.999) { paintContent(ctx); setup(ctx); continue; }
    const sc = scratchCanvas(ctx.canvas.width, ctx.canvas.height), c = sc.getContext('2d')!;
    c.setTransform(1, 0, 0, 1, 0, 0); c.globalAlpha = 1; c.clearRect(0, 0, sc.width, sc.height);
    setup(c); paintContent(c);
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = l.opacity; ctx.drawImage(sc, 0, 0); ctx.restore();
  }
  if (busy) app.requestRender();
  else if (waiting) setTimeout(() => app.requestRender(), SETTLE_MS + 20);

  // subtle seam lines
  if (wrap.x || wrap.y) {
    ctx.lineWidth = 1.5 / zoom; ctx.strokeStyle = 'rgba(90,90,170,.5)'; ctx.setLineDash([10 / zoom, 8 / zoom]); ctx.beginPath();
    if (wrap.x) for (let k = Math.floor(vb.minX / P), e = Math.min(k + 60, Math.ceil(vb.maxX / P)); k <= e; k++) { ctx.moveTo(k * P, vb.minY); ctx.lineTo(k * P, vb.maxY); }
    if (wrap.y) for (let k = Math.floor(vb.minY / P), e = Math.min(k + 60, Math.ceil(vb.maxY / P)); k <= e; k++) { ctx.moveTo(vb.minX, k * P); ctx.lineTo(vb.maxX, k * P); }
    ctx.stroke(); ctx.setLineDash([]);
  }
  app.activeTool().overlay?.(ctx);
}
