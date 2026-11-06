# endloszeichnung
webapp for drawing on an endless canvas with optional wrapping on one or both axis


## Dev
`npm install && npm run dev` (phone: open the printed LAN URL), `npm run build` for a static build in `dist/`.

Vector strokes on a Canvas2D; tools live in `src/tools/*`, document + diff-based undo in `src/store.ts`,
autosave to IndexedDB in `src/persist.ts`. Wrap period is `PERIOD` in `src/types.ts`.
