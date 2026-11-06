import { App } from './app';
import { attachGestures } from './gestures';
import { setupUI } from './ui';
import { getLast, loadDoc } from './persist';
import { setImageLoadedHandler } from './images';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const app = new App();
app.ctx = canvas.getContext('2d')!;

function resize() {
  app.dpr = window.devicePixelRatio || 1;
  app.view.w = window.innerWidth; app.view.h = window.innerHeight;
  canvas.width = Math.round(app.view.w * app.dpr); canvas.height = Math.round(app.view.h * app.dpr);
  app.requestRender();
}
window.addEventListener('resize', resize);
resize();

setImageLoadedHandler(() => app.requestRender());
const { activity } = setupUI(app);
attachGestures(canvas, app, activity);

const flushNow = () => { void app.flush(); };
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushNow(); });
window.addEventListener('pagehide', flushNow);

// keep the browser from evicting drawings under storage pressure (best effort)
navigator.storage?.persist?.().catch(() => {});

(async () => {
  const id = await getLast();
  const d = id ? await loadDoc(id) : undefined;
  if (d) app.loadData(d); else app.newDoc();
})();

const ver = __APP_VERSION__ === 'dev' ? 'dev build' : 'v' + __APP_VERSION__;
document.title = 'Endloszeichnung ' + ver;
const pill = document.getElementById('ver')!;
pill.textContent = 'Endloszeichnung ' + ver;
pill.classList.add('on');
setTimeout(() => pill.classList.remove('on'), 4000);
