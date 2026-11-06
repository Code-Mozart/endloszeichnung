import { View } from './view';
import { Store } from './store';
import { render } from './render';
import { DocData, GalleryEntry, ImageObj, Layer, Obj, PERIOD, Wrap, defaultLayers, uid } from './types';
import { Mat, mul, rotateM, scaleM, translateM } from './geom';
import type { Tool, ToolId } from './tools/tool';
import { PenTool } from './tools/pen';
import { EraseTool } from './tools/erase';
import { SelectTool } from './tools/select';
import { WrapTool } from './tools/wrap';
import { loadDoc, saveDoc, setLast } from './persist';
import { thumbnail } from './exporter';
import { preload } from './images';

/** Central app state. Tools, renderer and UI all hang off this. */
export class App {
  view = new View();
  store = new Store();
  wrap: Wrap = { x: false, y: false };
  toolId: ToolId = 'pen';
  selection = new Set<string>();
  preview = new Map<string, Obj>();
  pen = { color: '#1a1a1a', width: 3, alpha: 1 };
  activeLayer = 'l1';
  grid = true;
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
    this.tools = { pen: new PenTool(this), erase: new EraseTool(this), select: new SelectTool(this), wrap: new WrapTool() };
    this.store.onChange(() => {
      for (const id of this.selection) if (!this.store.strokes.has(id)) this.selection.delete(id);
      if (!this.store.layers.some(l => l.id === this.activeLayer)) this.activeLayer = this.store.layers[this.store.layers.length - 1].id;
      this.contentDirty = true; this.scheduleSave(); this.requestRender(); this.notify();
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
    if (id !== 'select') { this.selection.clear(); this.preview = new Map(); }
    this.toolId = id; this.requestRender(); this.notify();
  }
  /** Wrap button: first tap only activates the tool, further taps cycle modes. */
  wrapButton() {
    if (this.toolId !== 'wrap') return this.setTool('wrap');
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
  selectButton() {
    if (this.toolId === 'select') { this.selection.clear(); this.requestRender(); this.notify(); } else this.setTool('select');
  }

  /** Current style shown in UI (selection's style when something is selected). */
  styleView() {
    if (this.toolId === 'select' && this.selection.size) {
      const s = this.store.strokes.get([...this.selection][0]);
      if (s?.type === 'stroke') return { color: s.color, width: s.width, alpha: s.alpha ?? 1 };
      if (s) return { ...this.pen, alpha: s.alpha ?? 1 };
    }
    return this.pen;
  }
  setStyle(patch: { color?: string; width?: number; alpha?: number }, commit: boolean) {
    if (this.toolId === 'select' && this.selection.size) {
      if (!commit) return;
      const removed = [...this.selection].map(id => this.store.strokes.get(id)!).filter(Boolean);
      // images only take opacity; strokes take everything
      this.store.apply({ removed, added: removed.map(s => (s.type === 'stroke' ? { ...s, ...patch } : patch.alpha === undefined ? s : { ...s, alpha: patch.alpha })) });
    } else Object.assign(this.pen, patch);
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
  setActiveLayer(id: string) { this.activeLayer = id; this.scheduleSave(); this.notify(); }
  addLayer() {
    const ls = this.store.snapshotLayers();
    let n = 1; while (ls.some(l => l.name === 'Layer ' + n)) n++;
    const layer: Layer = { id: uid(), name: 'Layer ' + n, opacity: 1, visible: true };
    ls.splice(ls.findIndex(l => l.id === this.activeLayer) + 1, 0, layer);
    this.activeLayer = layer.id;
    this.store.setLayers(ls);
  }
  removeLayer(id: string) {
    const ls = this.store.snapshotLayers(); if (ls.length <= 1) return;
    const i = ls.findIndex(l => l.id === id); if (i < 0) return;
    const gone = [...this.store.strokes.values()].filter(s => this.store.layerOf(s) === id);
    ls.splice(i, 1);
    if (this.activeLayer === id) this.activeLayer = ls[Math.min(i, ls.length - 1)].id;
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
    this.activeLayer = d.activeLayer && this.store.layers.some(l => l.id === d.activeLayer) ? d.activeLayer : this.store.layers[this.store.layers.length - 1].id;
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
      { v: 1, id, name, createdAt, updatedAt, strokes, history: this.store.history, hIdx: this.store.hIdx, camera: { ...this.view.cam }, wrap: { ...this.wrap }, layers: this.store.layers, activeLayer: this.activeLayer, grid: this.grid },
      { id, name, createdAt, updatedAt, thumb });
  }
}
