import { getImageBlob } from './persist';

/** Decoded image cache. Rendering asks for bitmaps synchronously; missing ones load in the background. */
const cache = new Map<string, ImageBitmap | 'loading' | 'failed'>();
let onLoaded: () => void = () => {};
export const setImageLoadedHandler = (fn: () => void) => { onLoaded = fn; };

export function getBitmap(id: string): ImageBitmap | null {
  const c = cache.get(id);
  if (c && c !== 'loading' && c !== 'failed') return c;
  if (!c) {
    cache.set(id, 'loading');
    getImageBlob(id).then(b => b ? createImageBitmap(b) : Promise.reject(new Error('missing')))
      .then(bm => { cache.set(id, bm); onLoaded(); })
      .catch(() => cache.set(id, 'failed'));
  }
  return null;
}
export async function preload(ids: Iterable<string>) {
  await Promise.all([...new Set(ids)].map(async id => {
    const c = cache.get(id);
    if (c && c !== 'loading' && c !== 'failed') return;
    const b = await getImageBlob(id);
    if (b) cache.set(id, await createImageBitmap(b));
  }));
}
export function forget(id: string) { const c = cache.get(id); if (c && typeof c !== 'string') c.close(); cache.delete(id); }

const MAX_SIDE = 2048;
/** Downscale an uploaded file, keep a small thumbnail, and warm the cache. */
export async function decodeFile(file: File, id: string) {
  const bm = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const k = Math.min(1, MAX_SIDE / Math.max(bm.width, bm.height));
  const iw = Math.max(1, Math.round(bm.width * k)), ih = Math.max(1, Math.round(bm.height * k));
  const c = document.createElement('canvas'); c.width = iw; c.height = ih;
  const x = c.getContext('2d')!; x.imageSmoothingQuality = 'high'; x.drawImage(bm, 0, 0, iw, ih);
  const keepAlpha = /png|webp|gif|svg/.test(file.type);
  const blob = await new Promise<Blob>(res => c.toBlob(b => res(b!), keepAlpha ? 'image/png' : 'image/jpeg', 0.9));
  const t = document.createElement('canvas'), tk = 160 / Math.max(iw, ih);
  t.width = Math.max(1, Math.round(iw * tk)); t.height = Math.max(1, Math.round(ih * tk));
  t.getContext('2d')!.drawImage(c, 0, 0, t.width, t.height);
  const thumb = t.toDataURL(keepAlpha ? 'image/png' : 'image/jpeg', 0.8);
  bm.close();
  cache.set(id, await createImageBitmap(blob));
  return { blob, iw, ih, thumb };
}
