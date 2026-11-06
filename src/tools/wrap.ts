import type { PInfo, Tool } from './tool';
/** Placeholder tool: the wrap button activates it; seam shifting may be added here later. */
export class WrapTool implements Tool {
  id = 'wrap' as const;
  down(_p: PInfo) {}
  move(_p: PInfo) {}
  up(_p: PInfo) {}
  cancel() {}
}
