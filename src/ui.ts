import type { App } from './app';
import type { ToolId } from './tools/tool';
import { deleteDoc, deleteImageBlob, imageStillUsed, listGallery, listMetas, loadDoc, putImage, removeGalleryEntry } from './persist';
import { decodeFile, forget } from './images';
import { bounds, download, drawLayerThumb, toBlob, toSVG } from './exporter';
import { groupByLayer } from './scene';
import { DASH_KINDS, DashKind, Layer, Obj, defaultLayers } from './types';
import type { BB } from './geom';
import { dashPattern } from './geom';
import type { ShapeKind } from './tools/shapes';

const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;
const SWATCHES = ['#1a1a1a', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#8e24aa', '#ffffff'];

export function setupUI(app: App) {
  const POPS = ['#style', '#layers', '#images', '#gal'];
  const togglePop = (id: string) => {
    if (id === '#style' && $(id).classList.contains('off')) fillMode = false; // opening the style popup: start by editing the line
    POPS.forEach(p => { if (p !== id) $(p).classList.add('off'); });
    return $(id).classList.toggle('off');
  };
  // ---- auto-hide: hide on any canvas interaction, return after 0.3s idle ----
  let timer = 0, held = 0;
  const show = () => { if (held > 0) return schedule(); document.body.classList.remove('ui-hidden'); };
  const schedule = () => { clearTimeout(timer); timer = window.setTimeout(show, 300); };
  const activity = () => { document.body.classList.add('ui-hidden'); POPS.forEach(p => $(p).classList.add('off')); schedule(); };

  // ---- toolbar ----
  document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach(b => b.onclick = () => {
    // while something is selected the erase button becomes "delete selected"
    if (b.dataset.tool === 'erase' && app.toolId === 'select' && app.selection.size) app.deleteSelection();
    else if (b.dataset.tool === 'poly') app.polyButton(); // new polygon, or edit the selected one
    else app.setTool(b.dataset.tool as ToolId);
  });
  $('#selBtn').onclick = () => app.selectButton();
  $('#wrapBtn').onclick = () => app.wrapButton();
  $('#gridBtn').onclick = () => app.toggleGrid();
  document.querySelectorAll<HTMLButtonElement>('[data-shape]').forEach(b => b.onclick = () => app.shapeButton(b.dataset.shape as ShapeKind));
  $('#cutBtn').onclick = () => app.cutSelection();
  $('#copyBtn').onclick = () => app.copySelection();
  $('#pasteBtn').onclick = () => app.pasteClipboard();
  $('#undo').onclick = () => app.undo();
  $('#redo').onclick = () => app.redo();
  $('#north').onclick = () => app.unlockRotation();
  $('#styleBtn').onclick = () => { togglePop('#style'); };
  $('#layersBtn').onclick = () => { togglePop('#layers'); renderLayers(); };
  $('#imagesBtn').onclick = () => { if (!togglePop('#images')) renderGallery(); };

  // ---- second and third toolbar rows, toggled together (persisted per device) ----
  const row2 = $('#row2'), bar = $('#bar');
  // the app starts with all rows expanded; collapsing the menu also closes every popup
  const setRow2 = (open: boolean) => {
    row2.classList.toggle('off', !open); $('#row3').classList.toggle('off', !open);
    if (!open) POPS.forEach(p => $(p).classList.add('off'));
  };
  setRow2(true);
  // popovers sit right above the toolbar, whatever its height
  new ResizeObserver(() => document.documentElement.style.setProperty('--barh', bar.offsetHeight + 'px')).observe(bar);

  // ---- long-press tooltips ----
  const TIPS: Record<string, string> = {
    pen: 'Pen: draw', eraseBtn: 'Eraser: cuts strokes', selBtn: 'Lasso select (tap again: clear selection)',
    arrowBtn: 'Arrow: drag to draw', lineBtn: 'Line: drag to draw', circleBtn: 'Circle: drag from the center to the edge', rectBtn: 'Rectangle: drag between two corners',
    cutBtn: 'Cut the selected objects', copyBtn: 'Copy the selected objects', pasteBtn: 'Paste into the active layer and select',
    wrapBtn: 'Wrap: tap to cycle none / vertical / horizontal / both',
    styleBtn: 'Color and thickness', undo: 'Undo', redo: 'Redo', north: 'Turn view to the next compass direction (N, E, S, W) and unlock rotating for 1s; rotation is locked otherwise', files: 'Drawings: switch, export', layersBtn: 'Layers: order, add, remove, rename, opacity', imagesBtn: 'Image gallery: upload pictures and add them to the drawing', gridBtn: 'Show or hide the background grid', polyBtn: 'Polygon / polyline: tap to place each point. Tap the last point to finish, tap the first point to close the shape',
  };
  const tip = document.createElement('div'); tip.id = 'tip'; document.body.appendChild(tip);
  let tipTimer = 0, tipHide = 0, tipShown = false;
  const hideTip = () => { clearTimeout(tipTimer); clearTimeout(tipHide); tip.classList.remove('on'); };
  // any new press hides the old tooltip; after the finger lifts it stays long enough to read (longer text, longer time)
  document.addEventListener('pointerdown', hideTip, true);
  document.addEventListener('pointerup', () => {
    clearTimeout(tipTimer);
    if (tip.classList.contains('on')) { clearTimeout(tipHide); tipHide = window.setTimeout(hideTip, Math.min(9000, Math.max(4000, 2800 + (tip.textContent ?? '').length * 60))); }
  }, true);
  document.addEventListener('pointercancel', () => clearTimeout(tipTimer), true);
  document.querySelectorAll<HTMLButtonElement>('#bar button').forEach(b => {
    b.addEventListener('pointerdown', () => {
      tipShown = false; clearTimeout(tipTimer);
      tipTimer = window.setTimeout(() => {
        tipShown = true; tip.textContent = b.id === 'eraseBtn' && app.toolId === 'select' && app.selection.size ? 'Delete selected strokes' : TIPS[b.id || b.dataset.tool || ''];
        const r = b.getBoundingClientRect(); tip.classList.add('on');
        const w = tip.offsetWidth;
        tip.style.left = Math.max(6, Math.min(window.innerWidth - w - 6, r.left + r.width / 2 - w / 2)) + 'px';
        tip.style.bottom = window.innerHeight - r.top + 8 + 'px';
      }, 450);
    });
    b.addEventListener('pointerleave', () => clearTimeout(tipTimer)); // finger slid off before the tooltip appeared
    b.addEventListener('contextmenu', e => e.preventDefault());
    // swallow the click that ends a long press
    b.addEventListener('click', e => { if (tipShown) { e.stopImmediatePropagation(); e.preventDefault(); tipShown = false; } }, true);
  });

  // ---- pull gestures: swipe up on the toolbar expands it; swipe down collapses it and closes the popups; a popup pulled down closes ----
  let pull: { id: number; x: number; y: number; done: boolean; fromBar: boolean } | null = null, swallowClick = false;
  document.addEventListener('pointerdown', e => {
    const t = e.target as HTMLElement, fromBar = !!t.closest('#bar');
    if (!fromBar && !t.closest('.pop')) { pull = null; return; }
    if (t.closest('input, #sv, .grip')) { pull = null; return; } // sliders, the color square and drag handles keep their own drags
    const sc = t.closest<HTMLElement>('#list, #llist, #igrid');
    if (sc && sc.scrollTop > 0) { pull = null; return; } // a scrolled list scrolls instead
    pull = { id: e.pointerId, x: e.clientX, y: e.clientY, done: false, fromBar };
  }, true);
  document.addEventListener('pointermove', e => {
    if (!pull || e.pointerId !== pull.id || pull.done) return;
    const dy = e.clientY - pull.y, dx = e.clientX - pull.x;
    if (Math.abs(dy) > 22 && Math.abs(dy) > 1.5 * Math.abs(dx)) {
      if (!pull.fromBar && dy < 0) return; // popups only react to being pulled down
      pull.done = true; swallowClick = true; hideTip(); // not a long-press or a tap
      if (pull.fromBar) setRow2(dy < 0); // pulling the toolbar down collapses it and closes the popups; up expands it
      else POPS.forEach(p => $(p).classList.add('off')); // a popup pulled down closes
    }
  }, true);
  // the finger may lift over the canvas once something has collapsed, so listen on the document
  for (const t of ['pointerup', 'pointercancel']) document.addEventListener(t, () => { pull = null; setTimeout(() => { swallowClick = false; }, 50); }, true);
  document.addEventListener('click', e => { if (swallowClick) { e.stopImmediatePropagation(); e.preventDefault(); swallowClick = false; } }, true);
  $('#grip').onclick = () => setRow2(row2.classList.contains('off')); // tapping the handle toggles too

  // ---- style popover ----
  // The swatches, picker and opacity slider edit the line. Tapping the Fill button makes them edit the fill for ONE choice:
  // the next color you pick, or the next opacity change (it ends when the finger lifts).
  let fillMode = false;
  const colorPatch = (c: string) => (fillMode ? { fill: c } : { color: c });
  const endFillMode = () => { if (fillMode) { fillMode = false; refresh(); } };
  const sw = $('#swatches');
  SWATCHES.forEach(c => { const b = document.createElement('b'); b.style.background = c; b.onclick = () => { app.setStyle(colorPatch(c), true); endFillMode(); }; sw.appendChild(b); });
  // recently used custom colors (persisted per device)
  const RECENT_N = 8, RKEY = 'recentColors';
  let recent: string[] = [];
  try { recent = (JSON.parse(localStorage.getItem(RKEY) || '[]') as string[]).filter(c => /^#[0-9a-f]{6}$/i.test(c)).slice(0, RECENT_N); } catch { /* ignore */ }
  const rec = $('#recent');
  const paintRecent = () => {
    rec.innerHTML = ''; rec.classList.toggle('off', !recent.length);
    recent.forEach(c => { const b = document.createElement('b'); b.style.background = c; b.onclick = () => { app.setStyle(colorPatch(c), true); endFillMode(); }; rec.appendChild(b); });
  };
  const remember = (c: string) => {
    c = c.toLowerCase();
    if (SWATCHES.includes(c) || recent[0] === c) return;
    recent = [c, ...recent.filter(x => x !== c)].slice(0, RECENT_N); paintRecent();
    try { localStorage.setItem(RKEY, JSON.stringify(recent)); } catch { /* ignore */ }
  };
  app.onColorUsed(remember); // only colors that were used on the canvas are remembered
  paintRecent();
  const more = document.createElement('b'); more.className = 'more'; more.title = 'More colors';
  more.onclick = () => $('#picker').classList.toggle('off'); sw.appendChild(more);

  // HSV color picker (saturation/value square + hue slider)
  let hsv = { h: 0, s: 0, v: 0 }, dragging = false;
  const sv = $('#sv'), svc = $('#svc'), hue = $<HTMLInputElement>('#hue'), width = $<HTMLInputElement>('#width');
  const hex = () => {
    const { h, s: sa, v } = hsv, f = (n: number) => { const k = (n + h / 60) % 6; return v - v * sa * Math.max(0, Math.min(k, 4 - k, 1)); };
    return '#' + [f(5), f(3), f(1)].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
  };
  const fromHex = (c: string) => {
    const r = parseInt(c.slice(1, 3), 16) / 255, g = parseInt(c.slice(3, 5), 16) / 255, b = parseInt(c.slice(5, 7), 16) / 255;
    const mx = Math.max(r, g, b), d = mx - Math.min(r, g, b);
    let h = d === 0 ? hsv.h : mx === r ? ((g - b) / d + 6) % 6 * 60 : mx === g ? ((b - r) / d + 2) * 60 : ((r - g) / d + 4) * 60;
    hsv = { h, s: mx ? d / mx : 0, v: mx };
  };
  const paintPicker = () => {
    sv.style.setProperty('--h', String(hsv.h));
    svc.style.left = hsv.s * 100 + '%'; svc.style.top = (1 - hsv.v) * 100 + '%';
    hue.value = String(Math.round(hsv.h));
  };
  const pick = (commit: boolean) => { paintPicker(); app.setStyle(colorPatch(hex()), commit); if (commit) endFillMode(); };
  const svMove = (e: PointerEvent) => {
    const r = sv.getBoundingClientRect();
    hsv.s = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); hsv.v = 1 - Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    pick(false);
  };
  sv.addEventListener('pointerdown', e => { dragging = true; sv.setPointerCapture(e.pointerId); svMove(e); });
  sv.addEventListener('pointermove', e => { if (dragging) svMove(e); });
  sv.addEventListener('pointerup', () => { if (dragging) { dragging = false; pick(true); } });
  sv.addEventListener('pointercancel', () => { dragging = false; });
  hue.oninput = () => { hsv.h = +hue.value; pick(false); };
  hue.onchange = () => pick(true);
  // The thickness and opacity sliders snap to coarse steps. Moving the finger away from the slider gives finer steps,
  // like scrubbing in a video player: thickness 5 -> fine, opacity 20 -> 10 -> 5 -> fine.
  const snapHint = $('#snapHint'), HINT_IDLE = snapHint.textContent ?? '';
  function snappySlider(input: HTMLInputElement, level: (distPx: number) => { step: number; label: string }, min: (step: number) => number, onRelease?: () => void) {
    let cy = 0, dist = 0, sliding = false, startVal = 0, nativeChange = false;
    const show = () => { snapHint.textContent = level(dist).label; snapHint.classList.add('live'); };
    input.addEventListener('pointerdown', e => {
      const r = input.getBoundingClientRect(); cy = r.top + r.height / 2; sliding = true; dist = Math.abs(e.clientY - cy);
      startVal = +input.value; nativeChange = false; show();
    });
    input.addEventListener('change', () => { nativeChange = true; });
    document.addEventListener('pointermove', e => {
      if (!sliding) return;
      dist = Math.abs(e.clientY - cy); show();
      // Follow the finger ourselves as well: a touch stops moving the browser's slider once the finger leaves it vertically,
      // but fine control needs exactly that.
      const r = input.getBoundingClientRect(), mn = +input.min, mx = +input.max, st = +input.step || 1;
      const v = Math.round((mn + Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * (mx - mn)) / st) * st;
      if (v !== +input.value) { input.value = String(v); input.dispatchEvent(new Event('input')); }
    }, true);
    // The browser still reports a value (input/change) as the finger lifts. Keep snapping with the last distance until
    // that has been processed, otherwise the value jumps to the unsnapped position on release.
    const end = () => {
      if (!sliding) return;
      window.setTimeout(() => {
        if (!nativeChange && +input.value !== startVal) input.dispatchEvent(new Event('change')); // the browser did not commit (finger was off the slider)
        sliding = false; snapHint.textContent = HINT_IDLE; snapHint.classList.remove('live'); onRelease?.();
      }, 80);
    };
    document.addEventListener('pointerup', end, true); document.addEventListener('pointercancel', end, true);
    return (raw: number) => { if (!sliding) return raw; const { step } = level(dist); return Math.max(min(step), Math.round(raw / step) * step); };
  }
  const widthSnap = snappySlider(width, d => (d < 60 ? { step: 5, label: 'Step 5 · drag away from the slider for finer steps' } : { step: 0.5, label: 'Fine steps' }), () => 0.5);
  width.oninput = () => { width.value = String(widthSnap(+width.value)); app.setStyle({ width: +width.value }, false); $('#wval').textContent = (+width.value).toFixed(1); };
  width.onchange = () => { width.value = String(widthSnap(+width.value)); app.setStyle({ width: +width.value }, true); $('#wval').textContent = (+width.value).toFixed(1); };
  const alpha = $<HTMLInputElement>('#alpha');
  const alphaSnap = snappySlider(alpha, d => (d < 44 ? { step: 20, label: 'Step 20% · drag away from the slider for finer steps' } : d < 88 ? { step: 10, label: 'Step 10%' } : d < 132 ? { step: 5, label: 'Step 5%' } : { step: 1, label: 'Fine steps' }), step => step, endFillMode);
  const alphaPatch = () => (fillMode ? { fillAlpha: +alpha.value / 100 } : { alpha: +alpha.value / 100 });
  alpha.oninput = () => { alpha.value = String(alphaSnap(+alpha.value)); app.setStyle(alphaPatch(), false); $('#aval').textContent = alpha.value + '%'; };
  alpha.onchange = () => { alpha.value = String(alphaSnap(+alpha.value)); app.setStyle(alphaPatch(), true); $('#aval').textContent = alpha.value + '%'; };
  const rgba = (c: string, a: number) => `rgba(${parseInt(c.slice(1, 3), 16)},${parseInt(c.slice(3, 5), 16)},${parseInt(c.slice(5, 7), 16)},${a})`;

  // ---- layers popup ----
  const llist = $('#llist');
  let sliding = false; // a slider or reorder drag is in progress: don't rebuild the list under it
  // ---- image gallery ----
  const igrid = $('#igrid'), fileIn = $<HTMLInputElement>('#file');
  async function renderGallery() {
    const list = await listGallery();
    igrid.innerHTML = '';
    if (!list.length) { igrid.innerHTML = '<div class="empty">No images yet. Upload some.</div>'; return; }
    for (const e of list) {
      const cell = document.createElement('div'); cell.className = 'ithumb';
      const img = document.createElement('img'); img.src = e.thumb; img.alt = e.name; cell.appendChild(img);
      const del = document.createElement('button'); del.textContent = '✕'; del.title = 'Remove from gallery';
      del.onclick = async ev => {
        ev.stopPropagation();
        await app.flush();
        await removeGalleryEntry(e.id);
        // keep the picture if a drawing (or its undo history) still uses it
        if (!(await imageStillUsed(e.id))) { await deleteImageBlob(e.id); forget(e.id); }
        renderGallery();
      };
      cell.appendChild(del);
      cell.onclick = async () => { $('#images').classList.add('off'); await app.addImage(e); };
      igrid.appendChild(cell);
    }
  }
  $('#upload').onclick = () => fileIn.click();
  fileIn.onchange = async () => {
    const files = [...(fileIn.files ?? [])]; fileIn.value = '';
    for (const f of files) {
      try {
        const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
        const { blob, iw, ih, thumb } = await decodeFile(f, id);
        await putImage({ id, name: f.name, iw, ih, thumb, createdAt: Date.now() }, blob);
      } catch { alert('Could not read ' + f.name + ' as an image.'); }
    }
    renderGallery();
  };

  let swallow = false; // the click that ends a long-press rename must not also select the layer

  /** Drag a layer row by its handle; neighbours swap places as the row passes their middle. One undo step on release. */
  function startDrag(e: PointerEvent, row: HTMLElement, grip: HTMLElement) {
    e.preventDefault(); sliding = true;
    grip.setPointerCapture(e.pointerId);
    row.classList.add('drag');
    let startY = e.clientY;
    const move = (ev: PointerEvent) => {
      row.style.transform = `translateY(${ev.clientY - startY}px)`;
      for (;;) {
        const c = row.getBoundingClientRect(), mid = c.top + c.height / 2;
        const prev = row.previousElementSibling as HTMLElement | null, next = row.nextElementSibling as HTMLElement | null;
        const pr = prev?.getBoundingClientRect(), nr = next?.getBoundingClientRect();
        const before = row.offsetTop;
        if (nr && mid > nr.top + nr.height / 2) llist.insertBefore(next!, row);
        else if (pr && mid < pr.top + pr.height / 2) llist.insertBefore(row, prev!);
        else break;
        startY += row.offsetTop - before; // keep the row under the finger after its layout slot changed
        row.style.transform = `translateY(${ev.clientY - startY}px)`;
      }
    };
    const end = (ev: PointerEvent) => {
      grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', end); grip.removeEventListener('pointercancel', end);
      sliding = false;
      row.style.transform = ''; row.classList.remove('drag');
      const topFirst = [...llist.children].map(r => (r as HTMLElement).dataset.id!);
      if (ev.type === 'pointerup') app.setLayerOrder(topFirst.reverse());
      renderLayers();
    };
    grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', end); grip.addEventListener('pointercancel', end);
  }

  // Layer thumbnails: all layers show the same area (the bounds of everything drawn), so they line up.
  let thumbJobs: { canvas: HTMLCanvasElement; objs: Obj[] }[] = [], thumbBox: BB | null = null, thumbTimer = 0;
  const drawThumbs = () => { if (thumbBox) for (const j of thumbJobs) if (j.canvas.isConnected) drawLayerThumb(j.canvas, j.objs, thumbBox); };

  function renderLayers() {
    if ($('#layers').classList.contains('off')) return;
    if (sliding) return; // don't rebuild under a dragged slider
    llist.innerHTML = '';
    const ls = app.store.layers, groups = groupByLayer(app.store.strokes.values(), ls);
    thumbBox = bounds([...app.store.strokes.values()], 12); thumbJobs = [];
    [...ls].reverse().forEach((l: Layer) => {
      const row = document.createElement('div');
      row.className = 'lrow' + (l.id === app.activeLayer ? ' cur' : '') + (l.visible ? '' : ' hid');
      row.dataset.id = l.id;
      const mk = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement) => { const e = document.createElement(tag); e.className = cls; parent.appendChild(e); return e; };
      const btn = (parent: HTMLElement, txt: string, fn: () => void, dis = false, cls = '') => {
        const b = mk('button', cls, parent); b.textContent = txt; b.disabled = dis; b.onclick = fn; return b;
      };
      // the thumbnail is the show/hide button (hidden layers: the whole card looks deactivated)
      const tb = btn(row, '', () => app.toggleLayerVisible(l.id), false, 'lthumb');
      tb.title = l.visible ? 'Layer is visible: tap to hide it' : 'Layer is hidden: tap to show it';
      const th = mk('canvas', '', tb); th.width = 128; th.height = 128;
      mk('span', 'vis', tb).textContent = l.visible ? '👁' : '🚫';
      thumbJobs.push({ canvas: th, objs: groups.get(l.id) ?? [] });
      const body = mk('div', 'lbody', row);
      const nm = btn(body, l.name, () => { if (swallow) { swallow = false; return; } app.setActiveLayer(l.id); }, false, 'nm');
      // hold (or double-click) the name to rename
      const rename = () => {
        const v = prompt('Layer name', l.name);
        if (v !== null) app.renameLayer(l.id, v);
      };
      let hold = 0, sx = 0, sy = 0;
      nm.addEventListener('pointerdown', e => {
        swallow = false; sx = e.clientX; sy = e.clientY; clearTimeout(hold);
        hold = window.setTimeout(() => { swallow = true; rename(); }, 500);
      });
      nm.addEventListener('pointermove', e => { if (Math.hypot(e.clientX - sx, e.clientY - sy) > 8) clearTimeout(hold); });
      for (const t of ['pointerup', 'pointercancel', 'pointerleave']) nm.addEventListener(t, () => clearTimeout(hold));
      nm.addEventListener('dblclick', rename);
      nm.addEventListener('contextmenu', e => e.preventDefault());
      const ctl = mk('div', 'lctl', body);
      const r = mk('input', '', ctl); r.type = 'range'; r.min = '0'; r.max = '100'; r.value = String(Math.round(l.opacity * 100)); r.title = 'Layer opacity';
      r.oninput = () => app.layerOpacityLive(l.id, +r.value / 100);
      r.onpointerdown = () => { sliding = true; };
      r.onchange = () => { sliding = false; app.commitLayerOpacity(); };
      r.onpointerup = () => { sliding = false; };
      // this layer's remembered pen style; tapping it copies the style to the active layer (and the pen)
      const st = app.layerStyles[l.id] ?? app.pen;
      const col = mk('div', 'lcol', row); // delete on top, style below
      btn(col, '🗑', () => app.removeLayer(l.id), ls.length <= 1, 'ldel');
      const sw = btn(col, '', () => app.copyLayerStyle(l.id), l.id === app.activeLayer, 'lstyle');
      // line color as the ring, fill color (if any) inside
      sw.innerHTML = st.fill ? `<u style="background:${rgba(st.fill, st.fillAlpha ?? 1)};border-color:${rgba(st.color, st.alpha)}"></u>` : `<u style="background:${rgba(st.color, st.alpha)}"></u>`;
      sw.title = `Layer style: line ${Math.round(st.alpha * 100)}% opacity, width ${st.width.toFixed(1)}, ${DASH_NAMES[st.dash]}${st.fill ? `, fill ${Math.round((st.fillAlpha ?? 1) * 100)}%` : ', no fill'}. Tap to use it on the active layer`;
      const grip = btn(row, '☰', () => {}, ls.length <= 1, 'grip');
      grip.addEventListener('pointerdown', e => startDrag(e, row, grip));
      llist.appendChild(row);
    });
    clearTimeout(thumbTimer); thumbTimer = window.setTimeout(drawThumbs, 30); // after the rebuild, and coalesced when updates come in quickly
  }
  $('#addLayer').onclick = () => app.addLayer();

  $('#noFill').onclick = () => { fillMode = false; app.setStyle({ fill: null }, true); refresh(); };
  $('#fillBtn').onclick = () => { if (app.fillAvailable()) { fillMode = !fillMode; refresh(); } };
  // line style (solid, dashed, dotted, ...)
  const DASH_NAMES: Record<DashKind, string> = { solid: 'Solid', dashed: 'Dashed', dotted: 'Dotted', dashdot: 'Dash-dot', longdash: 'Long dash' };
  const dashes = $('#dashes');
  for (const k of DASH_KINDS) {
    const b = document.createElement('button'); b.dataset.dash = k; b.title = DASH_NAMES[k];
    b.innerHTML = `<svg viewBox="0 0 60 12"><line x1="6" y1="6" x2="54" y2="6" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-dasharray="${dashPattern(k, 3).join(' ')}"/></svg>`;
    b.onclick = () => app.setStyle({ dash: k }, true);
    dashes.appendChild(b);
  }
  const WL = ['off', 'V', 'H', 'V+H'];
  const refresh = () => {
    document.querySelectorAll<HTMLButtonElement>('#bar button').forEach(b => b.classList.remove('active'));
    const act = app.toolId === 'select' ? $('#selBtn') : app.toolId === 'shapes' ? document.querySelector(`[data-shape=${app.shapeKind}]`)! : document.querySelector(`[data-tool=${app.toolId}]`)!;
    act.classList.add('active');
    $<HTMLButtonElement>('#undo').disabled = !app.canUndo;
    $<HTMLButtonElement>('#redo').disabled = !app.canRedo;
    $('#wrapLbl').textContent = 'Wrap ' + WL[(app.wrap.x ? 1 : 0) + (app.wrap.y ? 2 : 0)];
    const del = app.toolId === 'select' && app.selection.size > 0;
    $('#eraseIcon').textContent = del ? '🗑️' : '🧽'; $('#eraseLbl').textContent = del ? 'Delete' : 'Erase';
    const st = app.styleView();
    $('#dot').style.background = rgba(st.color, st.alpha);
    const canFill = app.fillAvailable();
    if (!canFill) fillMode = false;
    const editing = fillMode ? { color: st.fill ?? st.color, alpha: st.fillAlpha ?? 1 } : { color: st.color, alpha: st.alpha };
    $('#fillSw').style.setProperty('--fc', st.fill ? rgba(st.fill, st.fillAlpha ?? 1) : 'transparent');
    const fb = $<HTMLButtonElement>('#fillBtn'), nf = $<HTMLButtonElement>('#noFill');
    fb.disabled = nf.disabled = !canFill;
    fb.classList.toggle('on', fillMode); fb.classList.toggle('set', !fillMode && !!st.fill && canFill); nf.classList.toggle('set', !st.fill && canFill);
    $('#fillHint').style.display = canFill ? 'none' : '';
    $('#widthRow').classList.toggle('dim', fillMode); $('#styleRow').classList.toggle('dim', fillMode); // width and line style don't apply to the fill
    $('#alpha').style.setProperty('--c', editing.color);
    if (document.activeElement !== alpha) alpha.value = String(Math.round(editing.alpha * 100));
    $('#aval').textContent = Math.round(editing.alpha * 100) + '%';
    if (!dragging && editing.color.toLowerCase() !== hex()) { fromHex(editing.color); paintPicker(); }
    if (document.activeElement !== width) { width.value = String(st.width); }
    $('#wval').textContent = st.width.toFixed(1);
    $('#north').classList.toggle('unlocked', !app.rotLocked);
    $('#rotIcon').textContent = app.rotLocked ? '🔒' : '🧭';
    $('#rotLbl').textContent = 'Rot ' + (app.heading() ?? '–');
    $('#gridBtn').classList.toggle('toggled', app.grid);
    $('#polyLbl').textContent = app.selectedPolygon() || app.isEditingPolygon() ? 'Edit' : 'Polygon';
    $('#wrapBtn').classList.toggle('toggled', app.wrap.x || app.wrap.y);
    const hasSel = app.toolId === 'select' && app.selection.size > 0;
    $<HTMLButtonElement>('#cutBtn').disabled = !hasSel; $<HTMLButtonElement>('#copyBtn').disabled = !hasSel;
    $<HTMLButtonElement>('#pasteBtn').disabled = !app.clipboard.length;
    document.querySelectorAll<HTMLButtonElement>('#dashes button').forEach(b => b.classList.toggle('on', b.dataset.dash === (app.styleView().dash ?? 'solid')));
    renderLayers();
  };
  app.onNotify(refresh); refresh();

  // ---- gallery ----
  const fmt = (t: number) => new Date(t).toLocaleString();
  const gal = $('#gal');
  async function renderFiles() {
    await app.flush();
    const list = $('#list'); list.innerHTML = '';
    for (const m of await listMetas()) {
      const card = document.createElement('div');
      card.className = 'card' + (m.id === app.doc.id ? ' cur' : '');
      card.innerHTML = `<img alt=""><div class="meta"><b></b><span>Edited ${fmt(m.updatedAt)}</span><span>Created ${fmt(m.createdAt)}</span>
        <div class="btns"><button data-k="png">PNG</button><button data-k="jpg">JPG</button><button data-k="svg">SVG</button><button data-k="del">🗑</button></div></div>`;
      card.querySelector('img')!.src = m.thumb;
      card.querySelector('b')!.textContent = m.name;
      card.onclick = async e => {
        const k = (e.target as HTMLElement).dataset.k;
        if (!k) { await app.openDoc(m.id); gal.classList.add('off'); return; }
        e.stopPropagation();
        if (k === 'del') {
          if (!confirm('Delete this drawing?')) return;
          await deleteDoc(m.id);
          if (m.id === app.doc.id) { app.doc.id = ''; app.newDoc(); }
          return renderFiles();
        }
        const d = await loadDoc(m.id); if (!d) return;
        const base = m.name.replace(/[^\w-]+/g, '_');
        if (k === 'svg') download(new Blob([await toSVG(d.strokes, d.layers ?? defaultLayers())], { type: 'image/svg+xml' }), base + '.svg');
        else download(await toBlob(d.strokes, d.layers ?? defaultLayers(), k === 'png' ? 'image/png' : 'image/jpeg'), base + '.' + k);
      };
      list.appendChild(card);
    }
  }
  $('#appver').textContent = 'Endloszeichnung ' + (__APP_VERSION__ === 'dev' ? 'dev build' : 'v' + __APP_VERSION__);
  $('#files').onclick = () => { if (!togglePop('#gal')) renderFiles(); };
  $('#newDoc').onclick = async () => { app.endToolSession(); await app.flush(); app.newDoc(); gal.classList.add('off'); };

  return { activity };
}
