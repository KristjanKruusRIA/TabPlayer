import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, cp, readFile, unlink, realpath, symlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const api=()=>import('./verify-packaged-resources.mjs');
async function fixture() {
  const sourceRoot=await mkdtemp(join(await realpath(tmpdir()),'tabplayer-package-'));
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
  const library=join(packageRoot,'usr/lib/tabplayer/library');
  await cp(new URL('../assets/library/',import.meta.url),join(sourceRoot,'assets/library'),{recursive:true});
  await cp(join(sourceRoot,'assets/library'),library,{recursive:true});
  const cabinetRoot=join(sourceRoot,'cabinet-irs-reference'),cabinet=join(packageRoot,'usr/lib/tabplayer/cabinet-irs');
  await mkdir(cabinetRoot,{recursive:true});
  const irs=[Buffer.from('first fixture impulse response'),Buffer.from('second fixture impulse response')];
  const notice=Buffer.from('CC0 1.0 Universal (CC0-1.0)\n'),dedication=Buffer.from('Full CC0 dedication\n');
  const entries=[];
  for(const [index,bytes] of irs.entries()) {
    const sha256=hash(bytes),file=`fixture-${index}.wav`;
    await writeFile(join(cabinetRoot,file),bytes);
    entries.push({id:sha256.slice(0,32),name:`Fixture ${index}`,file,sha256,size:bytes.length,sampleRate:48000,channels:1,frames:16});
  }
  await writeFile(join(cabinetRoot,'README.txt'),notice);
  await writeFile(join(cabinetRoot,'LICENSE-CC0.txt'),dedication);
  await writeFile(join(cabinetRoot,'manifest.json'),JSON.stringify({schemaVersion:1,license:'CC0-1.0',licenseFile:'LICENSE-CC0.txt',source:'fixture',irs:entries}));
  await cp(cabinetRoot,cabinet,{recursive:true});
  const helper = join(packageRoot, 'tabplayer-plugin-host.exe');
  await writeFile(helper, 'fixture helper binary');
  return {sourceRoot,referenceRoot,packageRoot,audio,library,cabinet,cabinetRoot};
}

test('extracted_package_contains_all_pinned_recordings_and_exact_licenses',async()=> {
  const {verifyPackage}=await api();const options=await fixture();
  const report=await verifyPackage(options);
  assert.equal(report.sampleCount,1);assert.equal(report.regionCount,1);assert.equal(report.sourceRevisions.fixture,'1'.repeat(40));
  assert.equal(report.encodedSampleBytes,26);
  assert.equal(report.library.templateCount,10);assert.equal(report.library.exampleCount,3);assert.equal(report.library.fileCount,16);
  assert.equal(report.cabinetIrs.count,2);assert.match(report.cabinetIrs.manifestSha256,/^[a-f0-9]{64}$/);
});

test('bundled_cabinet_irs_are_verified_against_the_shipped_manifest',async()=> {
  const {verifyPackage}=await api();const options=await fixture();
  await writeFile(join(options.cabinet,'fixture-0.wav'),'damaged');
  await assert.rejects(verifyPackage(options),/hash|size/i);
  const missing=await fixture();await unlink(join(missing.cabinet,'fixture-1.wav'));
  await assert.rejects(verifyPackage(missing),/ENOENT|missing/i);
  const extra=await fixture();await writeFile(join(extra.cabinet,'unlisted.wav'),'extra');
  await assert.rejects(verifyPackage(extra),/Unexpected cabinet IR resource/i);
  const changed=await fixture();await writeFile(join(changed.cabinet,'manifest.json'),'{}');
  await assert.rejects(verifyPackage(changed),/cabinet IR manifest/i);
});

test('package_contains_all_offline_library_payloads_and_license_with_exact_source_hashes',async()=> {
  const {verifyPackage}=await api();
  for(const path of ['manifest.json','README.md','CC0-1.0.txt','templates/factory-guitar-6.tabplayer','examples/example-windowline.tabplayer']) {
    const options=await fixture();await unlink(join(options.library,path));
    await assert.rejects(verifyPackage(options),/Expected one extracted library manifest|Missing (prepared )?library resource/i);
  }
  for(const path of ['README.md','CC0-1.0.txt','templates/factory-guitar-6.tabplayer','examples/example-windowline.tabplayer']) {
    const options=await fixture();await writeFile(join(options.library,path),'changed bytes');
    await assert.rejects(verifyPackage(options),/Stale prepared library hash/i);
  }
});

test('only_manifest_owned_library_scores_are_admitted_and_preparation_is_read_only',async()=> {
  const {verifyPackage}=await api();const options=await fixture();
  await writeFile(join(options.library,'private.gp'),'private');
  await assert.rejects(verifyPackage(options),/unexpected|private/i);
  const stale=await fixture();const path=join(stale.library,'templates/factory-bass-6.tabplayer');
  await writeFile(path,'must survive verification');
  await assert.rejects(verifyPackage(stale),/stale|hash/i);
  assert.equal(await readFile(path,'utf8'),'must survive verification');
});

test('packaged_library_inventory_rejects_an_unknown_file_symlink_without_touching_its_target',async t=> {
  const {verifyPackage}=await api();const options=await fixture();
  const target=join(options.sourceRoot,'private-target.gp'),link=join(options.library,'private.gp');
  await writeFile(target,'owned target must remain unchanged');
  try{await symlink(target,link,'file');}catch(error){
    if(process.platform==='win32'&&['EPERM','EACCES'].includes(error.code)){t.skip(`File symlink unavailable: ${error.code}`);return;}
    throw error;
  }
  await assert.rejects(verifyPackage(options),/Unexpected library resource/i);
  assert.equal(await readFile(target,'utf8'),'owned target must remain unchanged');
  assert.equal((await lstat(link)).isSymbolicLink(),true);
});

test('packaged_library_inventory_rejects_an_unknown_directory_link_without_traversing_it',async()=> {
  const {verifyPackage}=await api();const options=await fixture();
  const target=join(options.sourceRoot,'owned-private-target'),link=join(options.library,'unowned');
  await mkdir(target);await writeFile(join(target,'private.gp'),'owned directory target');
  await symlink(target,link,process.platform==='win32'?'junction':'dir');
  assert.equal((await lstat(link)).isSymbolicLink(),true);
  await assert.rejects(verifyPackage(options),/Unexpected library resource/i);
  assert.equal(await readFile(join(target,'private.gp'),'utf8'),'owned directory target');
});

test('packaged_library_inventory_rejects_an_unknown_empty_directory',async()=> {
  const {verifyPackage}=await api();const options=await fixture();
  await mkdir(join(options.library,'unowned-empty'));
  await assert.rejects(verifyPackage(options),/Unexpected library resource/i);
});

test('outside_library_links_remain_untraversed_and_do_not_change_the_resource_policy',async()=> {
  const {verifyPackage}=await api();const options=await fixture();
  const target=join(options.sourceRoot,'owned-framework-target'),link=join(options.packageRoot,'framework-current');
  await mkdir(target);await writeFile(join(target,'untraversed.gp'),'owned framework-link target');
  await symlink(target,link,process.platform==='win32'?'junction':'dir');
  const report=await verifyPackage(options);
  assert.equal(report.library.fileCount,16);
  assert.equal((await lstat(link)).isSymbolicLink(),true);
  assert.equal(await readFile(join(target,'untraversed.gp'),'utf8'),'owned framework-link target');
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

test('verify_package_fails_without_plugin_host_helper',async()=> {
  const {verifyPackage}=await api();const options=await fixture();
  await unlink(join(options.packageRoot,'tabplayer-plugin-host.exe'));
  await assert.rejects(
    verifyPackage({...options,checkPluginHost:true}),
    /tabplayer-plugin-host\.exe|plug-in host helper/i
  );
});
