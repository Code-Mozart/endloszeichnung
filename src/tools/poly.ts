import type { App } from '../app';
import { Stroke, uid } from '../types';
import { dashPattern } from '../geom';
import { dense, Pt, STEP_PX } from './shapes';
import type { PInfo, Tool } from './tool';

const NEAR_PX = 18; // a tap this close to the last or first vertex finishes the polyline / closes the polygon
const GRAB_PX = 24; // grab radius for dragging a vertex
const DRAG_PX = 8; // movement before a press on a vertex counts as a drag

const pairs = (flat: number[]): Pt[] => { const o: Pt[] = []; for (let i = 0; i < flat.length; i += 2) o.push([flat[i], flat[i + 1]]); return o; };

/**
 * Polyline / polygon.
 * Building: every tap places the next vertex (the finger can be dragged to adjust it before lifting); pressing an existing
 * vertex and dragging moves it. Tapping the last vertex finishes an open polyline, tapping the first vertex closes the polygon.
 * The next tap starts a new one. Switching tools finishes what has been placed so far.
 * Editing: after selecting a polygon, the polygon button re-enters this tool on that shape and its vertices can be dragged.
 */
export class PolyTool implements Tool {
  id = 'poly' as const;
  private verts: Pt[] = [];
  private cur: PInfo | null = null;
  private drag: { idx: number; start: PInfo; moved: boolean } | null = null;
  private edit: { orig: Stroke; cur: Stroke; verts: Pt[]; closed: boolean } | null = null;
  constructor(private app: App) {}

  get editing() { return !!this.edit; }
  beginEdit(s: Stroke) {
    if (!s.verts || s.verts.length < 4) return;
    this.verts = []; this.cur = null;
    this.edit = { orig: s, cur: s, verts: pairs(s.verts), closed: !!s.closed };
    this.app.requestRender();
  }

  private screenDist(v: Pt, p: PInfo) {
    const [x, y] = this.app.view.toScreen(v[0], v[1]);
    return Math.hypot(x - p.sx, y - p.sy);
  }
  private nearest(list: Pt[], p: PInfo, tol: number) {
    let best = -1, bd = tol;
    list.forEach((v, i) => { const d = this.screenDist(v, p); if (d < bd) { bd = d; best = i; } });
    return best;
  }
  private build(v: Pt[], closed: boolean) { return dense(closed ? [...v, v[0]] : v, STEP_PX / this.app.view.cam.zoom); }
  private finish(closed: boolean) {
    const v = this.verts; this.verts = []; this.cur = null; this.drag = null;
    if (v.length < 2) { this.app.requestRender(); return; }
    const { pen, activeLayer, store } = this.app;
    const s: Stroke = {
      id: uid(), type: 'stroke', pts: this.build(v, closed), verts: v.flat(),
      color: pen.color, width: pen.width, alpha: pen.alpha, dash: pen.dash, fill: pen.fill, fillAlpha: pen.fillAlpha, closed, layer: activeLayer,
    };
    store.apply({ removed: [], added: [s] });
    this.app.requestRender();
  }
  /** Edit mode: replace the stroke with one that has the moved vertex (live, committed when the finger lifts). */
  private moveEditVertex(idx: number, p: PInfo) {
    const e = this.edit!; e.verts[idx] = [p.wx, p.wy];
    const next: Stroke = { ...e.cur, pts: this.build(e.verts, e.closed), verts: e.verts.flat() };
    this.app.store.applyLive({ removed: [e.cur], added: [next] });
    e.cur = next; this.app.requestRender();
  }

  down(p: PInfo) {
    this.cur = null;
    const list = this.edit ? this.edit.verts : this.verts;
    const idx = this.nearest(list, p, this.edit ? GRAB_PX : NEAR_PX);
    if (idx >= 0) this.drag = { idx, start: p, moved: false };
    else if (!this.edit) this.cur = p; // about to place a new vertex
    this.app.requestRender();
  }
  move(p: PInfo) {
    const d = this.drag;
    if (d) {
      if (!d.moved && Math.hypot(p.sx - d.start.sx, p.sy - d.start.sy) > DRAG_PX) d.moved = true;
      if (d.moved) { if (this.edit) this.moveEditVertex(d.idx, p); else this.verts[d.idx] = [p.wx, p.wy]; }
    } else if (!this.edit) this.cur = p;
    this.app.requestRender();
  }
  up(p: PInfo) {
    const d = this.drag; this.drag = null; this.cur = null;
    if (this.edit) {
      const e = this.edit;
      if (d?.moved && e.cur !== e.orig) { this.app.store.record({ removed: [e.orig], added: [e.cur] }); e.orig = e.cur; }
      this.app.requestRender(); return;
    }
    const v = this.verts;
    if (d) { // pressed on an existing vertex
      if (d.moved) { this.app.requestRender(); return; }
      if (d.idx === 0 && v.length >= 3) this.finish(true);
      else if (d.idx === v.length - 1) { if (v.length >= 2) this.finish(false); else this.verts = []; }
      this.app.requestRender(); return; // a tap on a middle vertex does nothing
    }
    if (!v.length) v.push([p.wx, p.wy]);
    else if (v.length >= 3 && this.screenDist(v[0], p) < NEAR_PX) this.finish(true);
    else if (this.screenDist(v[v.length - 1], p) < NEAR_PX) { if (v.length >= 2) this.finish(false); else this.verts = []; }
    else v.push([p.wx, p.wy]);
    this.app.requestRender();
  }
  /** A second finger (view gesture) or a system cancel: keep the vertices, just forget the finger. */
  cancel() {
    const d = this.drag; this.drag = null; this.cur = null;
    if (this.edit && d?.moved && this.edit.cur !== this.edit.orig) { this.app.store.record({ removed: [this.edit.orig], added: [this.edit.cur] }); this.edit.orig = this.edit.cur; }
    this.app.requestRender();
  }
  deactivate() {
    this.drag = null; this.cur = null;
    if (this.edit) { this.edit = null; this.app.requestRender(); return; }
    if (this.verts.length >= 2) this.finish(false); else this.verts = [];
  }

  overlay(ctx: CanvasRenderingContext2D) {
    const { pen, view } = this.app, z = view.cam.zoom;
    const dot = (x: number, y: number, r: number, hot = false) => {
      ctx.beginPath(); ctx.arc(x, y, r / z, 0, Math.PI * 2);
      ctx.fillStyle = hot ? '#2979ff' : '#fff'; ctx.fill(); ctx.lineWidth = 2 / z; ctx.strokeStyle = '#2979ff'; ctx.stroke();
    };
    if (this.edit) { // the shape itself is drawn normally; show its vertices as handles
      ctx.save(); ctx.setLineDash([]);
      this.edit.verts.forEach(([x, y], i) => dot(x, y, 8, this.drag?.idx === i));
      ctx.restore(); return;
    }
    const v = this.verts; if (!v.length) return;
    const pts: Pt[] = [...v]; if (this.cur) pts.push([this.cur.wx, this.cur.wy]);
    const closing = !!this.cur && v.length >= 3 && this.screenDist(v[0], this.cur) < NEAR_PX;
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); if (closing) ctx.closePath();
    if (pen.fill && v.length >= 3) { ctx.globalAlpha = pen.fillAlpha; ctx.fillStyle = pen.fill; ctx.fill(); }
    ctx.globalAlpha = pen.alpha; ctx.setLineDash(dashPattern(pen.dash, pen.width)); ctx.strokeStyle = pen.color; ctx.lineWidth = pen.width; ctx.stroke();
    ctx.setLineDash([]); ctx.globalAlpha = 1;
    // vertices; the first one grows into a ring when a tap would close the polygon
    v.forEach(([x, y], i) => dot(x, y, i === 0 && closing ? 11 : 5.5, this.drag?.idx === i && this.drag.moved));
    ctx.restore();
  }
}
