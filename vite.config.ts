import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  root: 'src/ui',
  define: { __DECK_VERSION__: JSON.stringify(version) },
  plugins: [react()],
  build: {
    outDir: '../../dist/ui',
    emptyOutDir: true,
    // The CSP has no font-src data: — KaTeX fonts must stay files, never inlined.
    assetsInlineLimit: (file) => (/\.(woff2?|ttf)$/.test(file) ? false : undefined),
    // React and the other deps (mostly react-markdown + remark-gfm) as separate chunks, each under the 500 kB warning.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            // highlight.js, KaTeX and the math/highlight plugins are lazy (src/ui/mdEnhance.ts): left out so they stay out of the first load.
            { name: 'vendor', test: /node_modules[\\/](?!(highlight\.js|lowlight|katex|rehype-highlight|rehype-katex|remark-math|mdast-util-math|micromark-extension-math)[\\/])/ },
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:9320',
      '/ws': { target: 'ws://127.0.0.1:9320', ws: true },
    },
  },
});
