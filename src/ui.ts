import type { App } from './app';
import type { ToolId } from './tools/tool';
import { deleteDoc, listMetas, loadDoc } from './persist';
import { download, toBlob, toSVG } from './exporter';

const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;
const SWATCHES = ['#1a1a1a', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#8e24aa', '#ffffff'];

export function setupUI(app: App) {
  // ---- auto-hide: hide on any canvas interaction, return after 0.3s idle ----
  let timer = 0, held = 0;
  const show = () => { if (held > 0) return schedule(); document.body.classList.remove('ui-hidden'); };
  const schedule = () => { clearTimeout(timer); timer = window.setTimeout(show, 300); };
  const activity = () => { document.body.classList.add('ui-hidden'); $('#style').classList.add('off'); schedule(); };

  // ---- toolbar ----
  document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach(b => b.onclick = () => {
    // while something is selected the erase button becomes "delete selected"
    if (b.dataset.tool === 'erase' && app.toolId === 'select' && app.selection.size) app.deleteSelection();
    else app.setTool(b.dataset.tool as ToolId);
  });
  $('#selBtn').onclick = () => app.selectButton();
  $('#wrapBtn').onclick = () => app.wrapButton();
  $('#undo').onclick = () => app.store.undo();
  $('#redo').onclick = () => app.store.redo();
  $('#north').onclick = () => app.unlockRotation();
  $('#styleBtn').onclick = () => $('#style').classList.toggle('off');

  // ---- long-press tooltips ----
  const TIPS: Record<string, string> = {
    pen: 'Pen: draw', eraseBtn: 'Eraser: cuts strokes', selBtn: 'Lasso select (tap again: clear selection)',
    wrapBtn: 'Wrap: tap to activate, tap again to cycle none / vertical / horizontal / both',
    styleBtn: 'Color and thickness', undo: 'Undo', redo: 'Redo', north: 'Turn view to the next compass direction (N, E, S, W) and unlock rotating for 1s; rotation is locked otherwise', files: 'Drawings: switch, export',
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

  // ---- style popover ----
  const sw = $('#swatches');
  SWATCHES.forEach(c => { const b = document.createElement('b'); b.style.background = c; b.onclick = () => app.setStyle({ color: c }, true); sw.appendChild(b); });
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
  const pick = (commit: boolean) => { paintPicker(); app.setStyle({ color: hex() }, commit); };
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

  const WL = ['off', 'V', 'H', 'V+H'];
  const refresh = () => {
    document.querySelectorAll<HTMLButtonElement>('#bar button').forEach(b => b.classList.remove('active'));
    const act = app.toolId === 'select' ? $('#selBtn') : app.toolId === 'wrap' ? $('#wrapBtn') : document.querySelector(`[data-tool=${app.toolId}]`)!;
    act.classList.add('active');
    $<HTMLButtonElement>('#undo').disabled = !app.store.canUndo;
    $<HTMLButtonElement>('#redo').disabled = !app.store.canRedo;
    $('#wrapLbl').textContent = 'Wrap ' + WL[(app.wrap.x ? 1 : 0) + (app.wrap.y ? 2 : 0)];
    const del = app.toolId === 'select' && app.selection.size > 0;
    $('#eraseIcon').textContent = del ? '🗑️' : '🧽'; $('#eraseLbl').textContent = del ? 'Delete' : 'Erase';
    const st = app.styleView();
    $('#dot').style.background = st.color;
    if (!dragging && st.color.toLowerCase() !== hex()) { fromHex(st.color); paintPicker(); }
    if (document.activeElement !== width) { width.value = String(st.width); }
    $('#wval').textContent = st.width.toFixed(1);
    $('#north').classList.toggle('unlocked', !app.rotLocked);
    $('#rotIcon').textContent = app.rotLocked ? '🔒' : '🧭';
    $('#rotLbl').textContent = 'Rot ' + (app.heading() ?? '–');
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
        if (k === 'svg') download(new Blob([toSVG(d.strokes)], { type: 'image/svg+xml' }), base + '.svg');
        else download(await toBlob(d.strokes, k === 'png' ? 'image/png' : 'image/jpeg'), base + '.' + k);
      };
      list.appendChild(card);
    }
    gal.classList.remove('off');
  }
  $('#files').onclick = openGallery;
  $('#closeGal').onclick = () => gal.classList.add('off');
  $('#newDoc').onclick = async () => { await app.flush(); app.newDoc(); gal.classList.add('off'); };

  return { activity };
}
