export interface PInfo { sx: number; sy: number; wx: number; wy: number }
export type ToolId = 'pen' | 'erase' | 'select' | 'shapes' | 'poly';
/** A tool receives world-space pointer events for a single-pointer gesture. */
export interface Tool {
  id: ToolId;
  down(p: PInfo): void;
  move(p: PInfo): void;
  up(p: PInfo): void;
  cancel(): void;
  /** Called when another tool takes over (or the drawing is switched). */
  deactivate?(): void;
  /** The document changed (undo/redo, edits): a tool holding copies of document data can refresh them. */
  storeChanged?(): void;
  /** Work in progress that has its own undo/redo (e.g. the vertices of a polygon being drawn). Return true if handled. */
  undo?(): boolean;
  redo?(): boolean;
  canUndo?(): boolean;
  canRedo?(): boolean;
  overlay?(ctx: CanvasRenderingContext2D): void;
}
