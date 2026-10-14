import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  root: 'webview',
  build: {
    outDir: resolve(__dirname, 'media/webview'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'webview/index.html'),
      output: {
        // Classic (non-module) script: module scripts are fetched with CORS,
        // which fails for webview resources in recent VS Code versions.
        format: 'iife',
        entryFileNames: 'assets/main.js',
        // Single bundle: avoid dynamic-import chunks inside the webview.
        inlineDynamicImports: true,
        chunkFileNames: 'assets/[name].js',
        assetFileNames: (info) => {
          if (info.name && info.name.endsWith('.css')) return 'assets/main.css';
          return 'assets/[name][extname]';
        },
      },
    },
    cssCodeSplit: false,
    sourcemap: true,
  },
});
