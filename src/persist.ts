import { delMany, get, getMany, keys, set, setMany } from 'idb-keyval';
import { DocData, GalleryEntry, Meta, defaultLayers } from './types';

export const saveDoc = (d: DocData, m: Meta) => setMany([['doc:' + d.id, d], ['meta:' + d.id, m]]);
/** Loads a drawing and fills in fields older saves don't have (layers). */
export async function loadDoc(id: string): Promise<DocData | undefined> {
  const d = await get<DocData>('doc:' + id);
  if (!d) return d;
  if (!d.layers?.length) d.layers = defaultLayers();
  if (!d.activeLayer || !d.layers.some(l => l.id === d.activeLayer)) d.activeLayer = d.layers[d.layers.length - 1].id;
  return d;
}
export const deleteDoc = (id: string) => delMany(['doc:' + id, 'meta:' + id]);
export const setLast = (id: string) => set('last', id);
export const getLast = () => get<string>('last');
export async function listMetas(): Promise<Meta[]> {
  const ks = (await keys()).filter(k => typeof k === 'string' && k.startsWith('meta:'));
  return ((await getMany<Meta>(ks)).filter((m): m is Meta => !!m)).sort((a, b) => b.updatedAt - a.updatedAt);
}

// ---- image gallery: entries (small) and blobs (large) are stored separately ----
export const putImage = (e: GalleryEntry, blob: Blob) => setMany([['imggal:' + e.id, e], ['imgblob:' + e.id, blob]]);
export const getImageBlob = (id: string) => get<Blob>('imgblob:' + id);
export const removeGalleryEntry = (id: string) => delMany(['imggal:' + id]);
export const deleteImageBlob = (id: string) => delMany(['imgblob:' + id]);
export async function listGallery(): Promise<GalleryEntry[]> {
  const ks = (await keys()).filter(k => typeof k === 'string' && k.startsWith('imggal:'));
  return ((await getMany<GalleryEntry>(ks)).filter((e): e is GalleryEntry => !!e)).sort((a, b) => b.createdAt - a.createdAt);
}
/** Is the image still referenced by any saved drawing (objects or undo history)? */
export async function imageStillUsed(id: string): Promise<boolean> {
  const hit = (o: { type: string; img?: string }) => o.type === 'image' && o.img === id;
  for (const m of await listMetas()) {
    const d = await get<DocData>('doc:' + m.id);
    if (!d) continue;
    if (d.strokes.some(hit) || d.history.some(h => h.removed.some(hit) || h.added.some(hit))) return true;
  }
  return false;
}
