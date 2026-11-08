import type { App } from './app';
import type { ToolId } from './tools/tool';
import { deleteDoc, deleteImageBlob, imageStillUsed, listGallery, listMetas, loadDoc, putImage, removeGalleryEntry } from './persist';
import { decodeFile, forget } from './images';
import { download, toBlob, toSVG } from './exporter';
import { DASH_KINDS, DashKind, Layer, defaultLayers } from './types';
import { dashPattern } from './geom';
import type { ShapeKind } from './tools/shapes';

const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;
const SWATCHES = ['#1a1a1a', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#8e24aa', '#ffffff'];

export function setupUI(app: App) {
  const POPS = ['#style', '#layers', '#images'];
  const togglePop = (id: string) => { POPS.forEach(p => { if (p !== id) $(p).classList.add('off'); }); return $(id).classList.toggle('off'); };
  // ---- auto-hide: hide on any canvas interaction, return after 0.3s idle ----
  let timer = 0, held = 0;
  const show = () => { if (held > 0) return schedule(); document.body.classList.remove('ui-hidden'); };
  const schedule = () => { clearTimeout(timer); timer = window.setTimeout(show, 300); };
  const activity = () => { document.body.classList.add('ui-hidden'); POPS.forEach(p => $(p).classList.add('off')); schedule(); };

  // ---- toolbar ----
  document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach(b => b.onclick = () => {
    // while something is selected the erase button becomes "delete selected"
    if (b.dataset.tool === 'erase' && app.toolId === 'select' && app.selection.size) app.deleteSelection();
    else app.setTool(b.dataset.tool as ToolId);
  });
  $('#selBtn').onclick = () => app.selectButton();
  $('#wrapBtn').onclick = () => app.wrapButton();
  $('#gridBtn').onclick = () => app.toggleGrid();
  document.querySelectorAll<HTMLButtonElement>('[data-shape]').forEach(b => b.onclick = () => app.shapeButton(b.dataset.shape as ShapeKind));
  $('#cutBtn').onclick = () => app.cutSelection();
  $('#copyBtn').onclick = () => app.copySelection();
  $('#pasteBtn').onclick = () => app.pasteClipboard();
  $('#undo').onclick = () => app.store.undo();
  $('#redo').onclick = () => app.store.redo();
  $('#north').onclick = () => app.unlockRotation();
  $('#styleBtn').onclick = () => { togglePop('#style'); };
  $('#layersBtn').onclick = () => { togglePop('#layers'); renderLayers(); };
  $('#imagesBtn').onclick = () => { if (!togglePop('#images')) renderGallery(); };

  // ---- second and third toolbar rows, toggled together (persisted per device) ----
  const row2 = $('#row2'), bar = $('#bar');
  const setRow2 = (open: boolean) => {
    row2.classList.toggle('off', !open); $('#row3').classList.toggle('off', !open);
    try { localStorage.setItem('bar2', open ? '1' : '0'); } catch { /* ignore */ }
  };
  let open2 = false; try { open2 = localStorage.getItem('bar2') === '1'; } catch { /* ignore */ }
  setRow2(open2);
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
  let tipTimer = 0, tipShown = false;
  document.querySelectorAll<HTMLButtonElement>('#bar button').forEach(b => {
    const hide = () => { clearTimeout(tipTimer); tip.classList.remove('on'); };
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
    for (const t of ['pointerup', 'pointercancel', 'pointerleave']) b.addEventListener(t, () => setTimeout(hide, t === 'pointerup' ? 900 : 0));
    b.addEventListener('contextmenu', e => e.preventDefault());
    // swallow the click that ends a long press
    b.addEventListener('click', e => { if (tipShown) { e.stopImmediatePropagation(); e.preventDefault(); tipShown = false; } }, true);
  });

  // ---- pull the toolbar up / down to show / hide the extra rows ----
  let pull: { id: number; x: number; y: number; done: boolean } | null = null, swallowClick = false;
  bar.addEventListener('pointerdown', e => { pull = { id: e.pointerId, x: e.clientX, y: e.clientY, done: false }; });
  bar.addEventListener('pointermove', e => {
    if (!pull || e.pointerId !== pull.id || pull.done) return;
    const dy = e.clientY - pull.y, dx = e.clientX - pull.x;
    if (Math.abs(dy) > 22 && Math.abs(dy) > 1.5 * Math.abs(dx)) {
      pull.done = true; swallowClick = true; clearTimeout(tipTimer); tip.classList.remove('on'); // not a long-press or a tap
      setRow2(dy < 0);
    }
  });
  // the finger may lift over the canvas once the rows have collapsed, so listen on the document
  for (const t of ['pointerup', 'pointercancel']) document.addEventListener(t, () => { pull = null; setTimeout(() => { swallowClick = false; }, 50); }, true);
  bar.addEventListener('click', e => { if (swallowClick) { e.stopImmediatePropagation(); e.preventDefault(); swallowClick = false; } }, true);
  $('#grip').onclick = () => setRow2(row2.classList.contains('off')); // tapping the handle toggles too

  // ---- style popover ----
  // the color swatches, picker and opacity slider edit either the line or the fill
  let target: 'line' | 'fill' = 'line';
  const colorPatch = (c: string) => (target === 'fill' ? { fill: c } : { color: c });
  const sw = $('#swatches');
  SWATCHES.forEach(c => { const b = document.createElement('b'); b.style.background = c; b.onclick = () => app.setStyle(colorPatch(c), true); sw.appendChild(b); });
  // recently used custom colors (persisted per device)
  const RECENT_N = 8, RKEY = 'recentColors';
  let recent: string[] = [];
  try { recent = (JSON.parse(localStorage.getItem(RKEY) || '[]') as string[]).filter(c => /^#[0-9a-f]{6}$/i.test(c)).slice(0, RECENT_N); } catch { /* ignore */ }
  const rec = $('#recent');
  const paintRecent = () => {
    rec.innerHTML = ''; rec.classList.toggle('off', !recent.length);
    recent.forEach(c => { const b = document.createElement('b'); b.style.background = c; b.onclick = () => app.setStyle(colorPatch(c), true); rec.appendChild(b); });
  };
  const remember = (c: string) => {
    c = c.toLowerCase();
    if (SWATCHES.includes(c) || recent[0] === c) return;
    recent = [c, ...recent.filter(x => x !== c)].slice(0, RECENT_N); paintRecent();
    try { localStorage.setItem(RKEY, JSON.stringify(recent)); } catch { /* ignore */ }
  };
  let rememberTimer = 0; // a color counts once the user stops fiddling for a moment
  const rememberSoon = (c: string) => { clearTimeout(rememberTimer); rememberTimer = window.setTimeout(() => remember(c), 1200); };
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
  const pick = (commit: boolean) => { paintPicker(); app.setStyle(colorPatch(hex()), commit); if (commit) rememberSoon(hex()); };
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
  width.oninput = () => { app.setStyle({ width: +width.value }, false); $('#wval').textContent = (+width.value).toFixed(1); };
  width.onchange = () => app.setStyle({ width: +width.value }, true);
  const alpha = $<HTMLInputElement>('#alpha');
  const alphaPatch = () => (target === 'fill' ? { fillAlpha: +alpha.value / 100 } : { alpha: +alpha.value / 100 });
  alpha.oninput = () => { app.setStyle(alphaPatch(), false); $('#aval').textContent = alpha.value + '%'; };
  alpha.onchange = () => app.setStyle(alphaPatch(), true);
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

  function renderLayers() {
    if ($('#layers').classList.contains('off')) return;
    if (sliding) return; // don't rebuild under a dragged slider
    llist.innerHTML = '';
    const ls = app.store.layers;
    [...ls].reverse().forEach((l: Layer) => {
      const i = ls.indexOf(l), row = document.createElement('div');
      row.className = 'lrow' + (l.id === app.activeLayer ? ' cur' : '') + (l.visible ? '' : ' hid');
      const btn = (txt: string, fn: () => void, dis = false, cls = '') => {
        const b = document.createElement('button'); b.textContent = txt; b.className = cls; b.disabled = dis; b.onclick = fn; row.appendChild(b); return b;
      };
      btn(l.visible ? '👁' : '🚫', () => app.toggleLayerVisible(l.id));
      const nm = btn(l.name, () => { if (swallow) { swallow = false; return; } app.setActiveLayer(l.id); }, false, 'nm');
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
      const r = document.createElement('input'); r.type = 'range'; r.min = '0'; r.max = '100'; r.value = String(Math.round(l.opacity * 100)); r.title = 'Layer opacity';
      r.oninput = () => app.layerOpacityLive(l.id, +r.value / 100);
      r.onpointerdown = () => { sliding = true; };
      r.onchange = () => { sliding = false; app.commitLayerOpacity(); };
      r.onpointerup = () => { sliding = false; };
      row.appendChild(r);
      // this layer's remembered pen style; tapping it copies the style to the active layer (and the pen)
      const st = app.layerStyles[l.id] ?? app.pen;
      const sw = btn('', () => app.copyLayerStyle(l.id), l.id === app.activeLayer, 'lstyle');
      // line color as the ring, fill color (if any) inside
      sw.innerHTML = st.fill ? `<u style="background:${rgba(st.fill, st.fillAlpha ?? 1)};border-color:${rgba(st.color, st.alpha)}"></u>` : `<u style="background:${rgba(st.color, st.alpha)}"></u>`;
      sw.title = `Layer style: line ${Math.round(st.alpha * 100)}% opacity, width ${st.width.toFixed(1)}, ${DASH_NAMES[st.dash]}${st.fill ? `, fill ${Math.round((st.fillAlpha ?? 1) * 100)}%` : ', no fill'}. Tap to use it on the active layer`;
      btn('🗑', () => app.removeLayer(l.id), ls.length <= 1);
      const grip = btn('☰', () => {}, ls.length <= 1, 'grip');
      row.dataset.id = l.id;
      grip.addEventListener('pointerdown', e => startDrag(e, row, grip));
      llist.appendChild(row);
    });
  }
  $('#addLayer').onclick = () => app.addLayer();

  document.querySelectorAll<HTMLButtonElement>('#target button').forEach(b => { b.onclick = () => { target = b.dataset.target as 'line' | 'fill'; refresh(); }; });
  $('#noFill').onclick = () => app.setStyle({ fill: null }, true);
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
    $<HTMLButtonElement>('#undo').disabled = !app.store.canUndo;
    $<HTMLButtonElement>('#redo').disabled = !app.store.canRedo;
    $('#wrapLbl').textContent = 'Wrap ' + WL[(app.wrap.x ? 1 : 0) + (app.wrap.y ? 2 : 0)];
    const del = app.toolId === 'select' && app.selection.size > 0;
    $('#eraseIcon').textContent = del ? '🗑️' : '🧽'; $('#eraseLbl').textContent = del ? 'Delete' : 'Erase';
    const st = app.styleView();
    $('#dot').style.background = rgba(st.color, st.alpha);
    const canFill = app.fillAvailable();
    if (!canFill && target === 'fill') target = 'line';
    const editing = target === 'fill' ? { color: st.fill ?? st.color, alpha: st.fillAlpha ?? 1 } : { color: st.color, alpha: st.alpha };
    $('#fillSw').style.setProperty('--fc', st.fill ? rgba(st.fill, st.fillAlpha ?? 1) : 'transparent');
    document.querySelectorAll<HTMLButtonElement>('#target button').forEach(b => {
      b.classList.toggle('on', b.dataset.target === target);
      if (b.dataset.target === 'fill') b.disabled = !canFill;
    });
    $('#fillHint').style.display = canFill ? 'none' : '';
    document.querySelectorAll('.line-only').forEach(e => e.classList.toggle('hide', target === 'fill'));
    $('#nofillRow').classList.toggle('hide', target !== 'fill');
    $('#noFill').classList.toggle('on', !st.fill);
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
  async function openGallery() {
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
          return openGallery();
        }
        const d = await loadDoc(m.id); if (!d) return;
        const base = m.name.replace(/[^\w-]+/g, '_');
        if (k === 'svg') download(new Blob([await toSVG(d.strokes, d.layers ?? defaultLayers())], { type: 'image/svg+xml' }), base + '.svg');
        else download(await toBlob(d.strokes, d.layers ?? defaultLayers(), k === 'png' ? 'image/png' : 'image/jpeg'), base + '.' + k);
      };
      list.appendChild(card);
    }
    gal.classList.remove('off');
  }
  $('#files').onclick = openGallery;
  $('#closeGal').onclick = () => gal.classList.add('off');
  $('#newDoc').onclick = async () => { app.endToolSession(); await app.flush(); app.newDoc(); gal.classList.add('off'); };

  return { activity };
}
