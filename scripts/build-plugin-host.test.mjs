import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { helperBinaryName, hostTriple, copyPluginHost, cargoBuildArgs, resolveTargetDir, findTool } from './build-plugin-host.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

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

test('build_plugin_host_builds_with_locked_and_the_right_profile', () => {
  const release = cargoBuildArgs({ debug: false, manifestPath: 'M/Cargo.toml' });
  assert.deepEqual(release, ['build', '--locked', '--manifest-path', 'M/Cargo.toml', '-p', 'tabplayer-plugin-host', '--release']);
  const debug = cargoBuildArgs({ debug: true, manifestPath: 'M/Cargo.toml' });
  assert.ok(debug.includes('--locked'));
  assert.ok(!debug.includes('--release'));
});

test('build_plugin_host_reads_the_target_dir_from_cargo_target_dir', () => {
  assert.equal(
    resolveTargetDir({ CARGO_TARGET_DIR: join(tmpdir(), 'slot-x') }),
    join(tmpdir(), 'slot-x')
  );
  assert.equal(resolveTargetDir({}), join(root, 'src-tauri/target'));
  assert.equal(resolveTargetDir({ CARGO_TARGET_DIR: '' }), join(root, 'src-tauri/target'));
  assert.equal(resolveTargetDir({ CARGO_TARGET_DIR: 'rel-target' }), resolve('rel-target'));
});

test('build_plugin_host_finds_cargo_on_path_before_the_home_folder', async () => {
  const pathDir = await mkdtemp(join(tmpdir(), 'tool-path-'));
  const homeDir = await mkdtemp(join(tmpdir(), 'tool-home-'));
  await mkdir(join(homeDir, '.cargo/bin'), { recursive: true });
  const exe = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
  await writeFile(join(homeDir, '.cargo/bin', exe), '');
  const env = { PATH: pathDir, Path: pathDir, USERPROFILE: homeDir, HOME: homeDir };
  assert.equal(findTool('cargo', env), join(homeDir, '.cargo/bin', exe));
  await writeFile(join(pathDir, exe), '');
  assert.equal(findTool('cargo', env), join(pathDir, exe));
  const bare = await mkdtemp(join(tmpdir(), 'tool-bare-'));
  assert.equal(findTool('cargo', { PATH: bare, Path: bare, HOME: bare, USERPROFILE: bare }), 'cargo');
});

test('build_plugin_host_survives_a_missing_toolchain_when_naming_the_triple', () => {
  assert.match(hostTriple({ PATH: '', Path: '', HOME: '', USERPROFILE: '', CARGO_HOME: '' }), /^.+-.+-.+/);
});
