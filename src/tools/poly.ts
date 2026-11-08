import type { App } from '../app';
import { Stroke, uid } from '../types';
import { dashPattern } from '../geom';
import { dense, Pt, STEP_PX } from './shapes';
import type { PInfo, Tool } from './tool';

const NEAR_PX = 18; // a tap this close to the last or first vertex finishes the polyline / closes the polygon
const GRAB_PX = 24; // grab radius for dragging a vertex
const DRAG_PX = 8; // movement before a press counts as a drag
const EDGE_PX = 14; // how close to an edge a long press must be to insert a vertex there
const HOLD_MS = 500; // long press: insert a vertex on an edge / delete the vertex under the finger
const MERGE_PX = 14; // dropping a vertex this close to a neighbouring vertex removes it

const pairs = (flat: number[]): Pt[] => { const o: Pt[] = []; for (let i = 0; i < flat.length; i += 2) o.push([flat[i], flat[i + 1]]); return o; };

type Hold = { kind: 'vertex'; idx: number; pt: Pt } | { kind: 'edge'; idx: number; pt: Pt };

/**
 * Polyline / polygon.
 * Building: every tap places the next vertex (the finger can be dragged to adjust it before lifting); pressing an existing
 * vertex and dragging moves it. Tapping the last vertex finishes an open polyline, tapping the first vertex closes the polygon.
 * The next tap then starts a new one. Switching tools finishes what has been placed so far.
 * Editing: after selecting a polygon, the polygon button re-enters this tool on that shape and its vertices can be dragged.
 * Both modes: long-press on an edge inserts a vertex there (the finger can keep dragging it), long-press on a vertex
 * deletes it, and dropping a vertex onto a neighbouring vertex removes it.
 */
export class PolyTool implements Tool {
  id = 'poly' as const;
  private verts: Pt[] = [];
  private cur: PInfo | null = null;
  private drag: { idx: number; start: PInfo; moved: boolean; nearAtStart: boolean[] } | null = null;
  private undoStack: Pt[][] = []; // snapshots of the vertices before each change (placing, moving, inserting, deleting)
  private redoStack: Pt[][] = [];
  private edit: { orig: Stroke; cur: Stroke; verts: Pt[]; closed: boolean } | null = null;
  private holdTimer = 0;
  private hold: Hold | null = null; // armed long-press target (highlighted)
  private downAt: PInfo | null = null;
  private consumed = false; // the press already did something (long-press): its release is not a tap
  private mergeIdx = -1; // dragged vertex that would be removed if dropped now
  constructor(private app: App) {}

  get editing() { return !!this.edit; }

  // ---- undo / redo of the vertices while the polygon is being built ----
  private snapshot(): Pt[] { return this.verts.map(v => [v[0], v[1]] as Pt); }
  private checkpoint() { this.undoStack.push(this.snapshot()); this.redoStack = []; }
  private resetHistory() { this.undoStack = []; this.redoStack = []; }
  canUndo() { return !this.edit && this.undoStack.length > 0; }
  canRedo() { return !this.edit && this.redoStack.length > 0; }
  undo() {
    if (!this.canUndo()) return false;
    this.redoStack.push(this.snapshot()); this.verts = this.undoStack.pop()!;
    this.app.requestRender(); this.app.notify(); return true;
  }
  redo() {
    if (!this.canRedo()) return false;
    this.undoStack.push(this.snapshot()); this.verts = this.redoStack.pop()!;
    this.app.requestRender(); this.app.notify(); return true;
  }

  beginEdit(s: Stroke) {
    if (!s.verts || s.verts.length < 4) return;
    this.verts = []; this.cur = null; this.resetHistory();
    this.edit = { orig: s, cur: s, verts: pairs(s.verts), closed: !!s.closed };
    this.app.requestRender();
  }
  /** Undo/redo (or anything else) changed the stroke we are editing: refresh the handles; if it is gone, leave for the select tool. */
  storeChanged() {
    const e = this.edit; if (!e) return;
    const s = this.app.store.strokes.get(e.cur.id);
    if (!s || s.type !== 'stroke' || !s.verts) { this.app.setTool('select'); return; } // e.g. its creation was undone
    if (s !== e.cur) { e.cur = e.orig = s; e.verts = pairs(s.verts); e.closed = !!s.closed; this.app.requestRender(); }
  }

  // ---- helpers ----
  private list(): Pt[] { return this.edit ? this.edit.verts : this.verts; }
  private closedShape() { return !!this.edit?.closed; }
  private minVerts() { return this.edit ? (this.edit.closed ? 3 : 2) : 0; }
  private scr(v: Pt): Pt { return this.app.view.toScreen(v[0], v[1]); }
  private screenDist(v: Pt, p: PInfo) { const [x, y] = this.scr(v); return Math.hypot(x - p.sx, y - p.sy); }
  private nearest(list: Pt[], p: PInfo, tol: number) {
    let best = -1, bd = tol;
    list.forEach((v, i) => { const d = this.screenDist(v, p); if (d < bd) { bd = d; best = i; } });
    return best;
  }
  /** The edge (index of its first vertex) closest to the finger, with the point on it. */
  private hitEdge(list: Pt[], p: PInfo): { idx: number; pt: Pt } | null {
    const n = list.length, last = this.closedShape() ? n : n - 1;
    let best: { idx: number; pt: Pt } | null = null, bd = EDGE_PX;
    for (let i = 0; i < last; i++) {
      const a = list[i], b = list[(i + 1) % n], [ax, ay] = this.scr(a), [bx, by] = this.scr(b);
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      const t = l2 ? Math.min(1, Math.max(0, ((p.sx - ax) * dx + (p.sy - ay) * dy) / l2)) : 0;
      const d = Math.hypot(ax + dx * t - p.sx, ay + dy * t - p.sy);
      if (d < bd) { bd = d; best = { idx: i, pt: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] }; }
    }
    return best;
  }
  /** Neighbours of vertex i in the order they are connected. */
  private neighbours(i: number, n: number): number[] {
    const closed = this.closedShape(), out: number[] = [];
    if (i > 0) out.push(i - 1); else if (closed && n > 1) out.push(n - 1);
    if (i < n - 1) out.push(i + 1); else if (closed && n > 1) out.push(0);
    return out;
  }
  private build(v: Pt[], closed: boolean) { return dense(closed ? [...v, v[0]] : v, STEP_PX / this.app.view.cam.zoom); }
  private finish(closed: boolean) {
    const v = this.verts; this.verts = []; this.cur = null; this.drag = null; this.resetHistory();
    if (v.length < 2) { this.app.requestRender(); return; }
    const { pen, activeLayer, store } = this.app;
    const s: Stroke = {
      id: uid(), type: 'stroke', pts: this.build(v, closed), verts: v.flat(),
      color: pen.color, width: pen.width, alpha: pen.alpha, dash: pen.dash, fill: pen.fill, fillAlpha: pen.fillAlpha, closed, layer: activeLayer,
    };
    store.apply({ removed: [], added: [s] });
    this.app.requestRender(); this.app.notify();
  }
  /** Edit mode: replace the stroke by one with the current vertices (live; recorded when the finger lifts). */
  private applyEdit() {
    const e = this.edit!, old = e.cur;
    const next: Stroke = { ...old, pts: this.build(e.verts, e.closed), verts: e.verts.flat() };
    e.cur = next; // before applyLive: it triggers storeChanged
    this.app.store.applyLive({ removed: [old], added: [next] });
    this.app.requestRender();
  }
  private commitEdit() {
    const e = this.edit; if (!e || e.cur === e.orig) return;
    this.app.store.record({ removed: [e.orig], added: [e.cur] }); e.orig = e.cur;
  }
  /** Run a vertex change: checkpoint first while building, live-apply while editing. */
  private change(fn: (list: Pt[]) => void) {
    if (!this.edit) this.checkpoint();
    fn(this.list());
    if (this.edit) this.applyEdit();
  }
  private buzz() { navigator.vibrate?.(15); }

  // ---- long press ----
  private arm(h: Hold) {
    this.hold = h; clearTimeout(this.holdTimer);
    this.holdTimer = window.setTimeout(() => this.longPress(), HOLD_MS);
    this.app.requestRender();
  }
  private disarm() { clearTimeout(this.holdTimer); if (this.hold) { this.hold = null; this.app.requestRender(); } }
  private longPress() {
    const h = this.hold; this.hold = null; this.cur = null;
    if (!h || (this.drag?.moved)) return;
    if (h.kind === 'vertex') { // delete it
      const list = this.list();
      if (list.length > this.minVerts() && list.length > 1) { this.change(l => l.splice(h.idx, 1)); this.buzz(); }
      this.drag = null; this.consumed = true;
    } else { // insert on the edge, and keep dragging the new vertex
      this.change(l => l.splice(h.idx + 1, 0, h.pt)); this.buzz();
      this.drag = { idx: h.idx + 1, start: this.downAt!, moved: true, nearAtStart: [] };
    }
    this.app.requestRender(); this.app.notify();
  }

  // ---- pointer ----
  down(p: PInfo) {
    this.cur = null; this.consumed = false; this.mergeIdx = -1; this.downAt = p; this.disarm();
    const list = this.list();
    const idx = this.nearest(list, p, this.edit ? GRAB_PX : NEAR_PX);
    if (idx >= 0) {
      const nb = this.neighbours(idx, list.length);
      this.drag = { idx, start: p, moved: false, nearAtStart: nb.map(j => this.screenDist(list[j], this.screenPos(list[idx])) < MERGE_PX * 1.5) };
      this.arm({ kind: 'vertex', idx, pt: list[idx] });
    } else {
      const edge = this.hitEdge(list, p);
      if (edge) this.arm({ kind: 'edge', ...edge });
      if (!this.edit) this.cur = p; // about to place a new vertex (a long press on an edge cancels this)
    }
    this.app.requestRender();
  }
  private screenPos(v: Pt): PInfo { const [sx, sy] = this.scr(v); return { sx, sy, wx: v[0], wy: v[1] }; }
  move(p: PInfo) {
    if (this.holdTimer && this.downAt && Math.hypot(p.sx - this.downAt.sx, p.sy - this.downAt.sy) > DRAG_PX) this.disarm();
    const d = this.drag;
    if (d) {
      if (!d.moved && Math.hypot(p.sx - d.start.sx, p.sy - d.start.sy) > DRAG_PX) {
        d.moved = true; this.disarm();
        if (!this.edit) this.checkpoint();
      }
      if (d.moved) {
        const list = this.list(); list[d.idx] = [p.wx, p.wy];
        if (this.edit) this.applyEdit();
        // would dropping it here remove it (onto a neighbouring vertex it did not start next to)?
        const nb = this.neighbours(d.idx, list.length);
        this.mergeIdx = list.length > this.minVerts() && nb.some((j, k) => !d.nearAtStart[k] && this.screenDist(list[j], p) < MERGE_PX) ? d.idx : -1;
      }
    } else if (!this.edit && !this.consumed) this.cur = p;
    this.app.requestRender();
  }
  up(p: PInfo) {
    const d = this.drag; this.drag = null; this.disarm();
    const wasCur = this.cur; this.cur = null;
    if (d?.moved && this.mergeIdx === d.idx) { // dropped onto a neighbour: remove the vertex
      const list = this.list(); const i = d.idx;
      if (this.edit) { list.splice(i, 1); this.applyEdit(); } else list.splice(i, 1); // building: the checkpoint was taken when the drag began
      this.buzz();
    }
    this.mergeIdx = -1;
    if (this.edit) { this.commitEdit(); this.app.requestRender(); this.app.notify(); return; }
    const v = this.verts;
    if (this.consumed) { this.consumed = false; this.app.requestRender(); this.app.notify(); return; }
    if (d) { // pressed on an existing vertex
      if (d.moved) { this.app.requestRender(); this.app.notify(); return; }
      if (d.idx === 0 && v.length >= 3) this.finish(true);
      else if (d.idx === v.length - 1) { if (v.length >= 2) this.finish(false); else { this.checkpoint(); this.verts = []; } }
      this.app.requestRender(); this.app.notify(); return; // a tap on a middle vertex does nothing
    }
    if (!wasCur && v.length) { this.app.requestRender(); return; } // the press was a long press on an edge
    if (!v.length) { this.checkpoint(); v.push([p.wx, p.wy]); }
    else if (v.length >= 3 && this.screenDist(v[0], p) < NEAR_PX) this.finish(true);
    else if (this.screenDist(v[v.length - 1], p) < NEAR_PX) { if (v.length >= 2) this.finish(false); else { this.checkpoint(); this.verts = []; } }
    else { this.checkpoint(); v.push([p.wx, p.wy]); }
    this.app.requestRender(); this.app.notify();
  }
  /** A second finger (view gesture) or a system cancel: keep the vertices, just forget the finger. */
  cancel() {
    this.drag = null; this.cur = null; this.mergeIdx = -1; this.consumed = false; this.disarm();
    this.commitEdit(); this.app.requestRender();
  }
  deactivate() {
    this.drag = null; this.cur = null; this.disarm(); this.mergeIdx = -1;
    if (this.edit) { this.edit = null; this.app.requestRender(); return; }
    if (this.verts.length >= 2) this.finish(false); else this.verts = [];
    this.resetHistory(); this.app.notify();
  }

  overlay(ctx: CanvasRenderingContext2D) {
    const { pen, view } = this.app, z = view.cam.zoom;
    const dot = (x: number, y: number, r: number, fill = '#fff', ring = '#2979ff') => {
      ctx.beginPath(); ctx.arc(x, y, r / z, 0, Math.PI * 2);
      ctx.fillStyle = fill; ctx.fill(); ctx.lineWidth = 2 / z; ctx.strokeStyle = ring; ctx.stroke();
    };
    const holdMark = () => { // the armed long-press target: orange ring for a vertex (delete), orange dot on the edge (insert)
      const h = this.hold; if (!h) return;
      if (h.kind === 'vertex') dot(h.pt[0], h.pt[1], 13, 'rgba(255,152,0,.25)', '#ff9800'); else dot(h.pt[0], h.pt[1], 7, '#ff9800', '#fff');
    };
    ctx.save(); ctx.setLineDash([]);
    if (this.edit) { // the shape itself is drawn normally; show its vertices as handles
      this.edit.verts.forEach(([x, y], i) => dot(x, y, 8, this.drag?.idx === i ? '#2979ff' : '#fff', this.mergeIdx === i ? '#e53935' : '#2979ff'));
      holdMark(); ctx.restore(); return;
    }
    const v = this.verts;
    if (v.length) {
      const pts: Pt[] = [...v]; if (this.cur) pts.push([this.cur.wx, this.cur.wy]);
      const closing = !!this.cur && v.length >= 3 && this.screenDist(v[0], this.cur) < NEAR_PX;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); if (closing) ctx.closePath();
      if (pen.fill && v.length >= 3) { ctx.globalAlpha = pen.fillAlpha; ctx.fillStyle = pen.fill; ctx.fill(); }
      ctx.globalAlpha = pen.alpha; ctx.setLineDash(dashPattern(pen.dash, pen.width)); ctx.strokeStyle = pen.color; ctx.lineWidth = pen.width; ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      // vertices; the first one grows into a ring when a tap would close the polygon
      v.forEach(([x, y], i) => dot(x, y, i === 0 && closing ? 11 : 5.5, this.drag?.idx === i && this.drag.moved ? '#2979ff' : '#fff', this.mergeIdx === i ? '#e53935' : '#2979ff'));
    }
    holdMark();
    ctx.restore();
  }
}
