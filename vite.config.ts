import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base matches the GitHub Pages project path: zboule.github.io/where-to-live/
export default defineConfig({
  plugins: [react()],
  base: '/where-to-live/',
});
