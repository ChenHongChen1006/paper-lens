import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base is relative so the build works whether it's served from a domain
// root or from a GitHub Pages subpath (https://USERNAME.github.io/REPO/).
export default defineConfig({
  base: './',
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/test/setup.js'],
  },
});
