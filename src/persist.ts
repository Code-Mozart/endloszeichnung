import { delMany, get, getMany, keys, set, setMany } from 'idb-keyval';
import { DocData, Meta, defaultLayers } from './types';

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
