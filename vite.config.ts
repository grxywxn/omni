import { defineConfig } from 'vite';

// Tauri expects a fixed dev port and no screen clearing so Rust errors stay visible.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    // WebView2 on Windows is Chromium-based, so we can target modern JS and skip polyfills.
    target: 'chrome110',
    minify: 'esbuild',
    sourcemap: false,
    cssCodeSplit: true,
  },
});
