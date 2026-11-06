import type { App } from '../app';
import { Stroke, uid } from '../types';
import { invalidate } from '../geom';
import type { PInfo, Tool } from './tool';

export class PenTool implements Tool {
  id = 'pen' as const;
  private s: Stroke | null = null;
  constructor(private app: App) {}
  down(p: PInfo) {
    this.s = { id: uid(), type: 'stroke', pts: [p.wx, p.wy], color: this.app.pen.color, width: this.app.pen.width };
    this.app.store.applyLive({ removed: [], added: [this.s] });
  }
  move(p: PInfo) {
    const s = this.s; if (!s) return;
    const n = s.pts.length, min = 1.2 / this.app.view.cam.zoom;
    if (Math.hypot(p.wx - s.pts[n - 2], p.wy - s.pts[n - 1]) < min) return;
    s.pts.push(p.wx, p.wy); invalidate(s); this.app.requestRender();
  }
  up(p: PInfo) {
    const s = this.s; if (!s) return;
    this.move(p);
    this.app.store.record({ removed: [], added: [s] });
    this.s = null;
  }
  cancel() {
    if (this.s) this.app.store.applyLive({ removed: [this.s], added: [] });
    this.s = null;
  }
}
