import type { App } from './app';
import type { ToolId } from './tools/tool';
import { deleteDoc, listMetas, loadDoc } from './persist';
import { download, toBlob, toSVG } from './exporter';

const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;
const SWATCHES = ['#1a1a1a', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#8e24aa', '#ffffff'];

export function setupUI(app: App) {
  // ---- auto-hide: hide on any canvas interaction, return after 0.6s idle ----
  let timer = 0, held = 0;
  const show = () => { if (held > 0) return schedule(); document.body.classList.remove('ui-hidden'); };
  const schedule = () => { clearTimeout(timer); timer = window.setTimeout(show, 600); };
  const activity = () => { document.body.classList.add('ui-hidden'); $('#style').classList.add('off'); schedule(); };

  // ---- toolbar ----
  document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach(b => b.onclick = () => app.setTool(b.dataset.tool as ToolId));
  $('#selBtn').onclick = () => app.selectButton();
  $('#wrapBtn').onclick = () => app.wrapButton();
  $('#undo').onclick = () => app.store.undo();
  $('#redo').onclick = () => app.store.redo();
  $('#north').onclick = () => { app.view.cam.rot = 0; app.cameraChanged(); };
  $('#styleBtn').onclick = () => $('#style').classList.toggle('off');

  // ---- long-press tooltips ----
  const TIPS: Record<string, string> = {
    pen: 'Pen: draw', erase: 'Eraser: cuts strokes', selBtn: 'Lasso select (tap again: clear selection)',
    wrapBtn: 'Wrap: tap to activate, tap again to cycle none / vertical / horizontal / both',
    styleBtn: 'Color and thickness', undo: 'Undo', redo: 'Redo', north: 'Reset view rotation', files: 'Drawings: switch, export',
  };
  const tip = document.createElement('div'); tip.id = 'tip'; document.body.appendChild(tip);
  let tipTimer = 0, tipShown = false;
  document.querySelectorAll<HTMLButtonElement>('#bar button').forEach(b => {
    const text = TIPS[b.id || b.dataset.tool || ''];
    const hide = () => { clearTimeout(tipTimer); tip.classList.remove('on'); };
    b.addEventListener('pointerdown', () => {
      tipShown = false; clearTimeout(tipTimer);
      tipTimer = window.setTimeout(() => {
        tipShown = true; tip.textContent = text;
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
  const color = $<HTMLInputElement>('#color'), width = $<HTMLInputElement>('#width');
  color.oninput = () => app.setStyle({ color: color.value }, false);
  color.onchange = () => app.setStyle({ color: color.value }, true);
  width.oninput = () => { app.setStyle({ width: +width.value }, false); $('#wval').textContent = width.value; };
  width.onchange = () => app.setStyle({ width: +width.value }, true);

  const WL = ['off', 'V', 'H', 'V+H'];
  const refresh = () => {
    document.querySelectorAll<HTMLButtonElement>('#bar button').forEach(b => b.classList.remove('active'));
    const act = app.toolId === 'select' ? $('#selBtn') : app.toolId === 'wrap' ? $('#wrapBtn') : document.querySelector(`[data-tool=${app.toolId}]`)!;
    act.classList.add('active');
    $<HTMLButtonElement>('#undo').disabled = !app.store.canUndo;
    $<HTMLButtonElement>('#redo').disabled = !app.store.canRedo;
    $('#wrapLbl').textContent = 'Wrap ' + WL[(app.wrap.x ? 1 : 0) + (app.wrap.y ? 2 : 0)];
    const st = app.styleView();
    $('#dot').style.background = st.color;
    if (document.activeElement !== color) color.value = st.color;
    if (document.activeElement !== width) { width.value = String(st.width); }
    $('#wval').textContent = String(+st.width.toFixed(1));
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
