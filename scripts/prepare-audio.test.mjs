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

test('archive_extraction_is_flat_and_bounded', async () => {
  const { extractArchive } = await api();
  const { zipSync } = await import('fflate');
  const zip = files => Buffer.from(zipSync(files));
  const entries = extractArchive(zip({ 'A_long.flac': new Uint8Array(10), 'B_long.flac': new Uint8Array(4) }));
  assert.deepEqual([...entries.keys()].sort(), ['A_long.flac', 'B_long.flac']);
  assert.equal(entries.get('A_long.flac').length, 10);
  assert.throws(() => extractArchive(zip({ '../escape.flac': new Uint8Array(1) })), /Unexpected archive entry/);
  assert.throws(() => extractArchive(zip({ 'sub/note.flac': new Uint8Array(1) })), /Unexpected archive entry/);
  const limits = { entries: 1, entryBytes: 8, totalBytes: 16 };
  assert.throws(() => extractArchive(zip({ 'a.flac': new Uint8Array(1), 'b.flac': new Uint8Array(1) }), limits), /limits/);
  assert.throws(() => extractArchive(zip({ 'a.flac': new Uint8Array(9) }), limits), /limits/);
});

test('flac_recordings_are_kept_unchanged', async () => {
  const { prepareLibrary } = await api();
  const root = await fixture();
  // Authored FLAC header: STREAMINFO only, 4,410 frames. Preparation reads its frame count, not its audio.
  const flac = Buffer.alloc(42); flac.write('fLaC'); flac[4] = 0x80; flac.writeUIntBE(34, 5, 3);
  flac.writeUInt32BE(4410, 22);
  await writeFile(join(root, 'Samples/slap.flac'), flac);
  await writeFile(join(root, 'Programs/main.sfz'), '<region> sample=../Samples/slap.flac pitch_keycenter=33');
  const result = await prepareLibrary({ sourceRoot: root, outputRoot: join(root, 'out'), source: { id: 'fixture', licensePath: 'LICENSE' }, instruments: [{ id: 'bass', name: 'Bass', maps: [{ path: 'Programs/main.sfz', articulation: 'slap' }] }] });
  assert.deepEqual(await readFile(join(root, 'out', result.samples[0].path)), flac);
  assert.equal(result.instruments[0].regions[0].articulation, 'slap');
  await writeFile(join(root, 'Samples/slap.flac'), Buffer.from('fLaC-corrupt'));
  await assert.rejects(prepareLibrary({ sourceRoot: root, outputRoot: join(root, 'bad'), source: { id: 'fixture', licensePath: 'LICENSE' }, instruments: [{ id: 'bass', name: 'Bass', maps: [{ path: 'Programs/main.sfz', articulation: 'slap' }] }] }), /FLAC/);
});

test('pcm_format_chunk_with_zero_extension_is_shortened', async () => {
  const { shortenPcmFormat } = await api();
  const wave=(fmtExtra)=>{
    const fmt=Buffer.alloc(16+fmtExtra.length);fmt.writeUInt16LE(1,0);fmt.writeUInt16LE(2,2);fmt.writeUInt32LE(44100,4);fmt.writeUInt32LE(44100*4,8);fmt.writeUInt16LE(4,12);fmt.writeUInt16LE(16,14);fmtExtra.copy(fmt,16);
    const data=Buffer.from([1,0,2,0,3,0,4,0]);
    const chunk=(id,body)=>{const h=Buffer.alloc(8);h.write(id,0,'ascii');h.writeUInt32LE(body.length,4);return Buffer.concat([h,body]);};
    const body=Buffer.concat([Buffer.from('WAVE'),chunk('fmt ',fmt),chunk('data',data)]);
    const riff=Buffer.alloc(8);riff.write('RIFF',0,'ascii');riff.writeUInt32LE(body.length,4);return Buffer.concat([riff,body]);
  };
  const plain=wave(Buffer.alloc(0));
  assert.deepEqual(shortenPcmFormat(wave(Buffer.alloc(4))),plain);
  assert.equal(shortenPcmFormat(plain),plain);
  assert.throws(()=>shortenPcmFormat(wave(Buffer.from([0,0,1,0]))),/format extension/);
});

test('a_companion_recording_and_a_processing_table_are_pinned_and_carried_into_the_manifest', async () => {
  const { prepareLibrary, resolveSfz } = await api();
  const root = await fixture();
  await writeFile(join(root, 'Programs/main.sfz'), '<region> sample=../Samples/soft1.wav tp_pair=../Samples/soft2.wav key=36 pitch_keytrack=0\n<region> sample=../Samples/hard1.wav key=38 pitch_keytrack=0');
  const table = { profiles: { kick: { envelope: { holdMs: 40, decayDbPerSecond: 200, endMs: 300 } } }, sounds: { 36: 'kick' } };
  await writeFile(join(root, 'Programs/main.processing.json'), JSON.stringify(table));
  const regions = await resolveSfz(root, 'Programs/main.sfz', { articulation: 'picked' });
  assert.equal(regions[0].companionSourcePath, 'Samples/soft2.wav');
  assert.equal(regions[1].companionSourcePath, undefined);
  const options = { sourceRoot: root, outputRoot: join(root, 'out'), source: { id: 'fixture', licensePath: 'LICENSE' }, instruments: [{ id: 'test', name: 'Test', maps: [{ path: 'Programs/main.sfz', articulation: 'picked' }], processing: 'Programs/main.processing.json' }] };
  const result = await prepareLibrary(options);
  const [kick, snare] = result.instruments[0].regions;
  assert.equal(kick.companionId, 'fixture:Samples/soft2.wav');
  assert.equal(kick.companionSourcePath, undefined);
  assert.equal(snare.companionId, undefined);
  // The companion is a listed, copied, pinned recording of its own; the table travels with the instrument.
  assert.deepEqual(result.samples.map(item => item.id).sort(), ['fixture:Samples/hard1.wav', 'fixture:Samples/soft1.wav', 'fixture:Samples/soft2.wav']);
  for (const path of ['Samples/soft2.wav', 'Programs/main.processing.json']) assert.ok(result.inventory.some(item => item.path === path), path);
  assert.deepEqual(result.instruments[0].processing, table);
  // A table with an unknown top-level key, or a companion with no table, or a companion path that escapes, is refused.
  await writeFile(join(root, 'Programs/main.processing.json'), JSON.stringify({ ...table, extra: 1 }));
  await assert.rejects(prepareLibrary(options), /processing table/);
  await assert.rejects(prepareLibrary({ ...options, instruments: [{ ...options.instruments[0], processing: undefined }] }), /without a processing table/);
  await writeFile(join(root, 'Programs/main.sfz'), '<region> sample=../Samples/soft1.wav tp_pair=../../outside.wav');
  await assert.rejects(resolveSfz(root, 'Programs/main.sfz'), /escape|outside/i);
});

test('a_kit_processing_table_with_a_repeated_key_is_refused_and_a_valid_one_parses_as_json_does', async () => {
  const { parseStrictJson } = await api();
  const good = '{ "profiles": { "kick": { "eq": [ { "kind": "peak", "hz": 400, "db": -5.5, "q": 1e0 } ], "name": "a\\"b\u00e9" } }, "sounds": { "36": "kick" }, "n": null, "t": true, "list": [] , "o": {} }';
  assert.deepEqual(parseStrictJson(good), JSON.parse(good));
  assert.throws(() => parseStrictJson('{"profiles":{"kick":{},"kick":{}}}'), /Duplicate key "kick"/);
  assert.throws(() => parseStrictJson('{"sounds":{"36":"kick","36":"snare"}}'), /Duplicate key "36"/);
  assert.throws(() => parseStrictJson('{"a":[{"b":1,"b":2}]}'), /Duplicate key "b"/);
  assert.throws(() => parseStrictJson('{"a":1,}'), /Invalid JSON/);
  assert.throws(() => parseStrictJson('{"a":1} x'), /Invalid JSON/);
  assert.throws(() => parseStrictJson('{"a" 1}'), /Invalid JSON/);
  // A key that JSON.parse would turn into the prototype stays a plain property.
  assert.deepEqual(Object.keys(parseStrictJson('{"__proto__":{"x":1}}')), ['__proto__']);
});

test('an_extension_cannot_carry_kit_processing_or_companion_recordings', async () => {
  const { addInstrument } = await api();
  const base = () => ({ instruments: [{ id: 'kit', regions: [{ sampleId: 'a' }] }] });
  const manifest = base();
  addInstrument(manifest, { id: 'kit', regions: [{ sampleId: 'b' }] }, { id: 'kit', extends: true }, 'extra');
  assert.deepEqual(manifest.instruments[0].regions.map(r => r.sampleId), ['a', 'b']);
  assert.throws(() => addInstrument(base(), { id: 'kit', regions: [], processing: { profiles: {}, sounds: {} } }, { id: 'kit', extends: true }, 'extra'), /extends kit but gives it kit processing/);
  assert.throws(() => addInstrument(base(), { id: 'kit', regions: [{ sampleId: 'b', companionId: 'c' }] }, { id: 'kit', extends: true }, 'extra'), /kit processing/);
  assert.throws(() => addInstrument(base(), { id: 'nope', regions: [] }, { id: 'nope', extends: true }, 'extra'), /unknown instrument/);
  const plain = { instruments: [] };
  addInstrument(plain, { id: 'kit', regions: [], processing: {} }, { id: 'kit' }, 'main');
  assert.equal(plain.instruments.length, 1);
});
