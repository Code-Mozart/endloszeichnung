import { View } from './view';
import { Store } from './store';
import { render } from './render';
import { DocData, PERIOD, Stroke, Wrap, uid } from './types';
import type { Tool, ToolId } from './tools/tool';
import { PenTool } from './tools/pen';
import { EraseTool } from './tools/erase';
import { SelectTool } from './tools/select';
import { WrapTool } from './tools/wrap';
import { loadDoc, saveDoc, setLast } from './persist';
import { thumbnail } from './exporter';

/** Central app state. Tools, renderer and UI all hang off this. */
export class App {
  view = new View();
  store = new Store();
  wrap: Wrap = { x: false, y: false };
  toolId: ToolId = 'pen';
  selection = new Set<string>();
  preview = new Map<string, Stroke>();
  pen = { color: '#1a1a1a', width: 3 };
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
      if (s) return { color: s.color, width: s.width };
    }
    return this.pen;
  }
  setStyle(patch: { color?: string; width?: number }, commit: boolean) {
    if (this.toolId === 'select' && this.selection.size) {
      if (!commit) return;
      const removed = [...this.selection].map(id => this.store.strokes.get(id)!).filter(Boolean);
      this.store.apply({ removed, added: removed.map(s => ({ ...s, ...patch })) });
    } else Object.assign(this.pen, patch);
    this.notify();
  }

  // ---- persistence ----
  loadData(d: DocData, thumb = '') {
    this.store.load(d.strokes, d.history, d.hIdx);
    this.view.cam = d.camera; this.wrap = d.wrap;
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
    if (this.contentDirty) { this.doc.updatedAt = Date.now(); this.doc.thumb = thumbnail(strokes); this.contentDirty = false; }
    const { id, name, createdAt, updatedAt, thumb } = this.doc;
    await saveDoc(
      { v: 1, id, name, createdAt, updatedAt, strokes, history: this.store.history, hIdx: this.store.hIdx, camera: { ...this.view.cam }, wrap: { ...this.wrap } },
      { id, name, createdAt, updatedAt, thumb });
  }
}
