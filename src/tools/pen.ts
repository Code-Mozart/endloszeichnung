import type { App } from '../app';
import { Stroke, uid } from '../types';
import { invalidate } from '../geom';
import { snapShape } from '../shapes';
import type { PInfo, Tool } from './tool';

const HOLD_MS = 800;
const HOLD_TOLERANCE_PX = 5;
const LINE_STEP_PX = 2.5; // node spacing of snapped straight lines (screen px at snap time)

export class PenTool implements Tool {
  id = 'pen' as const;
  private s: Stroke | null = null;
  private timer = 0;
  private anchor = { sx: 0, sy: 0 };
  private last: PInfo | null = null;
  private line = false;
  private shape = false;
  constructor(private app: App) {}

  private arm(p: PInfo) {
    this.anchor = { sx: p.sx, sy: p.sy };
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.snap(), HOLD_MS);
  }
  /**
   * Hold-to-snap. A closed stroke that looks like a rectangle or ellipse becomes the perfect shape; an open stroke becomes a
   * straight line start -> current point; a closed stroke that is neither stays as drawn. Dense nodes so the eraser can cut them.
   */
  private snap() {
    const s = this.s, p = this.last; if (!s || !p || this.line || this.shape) return;
    const r = snapShape(s.pts, LINE_STEP_PX / this.app.view.cam.zoom);
    if (r.kind === 'none') return; // closed but unrecognized: leave as drawn
    navigator.vibrate?.(15);
    if (r.kind === 'shape') { this.shape = true; s.pts = r.pts; invalidate(s); this.app.requestRender(); return; }
    this.line = true; this.setLine(p);
  }
  private setLine(p: PInfo) {
    const s = this.s!, x0 = s.pts[0], y0 = s.pts[1];
    const len = Math.hypot(p.wx - x0, p.wy - y0);
    const n = Math.min(5000, Math.max(1, Math.ceil(len / (LINE_STEP_PX / this.app.view.cam.zoom))));
    const pts: number[] = [];
    for (let i = 0; i <= n; i++) pts.push(x0 + ((p.wx - x0) * i) / n, y0 + ((p.wy - y0) * i) / n);
    s.pts = pts; invalidate(s); this.app.requestRender();
  }

  down(p: PInfo) {
    this.s = { id: uid(), type: 'stroke', pts: [p.wx, p.wy], color: this.app.pen.color, width: this.app.pen.width, alpha: this.app.pen.alpha, layer: this.app.activeLayer };
    this.line = false; this.shape = false; this.last = p;
    this.app.store.applyLive({ removed: [], added: [this.s] });
    this.arm(p);
  }
  move(p: PInfo) {
    const s = this.s; if (!s) return;
    this.last = p;
    if (this.line) { this.setLine(p); return; }
    if (this.shape) return; // snapped shape stays put until the pen is lifted
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
    if (this.line) this.setLine(p); else if (!this.shape) this.move(p);
    this.app.store.record({ removed: [], added: [s] });
    this.s = null; this.line = false; this.shape = false;
  }
  cancel() {
    clearTimeout(this.timer);
    if (this.s) this.app.store.applyLive({ removed: [this.s], added: [] });
    this.s = null; this.line = false; this.shape = false;
  }
}
