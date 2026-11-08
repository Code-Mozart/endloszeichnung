import type { App } from '../app';
import { Stroke, uid } from '../types';
import { dashPattern } from '../geom';
import { dense, Pt, STEP_PX } from './shapes';
import type { PInfo, Tool } from './tool';

const NEAR_PX = 18; // a tap this close to the last or first vertex finishes the polyline / closes the polygon

/**
 * Polyline / polygon: every tap places the next vertex (the finger can be dragged to adjust before lifting).
 * Tapping the last vertex again finishes an open polyline, tapping the first vertex closes the polygon.
 * The next tap then starts a new one. Switching tools finishes what has been placed so far.
 */
export class PolyTool implements Tool {
  id = 'poly' as const;
  private verts: Pt[] = [];
  private cur: PInfo | null = null;
  constructor(private app: App) {}

  private near(v: Pt, p: PInfo) {
    const [x, y] = this.app.view.toScreen(v[0], v[1]);
    return Math.hypot(x - p.sx, y - p.sy) < NEAR_PX;
  }
  private finish(closed: boolean) {
    const v = this.verts; this.verts = []; this.cur = null;
    if (v.length < 2) { this.app.requestRender(); return; }
    const { pen, activeLayer, view, store } = this.app;
    const s: Stroke = {
      id: uid(), type: 'stroke', pts: dense(closed ? [...v, v[0]] : v, STEP_PX / view.cam.zoom),
      color: pen.color, width: pen.width, alpha: pen.alpha, dash: pen.dash, fill: pen.fill, closed, layer: activeLayer,
    };
    store.apply({ removed: [], added: [s] });
    this.app.requestRender();
  }

  down(p: PInfo) { this.cur = p; this.app.requestRender(); }
  move(p: PInfo) { this.cur = p; this.app.requestRender(); }
  up(p: PInfo) {
    this.cur = null;
    const v = this.verts;
    if (!v.length) { v.push([p.wx, p.wy]); }
    else if (v.length >= 3 && this.near(v[0], p)) this.finish(true);
    else if (this.near(v[v.length - 1], p)) { if (v.length >= 2) this.finish(false); else this.verts = []; }
    else v.push([p.wx, p.wy]);
    this.app.requestRender();
  }
  /** A second finger (view gesture) or a system cancel: keep the vertices, just forget the finger. */
  cancel() { this.cur = null; this.app.requestRender(); }
  deactivate() { if (this.verts.length >= 2) this.finish(false); else this.verts = []; }

  overlay(ctx: CanvasRenderingContext2D) {
    const v = this.verts; if (!v.length) return;
    const { pen, view } = this.app, z = view.cam.zoom;
    const pts: Pt[] = [...v]; if (this.cur) pts.push([this.cur.wx, this.cur.wy]);
    const closing = !!this.cur && v.length >= 3 && this.near(v[0], this.cur);
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); if (closing) ctx.closePath();
    if (pen.fill && v.length >= 2) { ctx.globalAlpha = pen.alpha * 0.5; ctx.fillStyle = pen.color; ctx.fill(); }
    ctx.globalAlpha = pen.alpha; ctx.setLineDash(dashPattern(pen.dash, pen.width)); ctx.strokeStyle = pen.color; ctx.lineWidth = pen.width; ctx.stroke();
    ctx.setLineDash([]); ctx.globalAlpha = 1;
    // vertices; the first one grows into a ring when a tap would close the polygon
    v.forEach(([x, y], i) => {
      const r = (i === 0 && closing ? 11 : 5.5) / z;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 2 / z; ctx.strokeStyle = '#2979ff'; ctx.stroke();
    });
    ctx.restore();
  }
}
