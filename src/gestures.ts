import type { App } from './app';
import type { PInfo } from './tools/tool';

/** Pointer handling: 1 pointer -> active tool, 2 touches -> pan/zoom/rotate. */
export function attachGestures(canvas: HTMLCanvasElement, app: App, activity: () => void) {
  const { view } = app;
  const ptrs = new Map<number, { x: number; y: number; type: string }>();
  let toolPtr: number | null = null;
  let locked = false; // after a 2-finger gesture, ignore remaining finger until all lifted
  let nav: { aw: [number, number]; z0: number; r0: number; d0: number; a0: number } | null = null;

  const info = (x: number, y: number): PInfo => { const [wx, wy] = view.toWorld(x, y); return { sx: x, sy: y, wx, wy }; };
  const two = () => { const [a, b] = [...ptrs.values()]; return { mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) || 1, ang: Math.atan2(b.y - a.y, b.x - a.x) }; };
  const penDown = () => [...ptrs.values()].some(p => p.type === 'pen');

  canvas.addEventListener('pointerdown', e => {
    if (e.pointerType === 'touch' && penDown()) return; // palm rejection
    canvas.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    activity();
    if (ptrs.size === 1 && !locked) {
      toolPtr = e.pointerId; app.activeTool().down(info(e.clientX, e.clientY));
    } else if (ptrs.size >= 2 && e.pointerType === 'touch') {
      if (toolPtr !== null) { app.activeTool().cancel(); toolPtr = null; }
      locked = true; app.navActive = true;
      const t = two();
      nav = { aw: view.toWorld(t.mx, t.my), z0: view.cam.zoom, r0: view.cam.rot, d0: t.d, a0: t.ang };
    }
  });
  canvas.addEventListener('pointermove', e => {
    const p = ptrs.get(e.pointerId); if (!p) return;
    p.x = e.clientX; p.y = e.clientY; activity();
    if (nav && ptrs.size >= 2) {
      const t = two();
      view.cam.zoom = nav.z0 * (t.d / nav.d0);
      if (!app.rotLocked) view.cam.rot = nav.r0 + (t.ang - nav.a0);
      view.clamp();
      view.anchor(nav.aw, t.mx, t.my); app.cameraChanged();
    } else if (e.pointerId === toolPtr) {
      const evs = e.getCoalescedEvents?.() ?? [];
      for (const c of evs.length ? evs : [e]) app.activeTool().move(info(c.clientX, c.clientY));
    }
  });
  const end = (e: PointerEvent, cancelled: boolean) => {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.delete(e.pointerId); activity();
    if (e.pointerId === toolPtr) {
      toolPtr = null;
      if (cancelled) app.activeTool().cancel(); else app.activeTool().up(info(e.clientX, e.clientY));
    }
    if (ptrs.size < 2 && nav) { nav = null; app.navActive = false; app.lockRotation(); app.notify(); }
    if (ptrs.size === 0) locked = false;
  };
  canvas.addEventListener('pointerup', e => end(e, false));
  canvas.addEventListener('pointercancel', e => end(e, true));

  // desktop convenience: wheel = zoom, shift+wheel = rotate
  canvas.addEventListener('wheel', e => {
    e.preventDefault(); activity();
    const aw = view.toWorld(e.clientX, e.clientY);
    if (e.shiftKey) view.cam.rot += e.deltaY * 0.002; else view.cam.zoom *= Math.exp(-e.deltaY * 0.0015);
    view.clamp(); view.anchor(aw, e.clientX, e.clientY); app.cameraChanged();
  }, { passive: false });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  for (const t of ['gesturestart', 'gesturechange']) document.addEventListener(t, e => e.preventDefault());
}
