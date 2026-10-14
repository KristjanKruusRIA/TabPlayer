import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, cp, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const api=()=>import('./verify-packaged-resources.mjs');
async function fixture() {
  const sourceRoot=await mkdtemp(join(tmpdir(),'tabplayer-package-'));
  const referenceRoot=join(sourceRoot,'reference');const packageRoot=join(sourceRoot,'unpacked');
  const audio=join(packageRoot,'usr/lib/tabplayer/audio');
  await mkdir(join(sourceRoot,'assets/audio'),{recursive:true});
  for(const path of ['samples/fixture','licenses','soundfont'])await mkdir(join(referenceRoot,path),{recursive:true});
  const wave=Buffer.from('authored fixture PCM bytes'),license=Buffer.from('CC0 fixture license\n'),sf=Buffer.from('fixture font bytes');
  for(const [path,bytes] of [['samples/fixture/note.wav',wave],['licenses/fixture.txt',license],['licenses/Apache-2.0.txt','Apache fixture\n'],['soundfont/sonivox.sf2',sf],['soundfont/LICENSE','Sonivox fixture\n']])await writeFile(join(referenceRoot,path),bytes);
  const manifest={schemaVersion:1,preparationId:'fixture',sources:[{id:'fixture',repository:'fixture/public',revision:'1'.repeat(40),license:'CC0-1.0',licensePath:'licenses/fixture.txt',licenseSha256:hash(license)}],instruments:[{id:'guitar',regions:[{sampleId:'fixture:Samples/note.wav'}]}],samples:[{id:'fixture:Samples/note.wav',path:'samples/fixture/note.wav',size:wave.length,sha256:hash(wave),sourceSha256:hash(wave)}],soundFont:{path:'soundfont/sonivox.sf2',size:sf.length,sha256:hash(sf)}};
  await writeFile(join(referenceRoot,'manifest.json'),JSON.stringify(manifest));
  await writeFile(join(sourceRoot,'assets/audio/sources.json'),JSON.stringify({sources:[{id:'fixture',repository:'fixture/public',revision:'1'.repeat(40),license:'CC0-1.0',licensePath:'LICENSE',inventoryPath:'fixture-inventory.json'}],soundFont:{sha256:hash(sf)}}));
  await writeFile(join(sourceRoot,'assets/audio/fixture-inventory.json'),JSON.stringify([{path:'Samples/note.wav',sha256:hash(wave)},{path:'LICENSE',sha256:hash(license)}]));
  await cp(referenceRoot,audio,{recursive:true});
  return {sourceRoot,referenceRoot,packageRoot,audio};
}

test('extracted_package_contains_all_pinned_recordings_and_exact_licenses',async()=> {
  const {verifyPackage}=await api();const options=await fixture();
  const report=await verifyPackage(options);
  assert.equal(report.sampleCount,1);assert.equal(report.regionCount,1);assert.equal(report.sourceRevisions.fixture,'1'.repeat(40));
  assert.equal(report.encodedSampleBytes,26);
});

test('package_missing_or_corrupt_resources_are_rejected_without_network',async()=> {
  const {verifyPackage}=await api();const options=await fixture();
  await writeFile(join(options.audio,'samples/fixture/note.wav'),'damaged');
  await assert.rejects(verifyPackage(options),/hash|size/i);
  const missing=await fixture();await unlink(join(missing.audio,'samples/fixture/note.wav'));
  await assert.rejects(verifyPackage(missing),/ENOENT|missing/i);
  const other=await fixture();await writeFile(join(other.audio,'licenses/fixture.txt'),'wrong license');
  await assert.rejects(verifyPackage(other),/hash|license/i);
  const absent=await fixture();await writeFile(join(absent.audio,'manifest.json'),'{}');
  await assert.rejects(verifyPackage(absent),/manifest/i);
});

test('package_omissions_private_scores_and_path_escape_are_rejected',async()=> {
  const {verifyPackage}=await api();const options=await fixture();
  await writeFile(join(options.packageRoot,'private.gp'),'private score');
  await assert.rejects(verifyPackage(options),/private|score/i);
  const extra=await fixture();await writeFile(join(extra.audio,'unlisted.wav'),'extra');
  await assert.rejects(verifyPackage(extra),/unlisted|unexpected/i);
  const escaped=await fixture();const manifest=JSON.parse(await readFile(join(escaped.referenceRoot,'manifest.json')));
  manifest.samples[0].path='../outside.wav';
  for(const root of [escaped.referenceRoot,escaped.audio])await writeFile(join(root,'manifest.json'),JSON.stringify(manifest));
  await assert.rejects(verifyPackage(escaped),/path|escape/i);
});

test('package_artifact_set_requires_every_requested_format_and_hashes_real_bytes',async()=> {
  const {packageArtifacts}=await api();const root=await mkdtemp(join(tmpdir(),'tabplayer-installers-'));
  await writeFile(join(root,'TabPlayer.msi'),'MSI fixture');
  await assert.rejects(packageArtifacts(root,['msi','exe']),/exe/);
  await writeFile(join(root,'TabPlayer.exe'),'NSIS fixture');
  const files=await packageArtifacts(root,['msi','exe']);
  assert.equal(files.length,2);assert.equal(files.find(f=>f.path.endsWith('.exe')).sha256,hash('NSIS fixture'));
});
