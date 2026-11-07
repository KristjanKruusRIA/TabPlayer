import { defineConfig } from 'vitest/config';

export default defineConfig({
  clearScreen: false,
  optimizeDeps: { exclude: ['@coderline/alphatab'] },
  build: { rollupOptions: { external: ['@coderline/alphatab'] } },
  test: {
    include: ['src/**/*.test.{ts,tsx}'], setupFiles: ['tests/xml-dom.mjs'],
    // Converting a dense 12 MiB MusicXML score (src/batch/convert.test.ts) peaks between 2 and 3 GB of heap. Node's default
    // heap is about 2 GB on a 7 GB macOS runner, where the worker was killed, so every test worker gets 4 GB. This suits the
    // default forks pool, which CI uses; worker threads refuse the flag, so `--pool=threads` needs it removed.
    execArgv: ['--max-old-space-size=4096'],
  }
});
