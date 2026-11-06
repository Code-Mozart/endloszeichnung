import type { App } from '../app';
import { Stroke, uid } from '../types';
import { invalidate } from '../geom';
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
  constructor(private app: App) {}

  private arm(p: PInfo) {
    this.anchor = { sx: p.sx, sy: p.sy };
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.snap(), HOLD_MS);
  }
  /** Replace the freehand stroke by a straight line start -> current point (dense nodes so the eraser can cut it). */
  private snap() {
    const s = this.s, p = this.last; if (!s || !p || this.line) return;
    this.line = true;
    navigator.vibrate?.(15);
    this.setLine(p);
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
    this.line = false; this.last = p;
    this.app.store.applyLive({ removed: [], added: [this.s] });
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
    this.app.store.record({ removed: [], added: [s] });
    this.s = null; this.line = false;
  }
  cancel() {
    clearTimeout(this.timer);
    if (this.s) this.app.store.applyLive({ removed: [this.s], added: [] });
    this.s = null; this.line = false;
  }
}
