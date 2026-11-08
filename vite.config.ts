import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

// Vitest starts one worker fewer than the logical processors, which is 27 on the 28-thread development machine. The suite is
// CPU-bound jsdom and parsing work, and there one single-thread allocation-heavy benchmark ran 1.7x slower with 8 copies at once
// and 4.8x slower with 28, while the total work done per second stopped growing at about 12 copies. More workers therefore only
// stretch every test: a full run with 27 failed 19 to 22 tests on the 5 s limit and took 275 to 333 s, and with 6 four runs passed
// in 252 to 283 s. This only ever lowers the count, so the 3 workers of a 4-core CI runner are unchanged.
// Measurements: docs/validation/2026-11-08-the-173-app-mount-tests.md.
const MAX_WORKERS = 6;

export default defineConfig({
  clearScreen: false,
  optimizeDeps: { exclude: ['@coderline/alphatab'] },
  build: { rollupOptions: { external: ['@coderline/alphatab'] } },
  test: {
    include: ['src/**/*.test.{ts,tsx}'], setupFiles: ['tests/xml-dom.mjs'],
    maxWorkers: Math.max(1, Math.min(MAX_WORKERS, availableParallelism() - 1)),
    // Converting a dense 12 MiB MusicXML score (src/batch/convert.test.ts) peaks between 2 and 3 GB of heap. Node's default
    // heap is about 2 GB on a 7 GB macOS runner, where the worker was killed, so every test worker gets 4 GB. This suits the
    // default forks pool, which CI uses; worker threads refuse the flag, so `--pool=threads` needs it removed.
    execArgv: ['--max-old-space-size=4096'],
  }
});
