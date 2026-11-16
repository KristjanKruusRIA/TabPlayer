import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// `cargo test <name> -- --ignored` exits 0 when the name matches no test, so a renamed or removed test would pass CI unnoticed.
// This runs each named ignored test of one integration-test target by its exact name and fails unless it ran and passed.
export function ranAndPassed(output, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^test ${escaped} \\.\\.\\. ok$`, 'm').test(output) && /^test result: ok\. 1 passed; 0 failed;/m.test(output);
}

export function runIgnoredTests(target, names, manifest = 'src-tauri/Cargo.toml') {
  let failed = false;
  for (const name of names) {
    const run = spawnSync('cargo', ['test', '--locked', '--manifest-path', manifest, '--test', target, name, '--', '--ignored', '--exact', '--nocapture'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    process.stdout.write(output);
    if (run.status !== 0 || !ranAndPassed(output, name)) {
      console.error(`${target}: ${name} did not run and pass`);
      failed = true;
    }
  }
  return !failed;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [target, ...names] = process.argv.slice(2);
  if (!target || names.length === 0) {
    console.error('usage: node scripts/cargo-test-ran.mjs <test target> <ignored test name>...');
    process.exit(2);
  }
  process.exit(runIgnoredTests(target, names) ? 0 : 1);
}
