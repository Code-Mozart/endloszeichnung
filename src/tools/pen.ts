import type { App } from '../app';
import { Stroke, uid } from '../types';
import { invalidate } from '../geom';
import type { PInfo, Tool } from './tool';

const HOLD_MS = 800;
const HOLD_TOLERANCE_PX = 5;
const LINE_STEP_PX = 2.5; // node spacing of snapped straight lines (screen px at snap time)
const JOIN_PX = 12; // starting this close to the end of a matching stroke continues it

const reversePts = (p: number[]) => { const o: number[] = []; for (let i = p.length - 2; i >= 0; i -= 2) o.push(p[i], p[i + 1]); return o; };

export class PenTool implements Tool {
  id = 'pen' as const;
  private s: Stroke | null = null;
  private old: Stroke | null = null; // the stroke being continued (replaced by `s`), if any
  private base: number[] = []; // points that existed before this gesture
  private origin: [number, number] = [0, 0]; // where this gesture's own drawing starts
  private timer = 0;
  private anchor = { sx: 0, sy: 0 };
  private last: PInfo | null = null;
  private line = false;
  constructor(private app: App) {}

  private arm(p: PInfo) {
    this.anchor = { sx: p.sx, sy: p.sy };
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.snap(), HOLD_MS);
  }
  /** Hold-to-straight-line: replace this gesture's freehand part by a line origin -> current point (dense nodes so the eraser can cut it). */
  private snap() {
    const p = this.last, s = this.s; if (!s || !p || this.line) return;
    // a loop (end near start) would collapse to a dot: leave it as drawn
    const seg = this.base.length ? [...this.origin, ...s.pts.slice(this.base.length)] : s.pts;
    const n = seg.length / 2; let len = 0;
    for (let i = 1; i < n; i++) len += Math.hypot(seg[2 * i] - seg[2 * i - 2], seg[2 * i + 1] - seg[2 * i - 1]);
    if (Math.hypot(this.origin[0] - p.wx, this.origin[1] - p.wy) < 0.2 * len) return;
    this.line = true;
    navigator.vibrate?.(15);
    this.setLine(p);
  }
  private setLine(p: PInfo) {
    const s = this.s!, [x0, y0] = this.origin;
    const len = Math.hypot(p.wx - x0, p.wy - y0);
    const n = Math.min(5000, Math.max(1, Math.ceil(len / (LINE_STEP_PX / this.app.view.cam.zoom))));
    const pts = [...this.base];
    for (let i = this.base.length ? 1 : 0; i <= n; i++) pts.push(x0 + ((p.wx - x0) * i) / n, y0 + ((p.wy - y0) * i) / n);
    s.pts = pts; invalidate(s); this.app.requestRender();
  }

  /** An open stroke on the active layer with the same style whose start or end is right under the pen. */
  private findJoin(p: PInfo): { s: Stroke; atStart: boolean } | null {
    const { app } = this, { store, pen } = app, tol = JOIN_PX / app.view.cam.zoom;
    let best: { s: Stroke; atStart: boolean } | null = null, bd = tol;
    for (const o of store.strokes.values()) {
      if (o.type !== 'stroke' || o.pts.length < 4 || store.layerOf(o) !== app.activeLayer || !store.isVisible(o)) continue;
      if (o.color !== pen.color || o.width !== pen.width || (o.alpha ?? 1) !== pen.alpha || (o.dash ?? 'solid') !== pen.dash) continue;
      const n = o.pts.length, x0 = o.pts[0], y0 = o.pts[1], x1 = o.pts[n - 2], y1 = o.pts[n - 1];
      if (Math.hypot(x1 - x0, y1 - y0) < tol) continue; // closed outline: nothing to continue
      const de = Math.hypot(p.wx - x1, p.wy - y1), ds = Math.hypot(p.wx - x0, p.wy - y0);
      if (de < bd) { bd = de; best = { s: o, atStart: false }; }
      if (ds < bd) { bd = ds; best = { s: o, atStart: true }; }
    }
    return best;
  }

  down(p: PInfo) {
    const { pen, activeLayer, store } = this.app;
    const join = this.findJoin(p);
    this.line = false; this.last = p;
    if (join) {
      const pts = join.atStart ? reversePts(join.s.pts) : [...join.s.pts];
      this.old = join.s; this.base = pts; this.origin = [pts[pts.length - 2], pts[pts.length - 1]];
      this.s = { ...join.s, pts: [...pts] }; // same id: it is the same stroke, just longer
      store.applyLive({ removed: [join.s], added: [this.s] });
    } else {
      this.old = null; this.base = []; this.origin = [p.wx, p.wy];
      this.s = { id: uid(), type: 'stroke', pts: [p.wx, p.wy], color: pen.color, width: pen.width, alpha: pen.alpha, dash: pen.dash, layer: activeLayer };
      store.applyLive({ removed: [], added: [this.s] });
    }
    this.arm(p);
  }
  move(p: PInfo) {
    const s = this.s; if (!s) return;
    this.last = p;
    if (this.line) { this.setLine(p); return; }
    if (Math.hypot(p.sx - this.anchor.sx, p.sy - this.anchor.sy) > HOLD_TOLERANCE_PX) this.arm(p);
    const n = s.pts.length, min = 1.2 / this.app.view.cam.zoom;
    const lx = s.pts[n - 2], ly = s.pts[n - 1];
    if (Math.hypot(p.wx - lx, p.wy - ly) < min) return;
    // midpoint + point: twice the nodes, so erasing cuts finer
    s.pts.push((lx + p.wx) / 2, (ly + p.wy) / 2, p.wx, p.wy); invalidate(s); this.app.requestRender();
  }
  up(p: PInfo) {
    const s = this.s; if (!s) return;
    clearTimeout(this.timer);
    if (this.line) this.setLine(p); else this.move(p);
    // continuing a stroke without adding anything is not an edit
    if (!this.old || s.pts.length > this.base.length) this.app.store.record({ removed: this.old ? [this.old] : [], added: [s] });
    else this.app.store.applyLive({ removed: [s], added: [this.old] });
    this.s = null; this.old = null; this.line = false;
  }
  cancel() {
    clearTimeout(this.timer);
    if (this.s) this.app.store.applyLive({ removed: [this.s], added: this.old ? [this.old] : [] });
    this.s = null; this.old = null; this.line = false;
  }
}
