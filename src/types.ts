export interface Stroke { id: string; type: 'stroke'; pts: number[]; color: string; width: number; alpha?: number; layer?: string }
export interface Layer { id: string; name: string; opacity: number; visible: boolean }
export const defaultLayers = (): Layer[] => [{ id: 'l1', name: 'Layer 1', opacity: 1, visible: true }];
/** One undoable step: remove `removed` (by id), then append `added`. */
export interface Diff { removed: Stroke[]; added: Stroke[]; layers?: { from: Layer[]; to: Layer[] } }
export interface Camera { cx: number; cy: number; zoom: number; rot: number }
export interface Wrap { x: boolean; y: boolean }
export interface Meta { id: string; name: string; createdAt: number; updatedAt: number; thumb: string }
export interface DocData {
  v: 1; id: string; name: string; createdAt: number; updatedAt: number;
  strokes: Stroke[]; history: Diff[]; hIdx: number; camera: Camera; wrap: Wrap; layers?: Layer[]; activeLayer?: string;
}
export const PERIOD = 2000;
export const MAX_HISTORY = 1000;
export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
