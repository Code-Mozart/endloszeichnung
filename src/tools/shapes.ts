import type { App } from '../app';
import { Stroke, uid } from '../types';
import { invalidate } from '../geom';
import type { PInfo, Tool } from './tool';

export type ShapeKind = 'line' | 'rect' | 'circle' | 'arrow';
export const SHAPE_KINDS: ShapeKind[] = ['line', 'rect', 'circle', 'arrow'];

const STEP_PX = 2.5; // node spacing, so the eraser can cut shapes like any stroke
const ARROW_TIP = 0.2; // arrow head wing length as a fraction of the arrow length
const ARROW_ANGLE = (28 * Math.PI) / 180;
const MIN_DRAG_PX = 3;

type Pt = [number, number];
/**
 * Polyline through the given corners with a node about every `step` world units.
 * Interior corners get repeated nodes: the stroke smoothing cuts corners by a fixed amount otherwise,
 * which shows as blunt corners and tips (e.g. on arrow heads) once the view is zoomed in.
 */
function dense(corners: Pt[], step: number): number[] {
  const out: number[] = [];
  for (let e = 0; e < corners.length - 1; e++) {
    const [x0, y0] = corners[e], [x1, y1] = corners[e + 1];
    if (e > 0) out.push(x0, y0, x0, y0);
    const k = Math.min(4000, Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step)));
    for (let i = 0; i < k; i++) out.push(x0 + ((x1 - x0) * i) / k, y0 + ((y1 - y0) * i) / k);
  }
  const [lx, ly] = corners[corners.length - 1];
  out.push(lx, ly);
  return out;
}

/** Shapes are dragged from the finger-down point to the finger position and stored as ordinary strokes. */
export class ShapeTool implements Tool {
  id = 'shapes' as const;
  private s: Stroke | null = null;
  private start: PInfo | null = null;
  constructor(private app: App) {}

  private build(p: PInfo): number[] {
    const a = this.start!, view = this.app.view, step = STEP_PX / view.cam.zoom;
    const A: Pt = [a.wx, a.wy], B: Pt = [p.wx, p.wy];
    switch (this.app.shapeKind) {
      case 'rect': { // aligned to the screen, even when the view is rotated
        const c: Pt[] = [view.toWorld(a.sx, a.sy), view.toWorld(p.sx, a.sy), view.toWorld(p.sx, p.sy), view.toWorld(a.sx, p.sy)];
        return dense([...c, c[0]], step);
      }
      case 'circle': { // finger-down is the center, the finger position is on the arc
        const r = Math.hypot(B[0] - A[0], B[1] - A[1]), k = Math.min(4000, Math.max(24, Math.ceil((2 * Math.PI * r) / step)));
        const out: number[] = [];
        for (let i = 0; i <= k; i++) { const t = (i / k) * 2 * Math.PI; out.push(A[0] + r * Math.cos(t), A[1] + r * Math.sin(t)); }
        return out;
      }
      case 'arrow': {
        const dx = B[0] - A[0], dy = B[1] - A[1], len = Math.hypot(dx, dy), tip = len * ARROW_TIP, ang = Math.atan2(dy, dx);
        const wing = (s: number): Pt => [B[0] - tip * Math.cos(ang + s * ARROW_ANGLE), B[1] - tip * Math.sin(ang + s * ARROW_ANGLE)];
        return dense([A, B, wing(1), B, wing(-1)], step);
      }
      default:
        return dense([A, B], step);
    }
  }

  down(p: PInfo) {
    const { pen, activeLayer } = this.app;
    this.start = p;
    this.s = { id: uid(), type: 'stroke', pts: [p.wx, p.wy], color: pen.color, width: pen.width, alpha: pen.alpha, dash: pen.dash, layer: activeLayer };
    this.app.store.applyLive({ removed: [], added: [this.s] });
  }
  move(p: PInfo) {
    if (!this.s || !this.start) return;
    if (Math.hypot(p.sx - this.start.sx, p.sy - this.start.sy) < 1) return;
    this.s.pts = this.build(p); invalidate(this.s); this.app.requestRender();
  }
  up(p: PInfo) {
    const s = this.s, a = this.start; if (!s || !a) return;
    if (Math.hypot(p.sx - a.sx, p.sy - a.sy) < MIN_DRAG_PX) this.app.store.applyLive({ removed: [s], added: [] }); // a tap draws nothing
    else { s.pts = this.build(p); invalidate(s); this.app.store.record({ removed: [], added: [s] }); }
    this.s = null; this.start = null;
  }
  cancel() {
    if (this.s) this.app.store.applyLive({ removed: [this.s], added: [] });
    this.s = null; this.start = null;
  }
}
