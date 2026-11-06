export interface PInfo { sx: number; sy: number; wx: number; wy: number }
export type ToolId = 'pen' | 'erase' | 'select' | 'wrap';
/** A tool receives world-space pointer events for a single-pointer gesture. */
export interface Tool {
  id: ToolId;
  down(p: PInfo): void;
  move(p: PInfo): void;
  up(p: PInfo): void;
  cancel(): void;
  overlay?(ctx: CanvasRenderingContext2D): void;
}
