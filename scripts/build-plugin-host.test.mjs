import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { helperBinaryName, hostTriple, copyPluginHost } from './build-plugin-host.mjs';

test('build_plugin_host_names_target_triple_file', () => {
  assert.equal(
    helperBinaryName('x86_64-pc-windows-msvc'),
    'tabplayer-plugin-host-x86_64-pc-windows-msvc.exe'
  );
  assert.equal(
    helperBinaryName('aarch64-pc-windows-msvc'),
    'tabplayer-plugin-host-aarch64-pc-windows-msvc.exe'
  );
  assert.equal(
    helperBinaryName('x86_64-unknown-linux-gnu'),
    'tabplayer-plugin-host-x86_64-unknown-linux-gnu'
  );
  assert.equal(
    helperBinaryName('aarch64-apple-darwin'),
    'tabplayer-plugin-host-aarch64-apple-darwin'
  );
  assert.match(hostTriple(), /^.+-.+-.+/);
});

test('build_plugin_host_refuses_missing_build', async () => {
  const emptyDir = await mkdtemp(join(tmpdir(), 'test-target-'));
  const outputDir = join(emptyDir, 'binaries');
  await assert.rejects(
    copyPluginHost({
      targetDir: emptyDir,
      outputDir,
      triple: 'x86_64-pc-windows-msvc',
      profile: 'release',
    }),
    /missing|not found/i
  );
});
