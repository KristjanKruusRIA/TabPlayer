// Guards the bundled cabinet IRs: the manifest must describe exactly the WAVs that ship, with matching identities,
// sizes and hashes, and the generator must agree with it.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { generate } from './generate-cabinet-irs.mjs';

const directory = fileURLToPath(new URL('../src-tauri/resources/cabinet-irs/', import.meta.url));
const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));

test('cabinet IR manifest lists every bundled WAV with a verified identity and hash', async () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.license, 'CC0-1.0');
  assert.equal(manifest.licenseFile, 'LICENSE-CC0.txt');
  const files = (await readdir(directory)).filter(name => name.endsWith('.wav')).sort();
  assert.equal(manifest.irs.length, 58);
  assert.equal(manifest.irs.length, files.length);
  assert.deepEqual(manifest.irs.map(ir => ir.file).sort(), files);
  const ids = new Set();
  const names = new Set();
  for (const ir of manifest.irs) {
    assert.match(ir.id, /^[a-f0-9]{32}$/, ir.file);
    assert.ok(!ids.has(ir.id), `duplicate IR identity ${ir.id}`);
    ids.add(ir.id);
    assert.ok(ir.name.length > 0 && ir.name.length <= 64, ir.file);
    assert.ok(!names.has(ir.name), `duplicate IR name ${ir.name}`);
    names.add(ir.name);
    assert.equal(ir.channels, 1, ir.file);
    assert.ok([44_100, 48_000].includes(ir.sampleRate), ir.file);
    assert.ok(ir.frames > 0, ir.file);
    const bytes = await readFile(join(directory, ir.file));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    assert.equal(bytes.length, ir.size, ir.file);
    assert.equal(sha256, ir.sha256, ir.file);
    assert.equal(sha256.slice(0, 32), ir.id, ir.file);
  }
});

test('cabinet IR manifest matches the generator output', async () => {
  const regenerated = await generate({ directory, write: false });
  assert.deepEqual(regenerated, manifest);
});

test('the bundled cabinet IRs carry their CC0 dedication', async () => {
  const notice = await readFile(join(directory, 'README.txt'), 'utf8');
  assert.match(notice, /CC0 1\.0 Universal \(CC0-1\.0\)/);
  assert.match(notice, /creativecommons\.org\/publicdomain\/zero\/1\.0/);
  assert.match(notice, /read-only/i);
});
