import { delMany, get, getMany, keys, set, setMany } from 'idb-keyval';
import type { DocData, Meta } from './types';

export const saveDoc = (d: DocData, m: Meta) => setMany([['doc:' + d.id, d], ['meta:' + d.id, m]]);
export const loadDoc = (id: string) => get<DocData>('doc:' + id);
export const deleteDoc = (id: string) => delMany(['doc:' + id, 'meta:' + id]);
export const setLast = (id: string) => set('last', id);
export const getLast = () => get<string>('last');
export async function listMetas(): Promise<Meta[]> {
  const ks = (await keys()).filter(k => typeof k === 'string' && k.startsWith('meta:'));
  return ((await getMany<Meta>(ks)).filter((m): m is Meta => !!m)).sort((a, b) => b.updatedAt - a.updatedAt);
}
