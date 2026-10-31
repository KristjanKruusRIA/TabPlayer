import { defineConfig } from 'vitest/config';

export default defineConfig({
  clearScreen: false,
  optimizeDeps: { exclude: ['@coderline/alphatab'] },
  build: { rollupOptions: { external: ['@coderline/alphatab'] } },
  test: { include: ['src/**/*.test.{ts,tsx}'], setupFiles: ['tests/xml-dom.mjs'] }
});
