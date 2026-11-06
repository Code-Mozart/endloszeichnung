import type { App } from '../app';
import { PERIOD as P, Stroke } from '../types';
import { BB, Mat, about, pointInPoly, rotateM, scaleM, strokeBB, transformStroke, translateM, unionBB } from '../geom';
import type { PInfo, Tool } from './tool';

interface Handle { sx: number; sy: number; rot: boolean; x: number; y: number }
const HIT_PX = 26;

export class SelectTool implements Tool {
  id = 'select' as const;
  private mode: 'idle' | 'lasso' | 'move' | 'scale' | 'rotate' = 'idle';
  private lasso: [number, number][] = [];
  private start: PInfo | null = null;
  private orig: Stroke[] = [];
  private pivot: [number, number] = [0, 0];
  private handle: Handle | null = null;
  private moved = false;
  constructor(private app: App) {}

  box(): BB | null {
    let b: BB | null = null;
    for (const id of this.app.selection) {
      const s = this.app.preview.get(id) ?? this.app.store.strokes.get(id);
      if (s) b = unionBB(b, strokeBB(s));
    }
    return b;
  }
  private handles(b: BB): Handle[] {
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2, z = this.app.view.cam.zoom;
    const hs: Handle[] = [];
    for (const sy of [-1, 0, 1]) for (const sx of [-1, 0, 1]) {
      if (!sx && !sy) continue;
      hs.push({ sx, sy, rot: false, x: cx + (sx * (b.maxX - b.minX)) / 2, y: cy + (sy * (b.maxY - b.minY)) / 2 });
    }
    hs.push({ sx: 0, sy: 0, rot: true, x: cx, y: b.minY - 40 / z });
    return hs;
  }
  private hitHandle(b: BB, p: PInfo): Handle | null {
    let best: Handle | null = null, bd = HIT_PX;
    for (const h of this.handles(b)) {
      const [x, y] = this.app.view.toScreen(h.x, h.y);
      const d = Math.hypot(x - p.sx, y - p.sy) - (h.rot ? 4 : 0);
      if (d < bd) { bd = d; best = h; }
    }
    return best;
  }

  down(p: PInfo) {
    this.start = p; this.moved = false;
    const b = this.box();
    if (b && this.app.selection.size) {
      const h = this.hitHandle(b, p);
      const inside = p.wx >= b.minX && p.wx <= b.maxX && p.wy >= b.minY && p.wy <= b.maxY;
      if (h || inside) {
        this.orig = [...this.app.selection].map(id => this.app.store.strokes.get(id)!).filter(Boolean);
        this.pivot = [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
        this.handle = h;
        this.mode = h ? (h.rot ? 'rotate' : 'scale') : 'move';
        return;
      }
    }
    this.mode = 'lasso'; this.lasso = [[p.wx, p.wy]];
  }
  move(p: PInfo) {
    if (this.mode === 'lasso') { this.lasso.push([p.wx, p.wy]); this.app.requestRender(); return; }
    if (this.mode === 'idle' || !this.start) return;
    this.moved = true;
    const [px, py] = this.pivot;
    let m: Mat;
    if (this.mode === 'move') m = translateM(p.wx - this.start.wx, p.wy - this.start.wy);
    else if (this.mode === 'rotate') {
      m = about(px, py, rotateM(Math.atan2(p.wy - py, p.wx - px) - Math.atan2(this.start.wy - py, this.start.wx - px)));
    } else {
      const h = this.handle!, hx = h.x - px, hy = h.y - py, rx = p.wx - px, ry = p.wy - py;
      const cl = (v: number) => (isFinite(v) ? Math.min(100, Math.max(0.02, v)) : 1);
      let sx = 1, sy = 1;
      if (h.sx && h.sy) sx = sy = cl(Math.hypot(rx, ry) / (Math.hypot(hx, hy) || 1));
      else if (h.sx) sx = cl(rx / (hx || 1));
      else sy = cl(ry / (hy || 1));
      m = about(px, py, scaleM(sx, sy));
    }
    this.app.preview = new Map(this.orig.map(s => [s.id, transformStroke(s, m)]));
    this.app.requestRender();
  }
  up(_p: PInfo) {
    const app = this.app;
    if (this.mode === 'lasso') {
      if (this.lasso.length < 4) app.selection.clear();
      else {
        const cx = this.lasso.reduce((a, q) => a + q[0], 0) / this.lasso.length;
        const cy = this.lasso.reduce((a, q) => a + q[1], 0) / this.lasso.length;
        app.selection = new Set();
        for (const s of app.store.strokes.values()) {
          if (!app.store.isVisible(s)) continue;
          for (let i = 0; i < s.pts.length; i += 2) {
            let x = s.pts[i], y = s.pts[i + 1];
            if (app.wrap.x) x += P * Math.round((cx - x) / P);
            if (app.wrap.y) y += P * Math.round((cy - y) / P);
            if (pointInPoly(x, y, this.lasso)) { app.selection.add(s.id); break; }
          }
        }
      }
      this.lasso = [];
    } else if (this.moved && app.preview.size) {
      const added = [...app.preview.values()];
      app.preview = new Map();
      app.store.apply({ removed: this.orig, added });
    } else app.preview = new Map();
    this.mode = 'idle'; this.app.requestRender(); this.app.notify();
  }
  cancel() { this.lasso = []; this.mode = 'idle'; this.app.preview = new Map(); this.app.requestRender(); }

  overlay(ctx: CanvasRenderingContext2D) {
    const z = this.app.view.cam.zoom;
    if (this.lasso.length > 1) {
      ctx.beginPath(); this.lasso.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath(); ctx.fillStyle = 'rgba(41,121,255,.12)'; ctx.fill();
      ctx.lineWidth = 2 / z; ctx.setLineDash([6 / z, 5 / z]); ctx.strokeStyle = '#2979ff'; ctx.stroke(); ctx.setLineDash([]);
    }
    const b = this.app.selection.size ? this.box() : null;
    if (!b) return;
    ctx.lineWidth = 1.5 / z; ctx.strokeStyle = '#2979ff'; ctx.setLineDash([]);
    ctx.strokeRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
    const hs = this.handles(b), rh = hs[hs.length - 1];
    ctx.beginPath(); ctx.moveTo((b.minX + b.maxX) / 2, b.minY); ctx.lineTo(rh.x, rh.y); ctx.stroke();
    ctx.fillStyle = '#fff';
    for (const h of hs) {
      ctx.beginPath();
      if (h.rot) ctx.arc(h.x, h.y, 9 / z, 0, Math.PI * 2); else ctx.rect(h.x - 6 / z, h.y - 6 / z, 12 / z, 12 / z);
      ctx.fill(); ctx.stroke();
    }
  }
}
