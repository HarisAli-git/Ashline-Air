import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Relative paths, so the build runs from any folder — a GitHub Pages
  // project site lives under /<repo>/, not at the root of the domain
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
  },
});
