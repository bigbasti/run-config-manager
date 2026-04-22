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
        entryFileNames: 'assets/main.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: (info) => {
          if (info.name && info.name.endsWith('.css')) return 'assets/main.css';
          return 'assets/[name][extname]';
        },
      },
    },
    sourcemap: true,
  },
});
