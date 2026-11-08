import { View } from './view';
import { Store } from './store';
import { render } from './render';
import { DEFAULT_PEN, DashKind, DocData, GalleryEntry, ImageObj, Layer, Obj, PERIOD, PenStyle, Stroke, Wrap, defaultLayers, uid } from './types';
import { Mat, mul, objBB, rotateM, scaleM, strokeClosed, strokeFill, transformObj, translateM, unionBB } from './geom';
import type { Tool, ToolId } from './tools/tool';
import { PenTool } from './tools/pen';
import { EraseTool } from './tools/erase';
import { SelectTool } from './tools/select';
import { ShapeKind, ShapeTool } from './tools/shapes';
import { PolyTool } from './tools/poly';
import { loadDoc, saveDoc, setLast } from './persist';
import { thumbnail } from './exporter';
import { preload } from './images';

/** Saved layer styles from older versions had a boolean fill ("fill with the line color"). */
function normalizePen(p: PenStyle): PenStyle {
  const f = p.fill as unknown;
  return { ...p, fill: typeof f === 'string' ? f : f === true ? p.color : null, fillAlpha: p.fillAlpha ?? 1 };
}

/** Central app state. Tools, renderer and UI all hang off this. */
export class App {
  view = new View();
  store = new Store();
  wrap: Wrap = { x: false, y: false };
  toolId: ToolId = 'pen';
  selection = new Set<string>();
  preview = new Map<string, Obj>();
  pen: PenStyle = { ...DEFAULT_PEN };
  /** Pen style remembered per layer (saved with the drawing, not part of undo). */
  layerStyles: Record<string, PenStyle> = {};
  clipboard: Obj[] = [];
  activeLayer = 'l1';
  grid = true;
  shapeKind: ShapeKind = 'line';
  private opBefore: Layer[] | null = null;
  dpr = 1;
  /** Rotation gesture is locked by default; the rotation button unlocks it briefly. */
  rotLocked = true;
  navActive = false;
  private rotTimer = 0;
  ctx!: CanvasRenderingContext2D;
  tools: Record<ToolId, Tool>;
  doc = { id: '', name: '', createdAt: 0, updatedAt: 0, thumb: '' };
  private listeners: (() => void)[] = [];
  private raf = 0;
  private saveTimer = 0;
  private contentDirty = false;

  constructor() {
    this.tools = { pen: new PenTool(this), erase: new EraseTool(this), select: new SelectTool(this), shapes: new ShapeTool(this), poly: new PolyTool(this) };
    this.store.onChange(() => {
      for (const id of this.selection) if (!this.store.strokes.has(id)) this.selection.delete(id);
      if (!this.store.layers.some(l => l.id === this.activeLayer)) this.activate(this.store.layers[this.store.layers.length - 1].id);
      this.contentDirty = true; this.scheduleSave(); this.requestRender(); this.notify();
      this.activeTool().storeChanged?.();
    });
  }
  activeTool() { return this.tools[this.toolId]; }
  onNotify(fn: () => void) { this.listeners.push(fn); }
  notify() { this.listeners.forEach(f => f()); }
  requestRender() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; render(this.ctx, this); });
  }
  cameraChanged() { this.scheduleSave(); this.requestRender(); }

  /** View heading if the rotation is aligned to a cardinal direction (0 = north, top of screen points to it). */
  heading(): 'N' | 'E' | 'S' | 'W' | null {
    const k = -this.view.cam.rot / (Math.PI / 2);
    if (Math.abs(k - Math.round(k)) > 0.05) return null;
    return (['N', 'E', 'S', 'W'] as const)[((Math.round(k) % 4) + 4) % 4];
  }
  /** Rotation button: step N -> E -> S -> W (or snap to N when freely rotated), then allow rotating for 1s / one gesture. */
  unlockRotation() {
    const h = this.heading();
    const next = h ? (['N', 'E', 'S', 'W'].indexOf(h) + 1) % 4 : 0;
    this.view.cam.rot = [0, -Math.PI / 2, Math.PI, Math.PI / 2][next];
    this.cameraChanged();
    this.rotLocked = false; this.notify();
    clearTimeout(this.rotTimer);
    this.rotTimer = window.setTimeout(() => { if (!this.navActive) this.lockRotation(); }, 1000);
  }
  lockRotation() {
    clearTimeout(this.rotTimer);
    if (!this.rotLocked) { this.rotLocked = true; this.notify(); }
  }

  setTool(id: ToolId) {
    if (id !== this.toolId) this.activeTool().deactivate?.(); // e.g. finish a polyline in progress
    if (id !== 'select') { this.selection.clear(); this.preview = new Map(); }
    this.toolId = id; this.requestRender(); this.notify();
  }
  /** Wrap button: every tap cycles none -> vertical -> horizontal -> both. */
  wrapButton() {
    const m = (this.wrap.x ? 1 : 0) + (this.wrap.y ? 2 : 0);
    const n = (m + 1) % 4; // 0 none, 1 vertical seams (upright cylinder), 2 horizontal seams, 3 torus
    this.wrap = { x: n === 1 || n === 3, y: n === 2 || n === 3 };
    this.cameraChanged(); this.notify();
  }
  deleteSelection() {
    const removed = [...this.selection].map(id => this.store.strokes.get(id)!).filter(Boolean);
    this.selection.clear();
    this.store.apply({ removed, added: [] });
    this.notify();
  }
  /** The polygon the select tool has selected (and only it), if it can be edited. */
  selectedPolygon(): Stroke | null {
    if (this.toolId !== 'select' || this.selection.size !== 1) return null;
    const o = this.store.strokes.get([...this.selection][0]);
    return o?.type === 'stroke' && o.verts && o.verts.length >= 4 ? o : null;
  }
  isEditingPolygon() { return this.toolId === 'poly' && (this.tools.poly as PolyTool).editing; }
  /** Polygon button: start a new polygon, or edit the selected one (the button then says "Edit"). */
  polyButton() {
    const sel = this.selectedPolygon();
    if (this.toolId === 'poly' && !sel) return; // already there
    this.setTool('poly');
    if (sel) { (this.tools.poly as PolyTool).beginEdit(sel); this.notify(); } // refresh the label: it says "Edit" now
  }
  // ---- undo / redo: a tool with work in progress (polygon vertices) gets them first ----
  get canUndo() { return !!this.activeTool().canUndo?.() || this.store.canUndo; }
  get canRedo() { return !!this.activeTool().canRedo?.() || this.store.canRedo; }
  undo() { if (!this.activeTool().undo?.()) this.store.undo(); }
  redo() { if (!this.activeTool().redo?.()) this.store.redo(); }
  /** Each shape has its own button: activate the shapes tool with that shape. */
  shapeButton(kind: ShapeKind) { this.shapeKind = kind; this.setTool('shapes'); }

  // ---- clipboard ----
  copySelection() {
    const objs = [...this.selection].map(id => this.store.strokes.get(id)).filter((o): o is Obj => !!o);
    if (!objs.length) return;
    this.clipboard = objs.map(o => structuredClone(o)); this.notify();
  }
  cutSelection() { if (this.selection.size) { this.copySelection(); this.deleteSelection(); } }
  /** Paste into the active layer, centered in the view, and select the pasted objects. */
  pasteClipboard() {
    if (!this.clipboard.length) return;
    let bb = null as ReturnType<typeof objBB> | null;
    for (const o of this.clipboard) bb = unionBB(bb, objBB(o));
    const m = translateM(this.view.cam.cx - (bb!.minX + bb!.maxX) / 2, this.view.cam.cy - (bb!.minY + bb!.maxY) / 2);
    const added = this.clipboard.map(o => ({ ...transformObj(o, m), id: uid(), layer: this.activeLayer }) as Obj);
    this.store.apply({ removed: [], added });
    this.setTool('select'); this.selection = new Set(added.map(o => o.id));
    this.requestRender(); this.notify();
  }
  selectButton() {
    if (this.toolId === 'select') { this.selection.clear(); this.requestRender(); this.notify(); } else this.setTool('select');
  }

  /** Current style shown in UI (selection's style when something is selected). */
  styleView() {
    if (this.toolId === 'select' && this.selection.size) {
      const s = this.store.strokes.get([...this.selection][0]);
      if (s?.type === 'stroke') {
        // the fill shown is the one of the first closed shape in the selection
        const closed = [...this.selection].map(id => this.store.strokes.get(id)).find(o => o?.type === 'stroke' && strokeClosed(o));
        const fl = closed?.type === 'stroke' ? strokeFill(closed) : null;
        return { color: s.color, width: s.width, alpha: s.alpha ?? 1, dash: s.dash ?? 'solid', fill: fl ? fl.color : null, fillAlpha: fl ? fl.alpha : this.pen.fillAlpha };
      }
      if (s) return { ...this.pen, alpha: s.alpha ?? 1 };
    }
    return this.pen;
  }
  /** Fill only makes sense for closed shapes: not for lines and arrows, nor for a selection without any closed shape. */
  fillAvailable(): boolean {
    if (this.toolId === 'select' && this.selection.size) {
      return [...this.selection].some(id => { const o = this.store.strokes.get(id); return o?.type === 'stroke' && strokeClosed(o); });
    }
    return !(this.toolId === 'shapes' && (this.shapeKind === 'line' || this.shapeKind === 'arrow'));
  }
  /** Finish whatever the active tool has in progress (before switching drawings). */
  endToolSession() { this.activeTool().deactivate?.(); }
  setStyle(patch: { color?: string; width?: number; alpha?: number; dash?: DashKind; fill?: string | null; fillAlpha?: number }, commit: boolean) {
    if (this.toolId === 'select' && this.selection.size) {
      if (!commit) return;
      const removed = [...this.selection].map(id => this.store.strokes.get(id)!).filter(Boolean);
      // images only take opacity; strokes take everything
      const { fill, fillAlpha, ...rest } = patch;
      this.store.apply({
        removed,
        added: removed.map(s => {
          if (s.type !== 'stroke') return patch.alpha === undefined ? s : { ...s, alpha: patch.alpha };
          const ns = { ...s, ...rest };
          if (strokeClosed(s)) { // the fill only applies to closed shapes
            if (fill !== undefined) { ns.fill = fill; if (fill && ns.fillAlpha === undefined) ns.fillAlpha = this.pen.fillAlpha; }
            if (fillAlpha !== undefined) ns.fillAlpha = fillAlpha;
          }
          return ns;
        }),
      });
    } else {
      Object.assign(this.pen, patch);
      this.layerStyles[this.activeLayer] = { ...this.pen }; this.scheduleSave();
    }
    this.notify();
  }

  // ---- images ----
  /** Place a gallery image at the center of the view (upright on screen, ~60% of the view) on the active layer and select it. */
  async addImage(e: GalleryEntry) {
    await preload([e.id]);
    const { zoom, rot, cx, cy } = this.view.cam;
    const k = 0.6 * Math.min(this.view.w / zoom / e.iw, this.view.h / zoom / e.ih);
    const m: Mat = mul(translateM(cx, cy), mul(rotateM(-rot), mul(scaleM(k, k), translateM(-e.iw / 2, -e.ih / 2))));
    const obj: ImageObj = { id: uid(), type: 'image', img: e.id, iw: e.iw, ih: e.ih, m, layer: this.activeLayer };
    this.store.apply({ removed: [], added: [obj] });
    this.setTool('select'); this.selection = new Set([obj.id]);
    this.requestRender(); this.notify();
  }

  // ---- layers ----
  /** Make a layer active and switch the pen to that layer's style (a layer without one starts with the current style). */
  private activate(id: string) {
    this.activeLayer = id;
    this.pen = normalizePen({ ...DEFAULT_PEN, ...(this.layerStyles[id] ?? this.pen) });
    this.layerStyles[id] = { ...this.pen };
  }
  setActiveLayer(id: string) {
    if (id !== this.activeLayer) { this.selection.clear(); this.activate(id); }
    this.scheduleSave(); this.notify();
  }
  /** Take over another layer's remembered style for the active layer (and the pen). */
  copyLayerStyle(fromId: string) {
    const st = this.layerStyles[fromId]; if (!st || fromId === this.activeLayer) return;
    this.pen = normalizePen({ ...st }); this.layerStyles[this.activeLayer] = { ...this.pen };
    this.scheduleSave(); this.notify();
  }
  addLayer() {
    const ls = this.store.snapshotLayers();
    let n = 1; while (ls.some(l => l.name === 'Layer ' + n)) n++;
    const layer: Layer = { id: uid(), name: 'Layer ' + n, opacity: 1, visible: true };
    ls.splice(ls.findIndex(l => l.id === this.activeLayer) + 1, 0, layer);
    this.activate(layer.id);
    this.store.setLayers(ls);
  }
  removeLayer(id: string) {
    const ls = this.store.snapshotLayers(); if (ls.length <= 1) return;
    const i = ls.findIndex(l => l.id === id); if (i < 0) return;
    const gone = [...this.store.strokes.values()].filter(s => this.store.layerOf(s) === id);
    ls.splice(i, 1);
    delete this.layerStyles[id];
    if (this.activeLayer === id) this.activate(ls[Math.min(i, ls.length - 1)].id);
    this.store.setLayers(ls, gone);
  }
  /** New stacking order, given bottom -> top. No-op if nothing changed. */
  setLayerOrder(idsBottomFirst: string[]) {
    const ls = this.store.snapshotLayers();
    const next = idsBottomFirst.map(id => ls.find(l => l.id === id)).filter((l): l is Layer => !!l);
    if (next.length !== ls.length || next.every((l, i) => l.id === ls[i].id)) return;
    this.store.setLayers(next);
  }
  renameLayer(id: string, name: string) {
    name = name.trim().slice(0, 40);
    const ls = this.store.snapshotLayers(), l = ls.find(x => x.id === id);
    if (!l || !name || l.name === name) return;
    l.name = name; this.store.setLayers(ls);
  }
  toggleGrid() { this.grid = !this.grid; this.scheduleSave(); this.requestRender(); this.notify(); }
  toggleLayerVisible(id: string) {
    const ls = this.store.snapshotLayers(), l = ls.find(x => x.id === id); if (!l) return;
    l.visible = !l.visible; this.store.setLayers(ls);
  }
  /** Live opacity preview while a slider is dragged; commitLayerOpacity() makes it one undo step. */
  layerOpacityLive(id: string, v: number) {
    const l = this.store.layers.find(x => x.id === id); if (!l) return;
    if (!this.opBefore) this.opBefore = this.store.snapshotLayers();
    l.opacity = v; this.requestRender();
  }
  commitLayerOpacity() {
    if (!this.opBefore) return;
    const from = this.opBefore; this.opBefore = null;
    this.store.commitLayersFrom(from);
  }

  // ---- persistence ----
  loadData(d: DocData, thumb = '') {
    this.store.load(d.strokes, d.history, d.hIdx, d.layers ?? defaultLayers());
    this.layerStyles = { ...(d.layerStyles ?? {}) };
    const act = d.activeLayer && this.store.layers.some(l => l.id === d.activeLayer) ? d.activeLayer : this.store.layers[this.store.layers.length - 1].id;
    this.pen = { ...DEFAULT_PEN }; // layers without a stored style start from the default
    this.activate(act);
    this.view.cam = d.camera; this.wrap = d.wrap; this.grid = d.grid ?? true;
    this.doc = { id: d.id, name: d.name, createdAt: d.createdAt, updatedAt: d.updatedAt, thumb };
    this.selection.clear(); this.preview = new Map(); this.contentDirty = false;
    setLast(d.id); this.requestRender(); this.notify();
  }
  newDoc() {
    const now = Date.now();
    this.loadData({
      v: 1, id: uid(), name: 'Drawing ' + new Date(now).toLocaleDateString(), createdAt: now, updatedAt: now,
      strokes: [], history: [], hIdx: 0, camera: { cx: PERIOD / 2, cy: PERIOD / 2, zoom: (this.view.h * 0.92) / PERIOD, rot: 0 }, wrap: { x: false, y: false },
    });
    this.contentDirty = true; this.scheduleSave();
  }
  async openDoc(id: string) {
    this.endToolSession();
    await this.flush();
    const d = await loadDoc(id);
    if (d) this.loadData(d);
  }
  scheduleSave() { clearTimeout(this.saveTimer); this.saveTimer = window.setTimeout(() => this.flush(), 800); }
  async flush() {
    clearTimeout(this.saveTimer);
    if (!this.doc.id) return;
    const strokes = [...this.store.strokes.values()];
    if (this.contentDirty) { this.doc.updatedAt = Date.now(); this.doc.thumb = thumbnail(strokes, this.store.layers); this.contentDirty = false; }
    const { id, name, createdAt, updatedAt, thumb } = this.doc;
    await saveDoc(
      { v: 1, id, name, createdAt, updatedAt, strokes, history: this.store.history, hIdx: this.store.hIdx, camera: { ...this.view.cam }, wrap: { ...this.wrap }, layers: this.store.layers, activeLayer: this.activeLayer, grid: this.grid, layerStyles: Object.fromEntries(Object.entries(this.layerStyles).filter(([id]) => this.store.layers.some(l => l.id === id))) },
      { id, name, createdAt, updatedAt, thumb });
  }
}
