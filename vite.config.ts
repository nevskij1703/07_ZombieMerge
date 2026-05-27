import { defineConfig } from 'vite';

// base:'./' — относительные пути обязательны для file:// в Capacitor WebView (APK).
// strictPort — фиксируем 8777, чтобы dev-сервер не уезжал в превью соседнего проекта.
export default defineConfig({
  base: './',
  server: {
    port: 8777,
    strictPort: true,
    open: false,
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    assetsInlineLimit: 0,
  },
});
