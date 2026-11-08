import type { App } from '../app';
import { PERIOD as P, Stroke, uid } from '../types';
import { objBB } from '../geom';
import { DiffBuilder } from '../store';
import type { PInfo, Tool } from './tool';

/** Splits a stroke where the eraser circle touches it. Returns null if untouched. */
function eraseStroke(s: Stroke, x: number, y: number, r: number, wx: boolean, wy: boolean): Stroke[] | null {
  const sh = (d: number, w: boolean) => (w ? d - P * Math.round(d / P) : d);
  const n = s.pts.length / 2, r2 = r * r;
  const dead = new Array<boolean>(n).fill(false), cut = new Array<boolean>(n).fill(false);
  let any = false;
  for (let i = 0; i < n; i++) {
    const dx = sh(x - s.pts[2 * i], wx), dy = sh(y - s.pts[2 * i + 1], wy);
    if (dx * dx + dy * dy < r2) { dead[i] = true; any = true; }
  }
  for (let i = 0; i < n - 1; i++) {
    if (dead[i] || dead[i + 1]) continue;
    const ax = s.pts[2 * i], ay = s.pts[2 * i + 1];
    const ex = sh(x - ax, wx), ey = sh(y - ay, wy);
    const bx = s.pts[2 * i + 2] - ax, by = s.pts[2 * i + 3] - ay;
    const l2 = bx * bx + by * by;
    const t = l2 ? Math.min(1, Math.max(0, (ex * bx + ey * by) / l2)) : 0;
    const ddx = ex - t * bx, ddy = ey - t * by;
    if (ddx * ddx + ddy * ddy < r2) { cut[i] = true; any = true; }
  }
  if (!any) return null;
  const out: Stroke[] = [];
  let cur: number[] = [];
  const flush = () => {
    if (cur.length) out.push({ ...s, id: uid(), pts: cur, closed: false });
    cur = [];
  };
  for (let i = 0; i < n; i++) {
    if (dead[i]) { flush(); continue; }
    cur.push(s.pts[2 * i], s.pts[2 * i + 1]);
    if (cut[i]) flush();
  }
  flush();
  return out;
}

export class EraseTool implements Tool {
  id = 'erase' as const;
  private b: DiffBuilder | null = null;
  private last: [number, number] | null = null;
  private cur: [number, number] | null = null;
  constructor(private app: App) {}
  private radius() { return 14 / this.app.view.cam.zoom; }
  private hit(x: number, y: number) {
    const { store, wrap } = this.app, r = this.radius();
    const rm: Stroke[] = [], add: Stroke[] = [];
    for (const s of [...store.strokes.values()]) {
      if (s.type !== 'stroke') continue; // images are removed with select + delete, not erased
      if (store.layerOf(s) !== this.app.activeLayer || !store.isVisible(s)) continue; // erase only on the active layer
      const bb = objBB(s);
      if (!wrap.x && (x < bb.minX - r || x > bb.maxX + r)) continue;
      if (!wrap.y && (y < bb.minY - r || y > bb.maxY + r)) continue;
      const res = eraseStroke(s, x, y, r, wrap.x, wrap.y);
      if (res) { rm.push(s); add.push(...res); }
    }
    if (!rm.length) return;
    rm.forEach(s => this.b!.remove(s)); add.forEach(s => this.b!.add(s));
    store.applyLive({ removed: rm, added: add });
  }
  down(p: PInfo) { this.b = new DiffBuilder(); this.last = null; this.move(p); }
  move(p: PInfo) {
    if (!this.b) return;
    this.cur = [p.wx, p.wy];
    const step = this.radius() * 0.5;
    if (this.last) {
      const d = Math.hypot(p.wx - this.last[0], p.wy - this.last[1]), k = Math.ceil(d / step);
      for (let i = 1; i <= k; i++) this.hit(this.last[0] + ((p.wx - this.last[0]) * i) / k, this.last[1] + ((p.wy - this.last[1]) * i) / k);
    } else this.hit(p.wx, p.wy);
    this.last = [p.wx, p.wy];
    this.app.requestRender();
  }
  up(_p: PInfo) {
    if (this.b) this.app.store.record(this.b.toDiff());
    this.b = null; this.cur = null; this.app.requestRender();
  }
  cancel() { this.up({ sx: 0, sy: 0, wx: 0, wy: 0 }); }
  overlay(ctx: CanvasRenderingContext2D) {
    if (!this.cur) return;
    ctx.beginPath(); ctx.arc(this.cur[0], this.cur[1], this.radius(), 0, Math.PI * 2);
    ctx.lineWidth = 1.5 / this.app.view.cam.zoom; ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.setLineDash([]); ctx.stroke();
  }
}
