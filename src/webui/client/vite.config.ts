import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/webui/client',
  plugins: [react()],
  build: {
    outDir: '../../../dist/webui/client',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: new URL('./index.html', import.meta.url).pathname,
        'central-admin': new URL('./central-admin.html', import.meta.url).pathname,
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
});
