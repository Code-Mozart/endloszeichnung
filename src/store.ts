import { Diff, Stroke, MAX_HISTORY } from './types';

/** Document model. All edits go through apply()/record(); undo history is diff-based. */
export class Store {
  strokes = new Map<string, Stroke>();
  history: Diff[] = [];
  hIdx = 0;
  private listeners: (() => void)[] = [];
  onChange(fn: () => void) { this.listeners.push(fn); }
  private emit() { this.listeners.forEach(f => f()); }

  load(strokes: Stroke[], history: Diff[], hIdx: number) {
    this.strokes = new Map(strokes.map(s => [s.id, s]));
    this.history = history; this.hIdx = hIdx; this.emit();
  }
  /** Apply without recording (live gesture previews). */
  applyLive(d: Diff) {
    for (const s of d.removed) this.strokes.delete(s.id);
    for (const s of d.added) this.strokes.set(s.id, s);
    this.emit();
  }
  /** Record an already-applied diff as one history step. */
  record(d: Diff) {
    if (!d.removed.length && !d.added.length) return;
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
    this.applyLive({ removed: d.added, added: d.removed });
  }
  redo() {
    if (!this.canRedo) return;
    this.applyLive(this.history[this.hIdx++]);
  }
}

/** Accumulates many live diffs of one gesture into a single net history step. */
export class DiffBuilder {
  private orig = new Map<string, Stroke>();
  private added = new Map<string, Stroke>();
  remove(s: Stroke) { if (this.added.has(s.id)) this.added.delete(s.id); else this.orig.set(s.id, s); }
  add(s: Stroke) { this.added.set(s.id, s); }
  toDiff(): Diff { return { removed: [...this.orig.values()], added: [...this.added.values()] }; }
}
