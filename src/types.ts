export type DashKind = 'solid' | 'dashed' | 'dotted' | 'dashdot' | 'longdash';
export const DASH_KINDS: DashKind[] = ['solid', 'dashed', 'dotted', 'dashdot', 'longdash'];
export interface Stroke { id: string; type: 'stroke'; pts: number[]; color: string; width: number; alpha?: number; layer?: string; dash?: DashKind; closed?: boolean; fill?: boolean }
/** A raster image placed in the drawing. `m` maps image pixels (0..iw, 0..ih) to world coordinates. */
export interface ImageObj { id: string; type: 'image'; img: string; iw: number; ih: number; m: [number, number, number, number, number, number]; alpha?: number; layer?: string }
export type Obj = Stroke | ImageObj;
/** Drawing style of the pen and shapes. Remembered per layer; it does not restyle existing objects. */
export interface PenStyle { color: string; width: number; alpha: number; dash: DashKind; fill: boolean }
export const DEFAULT_PEN: PenStyle = { color: '#1a1a1a', width: 3, alpha: 1, dash: 'solid', fill: false };
export interface Layer { id: string; name: string; opacity: number; visible: boolean }
export const defaultLayers = (): Layer[] => [{ id: 'l1', name: 'Layer 1', opacity: 1, visible: true }];
/** One undoable step: remove `removed` (by id), then append `added`. */
export interface Diff { removed: Obj[]; added: Obj[]; layers?: { from: Layer[]; to: Layer[] } }
export interface Camera { cx: number; cy: number; zoom: number; rot: number }
export interface Wrap { x: boolean; y: boolean }
/** Entry of the image gallery (blob stored separately). */
export interface GalleryEntry { id: string; name: string; iw: number; ih: number; thumb: string; createdAt: number }
export interface Meta { id: string; name: string; createdAt: number; updatedAt: number; thumb: string }
export interface DocData {
  v: 1; id: string; name: string; createdAt: number; updatedAt: number;
  strokes: Obj[]; history: Diff[]; hIdx: number; camera: Camera; wrap: Wrap; layers?: Layer[]; activeLayer?: string; grid?: boolean; layerStyles?: Record<string, PenStyle>;
}
export const PERIOD = 2000;
export const MAX_HISTORY = 1000;
export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
