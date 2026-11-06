import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';

/** Version = PR number, taken from the merge commit subject ("Merge pull request #7 ..." or "... (#7)"). */
function version(): string {
  try {
    const m = execSync('git log -1 --format=%s').toString().match(/#(\d+)/);
    return m ? m[1] : 'dev';
  } catch { return 'dev'; }
}
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(version()) },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['apple-touch-icon.png'],
      manifest: {
        name: 'Endloszeichnung',
        short_name: 'Endlos',
        description: 'Endless drawing canvas with optional wrapping',
        display: 'standalone',
        orientation: 'any',
        start_url: './',
        scope: './',
        theme_color: '#2979ff',
        background_color: '#ffffff',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
});
