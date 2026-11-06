import type { Camera } from './types';
import type { BB } from './geom';

export class View {
  cam: Camera = { cx: 1000, cy: 1000, zoom: 1, rot: 0 };
  w = 1; h = 1;
  toWorld(sx: number, sy: number): [number, number] {
    const dx = sx - this.w / 2, dy = sy - this.h / 2, c = Math.cos(-this.cam.rot), s = Math.sin(-this.cam.rot);
    return [this.cam.cx + (dx * c - dy * s) / this.cam.zoom, this.cam.cy + (dx * s + dy * c) / this.cam.zoom];
  }
  toScreen(wx: number, wy: number): [number, number] {
    const dx = (wx - this.cam.cx) * this.cam.zoom, dy = (wy - this.cam.cy) * this.cam.zoom;
    const c = Math.cos(this.cam.rot), s = Math.sin(this.cam.rot);
    return [this.w / 2 + dx * c - dy * s, this.h / 2 + dx * s + dy * c];
  }
  /** Keep world point `aw` under screen point (sx, sy) with the current zoom/rot. */
  anchor(aw: [number, number], sx: number, sy: number) {
    const [x, y] = this.toWorld(sx, sy);
    this.cam.cx += aw[0] - x; this.cam.cy += aw[1] - y;
  }
  clamp() { this.cam.zoom = Math.min(40, Math.max(0.05, this.cam.zoom)); }
  /** World-space AABB of the viewport. */
  bounds(): BB {
    const p = [this.toWorld(0, 0), this.toWorld(this.w, 0), this.toWorld(0, this.h), this.toWorld(this.w, this.h)];
    return {
      minX: Math.min(...p.map(a => a[0])), maxX: Math.max(...p.map(a => a[0])),
      minY: Math.min(...p.map(a => a[1])), maxY: Math.max(...p.map(a => a[1])),
    };
  }
}
