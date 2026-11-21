import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, lstat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

const api = () => import('./prepare-audio.mjs');

test('prepared_audio_fingerprint_is_identical_across_checkout_line_endings', async () => {
  const { preparationFingerprint } = await api();
  const expected = createHash('sha256').update('{"schemaVersion":1}alpha\nbeta\n').digest('hex');
  assert.equal(preparationFingerprint({ schemaVersion: 1 }, 'alpha\nbeta\n'), expected);
  assert.equal(preparationFingerprint({ schemaVersion: 1 }, 'alpha\r\nbeta\r\n'), expected);
  assert.notEqual(preparationFingerprint({ schemaVersion: 1 }, 'alpha\nbeta!\n'), expected);
});

async function pruneFixture() {
  const out = await mkdtemp(join(tmpdir(), 'tabplayer-prune-'));
  const put = async (path, text = 'x') => {
    await mkdir(dirname(join(out, path)), { recursive: true });
    await writeFile(join(out, path), text);
  };
  for (const path of [
    'samples/drums/Kit/kept1.flac',
    'samples/drums/Kit/kept2.wav',
    'samples/drums/Kit/stale1.flac',
    'samples/drums/Old/stale2.wav',
    'samples/gone/stale3.wav',
    'manifest.json',
    'notes.txt',
    'licenses/Apache-2.0.txt',
    'soundfont/sonivox.sf2',
  ]) {
    await put(path);
  }
  const manifest = {
    samples: [{ path: 'samples/drums/Kit/kept1.flac' }, { path: 'samples/drums/Kit/kept2.wav' }],
  };
  return { out, manifest, put };
}

const exists = async path => {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
};

test('the_prepare_script_removes_recordings_the_pins_no_longer_name_and_nothing_else', async () => {
  const { prunePreparedSamples } = await api();
  const { out, manifest } = await pruneFixture();
  assert.equal(await prunePreparedSamples(out, manifest), 3);
  for (const path of [
    'samples/drums/Kit/kept1.flac',
    'samples/drums/Kit/kept2.wav',
    'manifest.json',
    'notes.txt',
    'licenses/Apache-2.0.txt',
    'soundfont/sonivox.sf2',
  ]) {
    assert.ok(await exists(join(out, path)), path);
  }
  for (const path of [
    'samples/drums/Kit/stale1.flac',
    'samples/drums/Old/stale2.wav',
    'samples/gone/stale3.wav',
  ]) {
    assert.ok(!await exists(join(out, path)), path);
  }
  assert.equal(await prunePreparedSamples(out, manifest), 0);
});

test('pruning_neither_follows_nor_removes_a_link_inside_the_sample_tree', async () => {
  const { prunePreparedSamples } = await api();
  const { out, manifest } = await pruneFixture();
  const outside = await mkdtemp(join(tmpdir(), 'tabplayer-outside-'));
  await writeFile(join(outside, 'precious.wav'), 'keep');
  const link = join(out, 'samples/drums/Linked');
  try {
    await symlink(outside, link, 'junction');
  } catch {
    return;
  }
  assert.equal(await prunePreparedSamples(out, manifest), 3);
  assert.equal(await readFile(join(outside, 'precious.wav'), 'utf8'), 'keep');
  assert.ok((await lstat(link)).isSymbolicLink());
});

test('pruning_leaves_a_linked_sample_folder_alone', async () => {
  const { prunePreparedSamples } = await api();
  const out = await mkdtemp(join(tmpdir(), 'tabplayer-prune-'));
  const outside = await mkdtemp(join(tmpdir(), 'tabplayer-outside-'));
  await writeFile(join(outside, 'other.wav'), 'keep');
  try {
    await symlink(outside, join(out, 'samples'), 'junction');
  } catch {
    return;
  }
  assert.equal(await prunePreparedSamples(out, { samples: [] }), 0);
  assert.equal(await readFile(join(outside, 'other.wav'), 'utf8'), 'keep');
});

test('prepare_audio_prepares_gm_soundfont_only_and_prunes_stale_samples_and_licenses', async () => {
  const { prepareAudio } = await api();
  const root = await mkdtemp(join(tmpdir(), 'tabplayer-root-'));
  const put = async (path, data) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), data);
  };
  const sf = Buffer.from('fixture gm soundfont');
  const sfHash = createHash('sha256').update(sf).digest('hex');
  await put(
    'assets/audio/sources.json',
    JSON.stringify({
      schemaVersion: 1,
      sources: [],
      soundFont: { package: 'sfpkg', version: '1.0.0', path: 'a.sf2', sha256: sfHash },
    })
  );
  await put('node_modules/sfpkg/package.json', JSON.stringify({ version: '1.0.0' }));
  await put('node_modules/sfpkg/a.sf2', sf);
  await put('node_modules/sfpkg/LICENSE', 'sf license');
  await put('legal/Apache-2.0.txt', 'apache');

  await put('src-tauri/resources/audio/samples/guitar/stale.wav', 'old sample');
  await put('src-tauri/resources/audio/licenses/drums.txt', 'old license');

  const lines = [];
  const log = console.log;
  console.log = line => lines.push(String(line));
  let manifest;
  try {
    manifest = await prepareAudio({ root });
  } finally {
    console.log = log;
  }

  assert.deepEqual(manifest.sources, []);
  assert.deepEqual(manifest.instruments, []);
  assert.deepEqual(manifest.samples, []);
  assert.equal(manifest.soundFont.sha256, sfHash);
  assert.ok(!await exists(join(root, 'src-tauri/resources/audio/samples')));
  assert.ok(!await exists(join(root, 'src-tauri/resources/audio/licenses/drums.txt')));
  assert.ok(await exists(join(root, 'src-tauri/resources/audio/licenses/Apache-2.0.txt')));
  assert.ok(await exists(join(root, 'src-tauri/resources/audio/soundfont/sonivox.sf2')));
  assert.ok(lines.some(line => /^Removed 1 stale recorded sample/.test(line)));
  assert.ok(lines.some(line => /^Removed 1 stale license file/.test(line)));

  // Offline verification succeeds on the prepared output and refuses hash tampering.
  const offlineManifest = await prepareAudio({ root, offline: true });
  assert.equal(offlineManifest.preparationId, manifest.preparationId);

  await put('src-tauri/resources/audio/soundfont/sonivox.sf2', 'tampered');
  await assert.rejects(prepareAudio({ root, offline: true }), /hash mismatch/i);
});

test('prepare_audio_refuses_legacy_bundled_sources', async () => {
  const { prepareAudio } = await api();
  const root = await mkdtemp(join(tmpdir(), 'tabplayer-legacy-'));
  await mkdir(join(root, 'assets/audio'), { recursive: true });
  await writeFile(
    join(root, 'assets/audio/sources.json'),
    JSON.stringify({ schemaVersion: 1, sources: [{ id: 'guitar' }], soundFont: {} })
  );
  await assert.rejects(prepareAudio({ root }), /sources.*\[\]|removed/i);
});
