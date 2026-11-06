import { Diff, Layer, Obj, MAX_HISTORY, defaultLayers } from './types';

const cloneLayers = (l: Layer[]) => l.map(x => ({ ...x }));

/** Document model. All edits go through apply()/record(); undo history is diff-based (strokes + layer list). */
export class Store {
  strokes = new Map<string, Obj>();
  layers: Layer[] = defaultLayers(); // bottom -> top
  history: Diff[] = [];
  hIdx = 0;
  private ids = new Set<string>(this.layers.map(l => l.id));
  private listeners: (() => void)[] = [];
  onChange(fn: () => void) { this.listeners.push(fn); }
  private emit() { this.listeners.forEach(f => f()); }
  private setLayerList(l: Layer[]) { this.layers = l.length ? l : defaultLayers(); this.ids = new Set(this.layers.map(x => x.id)); }

  load(strokes: Obj[], history: Diff[], hIdx: number, layers: Layer[]) {
    this.strokes = new Map(strokes.map(s => [s.id, s]));
    this.setLayerList(cloneLayers(layers));
    this.history = history; this.hIdx = hIdx; this.emit();
  }
  /** Layer a stroke lives in; unknown or missing layers fall back to the bottom layer. */
  layerOf(s: Obj): string { return s.layer && this.ids.has(s.layer) ? s.layer : this.layers[0].id; }
  isVisible(s: Obj): boolean { const id = this.layerOf(s); return !!this.layers.find(l => l.id === id)?.visible; }

  /** Apply without recording (live gesture previews). */
  applyLive(d: Diff) {
    for (const s of d.removed) this.strokes.delete(s.id);
    for (const s of d.added) this.strokes.set(s.id, s);
    if (d.layers) this.setLayerList(cloneLayers(d.layers.to));
    this.emit();
  }
  /** Record an already-applied diff as one history step. */
  record(d: Diff) {
    if (!d.removed.length && !d.added.length && !d.layers) return;
    this.history.length = this.hIdx;
    this.history.push(d);
    if (this.history.length > MAX_HISTORY) this.history.shift();
    this.hIdx = this.history.length;
    this.emit();
  }
  apply(d: Diff) { this.applyLive(d); this.record(d); }
  get canUndo() { return this.hIdx > 0; }
  get canRedo() { return this.hIdx < this.history.length; }
  undo() {
    if (!this.canUndo) return;
    const d = this.history[--this.hIdx];
    this.applyLive({ removed: d.added, added: d.removed, layers: d.layers && { from: d.layers.to, to: d.layers.from } });
  }
  redo() {
    if (!this.canRedo) return;
    this.applyLive(this.history[this.hIdx++]);
  }

  /** Change the layer list (and optionally delete strokes along with it) as one undo step. */
  setLayers(to: Layer[], removed: Obj[] = []) {
    this.apply({ removed, added: [], layers: { from: cloneLayers(this.layers), to: cloneLayers(to) } });
  }
  /** Record a layer change that was already applied live (e.g. dragging an opacity slider). */
  commitLayersFrom(from: Layer[]) {
    this.record({ removed: [], added: [], layers: { from, to: cloneLayers(this.layers) } });
  }
  snapshotLayers() { return cloneLayers(this.layers); }
}

/** Accumulates many live diffs of one gesture into a single net history step. */
export class DiffBuilder {
  private orig = new Map<string, Obj>();
  private added = new Map<string, Obj>();
  remove(s: Obj) { if (this.added.has(s.id)) this.added.delete(s.id); else this.orig.set(s.id, s); }
  add(s: Obj) { this.added.set(s.id, s); }
  toDiff(): Diff { return { removed: [...this.orig.values()], added: [...this.added.values()] }; }
}
