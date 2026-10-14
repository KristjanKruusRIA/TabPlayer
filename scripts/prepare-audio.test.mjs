import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const api = () => import('./prepare-audio.mjs');

test('prepared_audio_fingerprint_is_identical_across_checkout_line_endings', async () => {
  const { preparationFingerprint } = await api();
  const expected=createHash('sha256').update('{"schemaVersion":1}alpha\nbeta\n').digest('hex');
  assert.equal(preparationFingerprint({schemaVersion:1},'alpha\nbeta\n'),expected);
  assert.equal(preparationFingerprint({schemaVersion:1},'alpha\r\nbeta\r\n'),expected);
  assert.notEqual(preparationFingerprint({schemaVersion:1},'alpha\nbeta!\n'),expected);
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tabplayer-audio-'));
  await mkdir(join(root, 'Programs/maps'), { recursive: true });
  await mkdir(join(root, 'Samples'), { recursive: true });
  // Authored 8-frame, mono PCM16 wave; no third-party music is used.
  const wav = Buffer.alloc(60);
  wav.write('RIFF'); wav.writeUInt32LE(52, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
  wav.writeUInt32LE(16, 40); wav.writeInt16LE(16384, 44);
  for (const name of ['soft1', 'soft2', 'hard1', 'hard2']) await writeFile(join(root, `Samples/${name}.wav`), wav);
  await writeFile(join(root, 'LICENSE'), 'Authored fixture CC0\n');
  await writeFile(join(root, 'Programs/main.sfz'), '<global> ampeg_attack=0.01 ampeg_release=0.25\n#include "maps/notes.sfz"');
  await writeFile(join(root, 'Programs/maps/notes.sfz'), '<group> lokey=40 hikey=43 pitch_keycenter=40 hivel=63\n<region> sample=../Samples/soft1.wav seq_length=2 seq_position=1\n<region> sample=../Samples/soft2.wav seq_length=2 seq_position=2\n<group> lokey=40 hikey=43 pitch_keycenter=40 lovel=64\n<region> sample=../Samples/hard1.wav seq_length=2 seq_position=1\n<region> sample=../Samples/hard2.wav seq_length=2 seq_position=2');
  return root;
}

test('pinned_manifest_keeps_velocity_variants', async () => {
  const { resolveSfz } = await api();
  const root = await fixture();
  const regions = await resolveSfz(root, 'Programs/main.sfz', { articulation: 'picked' });
  assert.deepEqual(regions.map(r => [r.velocityLow, r.velocityHigh, r.variant]), [[1,63,1],[1,63,2],[64,127,1],[64,127,2]]);
  assert.equal(regions[0].rootKey, 40);
  assert.equal(regions[0].keyHigh, 43);
  assert.equal(regions[0].attackSeconds, 0.01);
  assert.equal(regions[0].releaseSeconds, 0.25);
  assert.equal(regions[0].sourcePath, 'Samples/soft1.wav');
});

test('missing_corrupt_or_escape_sample_rejected', async () => {
  const { prepareLibrary } = await api();
  const root = await fixture();
  const options = { sourceRoot: root, outputRoot: join(root, 'out'), source: { id:'fixture', licensePath:'LICENSE' }, instruments: [{id:'test',name:'Test',maps:[{path:'Programs/main.sfz',articulation:'picked'}]}] };
  const result = await prepareLibrary(options);
  assert.equal(result.samples.length, 4);
  await writeFile(join(root, 'Samples/soft1.wav'), Buffer.from('corrupt'));
  await assert.rejects(prepareLibrary({...options, inventory:result.inventory}), /hash|corrupt/i);
  await writeFile(join(root, 'Programs/main.sfz'), '<region> sample=../../outside.wav');
  await assert.rejects(prepareLibrary(options), /escape|outside/i);
  await writeFile(join(root, 'Programs/main.sfz'), '<region> sample=../Samples/missing.wav');
  await assert.rejects(prepareLibrary(options), /missing|ENOENT/i);
});

test('asset_hash_and_license_inventory', async () => {
  const { prepareLibrary } = await api();
  const root = await fixture();
  const result = await prepareLibrary({sourceRoot:root,outputRoot:join(root,'out'),source:{id:'fixture',licensePath:'LICENSE'},instruments:[{id:'test',name:'Test',maps:[{path:'Programs/main.sfz',articulation:'picked'}]}]});
  for (const item of result.samples) assert.equal(createHash('sha256').update(await readFile(join(root,'out',item.path))).digest('hex'), item.sha256);
  assert.equal(await readFile(join(root,'out','licenses/fixture.txt'),'utf8'), 'Authored fixture CC0\n');
  assert.equal(result.inventory.length, 7); // 4 waves, 2 SFZ inputs, license.
});

test('unknown_mapping_opcode_and_include_escape_rejected', async () => {
  const { resolveSfz } = await api();
  const root=await fixture();
  await writeFile(join(root,'Programs/main.sfz'), '<region> sample=../Samples/soft1.wav offset=30');
  await assert.rejects(resolveSfz(root,'Programs/main.sfz'), /offset/);
  await writeFile(join(root,'Programs/main.sfz'), '#include "../../outside.sfz"');
  await assert.rejects(resolveSfz(root,'Programs/main.sfz'), /escape|outside/i);
});

test('pinned_pcm24_zero_padding_is_normalized_without_losing_frames', async () => {
  const { prepareLibrary } = await api();
  const root=await fixture();
  // The published bass release WAVs include a zero byte inside the data chunk
  // after their last complete PCM24 frame. It is RIFF padding, not a frame.
  const bytes=Buffer.alloc(48);bytes.write('RIFF');bytes.writeUInt32LE(40,4);bytes.write('WAVEfmt ',8);
  bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(8000,24);bytes.writeUInt32LE(24000,28);
  bytes.writeUInt16LE(3,32);bytes.writeUInt16LE(24,34);bytes.write('data',36);bytes.writeUInt32LE(4,40);bytes[46]=64;
  await writeFile(join(root,'Samples/soft1.wav'),bytes);
  const result=await prepareLibrary({sourceRoot:root,outputRoot:join(root,'out'),source:{id:'fixture',licensePath:'LICENSE'},instruments:[{id:'test',name:'Test',maps:[{path:'Programs/main.sfz',articulation:'picked'}]}]});
  const output=await readFile(join(root,'out',result.samples.find(s=>s.id==='fixture:Samples/soft1.wav').path));
  assert.equal(output.readUInt32LE(40),3);assert.deepEqual(output.subarray(44,47),bytes.subarray(44,47));
  assert.equal(result.inventory.find(s=>s.path==='Samples/soft1.wav').sha256,createHash('sha256').update(bytes).digest('hex'));
  bytes[47]=1;await writeFile(join(root,'Samples/soft1.wav'),bytes);
  await assert.rejects(prepareLibrary({sourceRoot:root,outputRoot:join(root,'bad'),source:{id:'fixture',licensePath:'LICENSE'},instruments:[{id:'test',name:'Test',maps:[{path:'Programs/main.sfz',articulation:'picked'}]}]}), /PCM|corrupt/i);
});
