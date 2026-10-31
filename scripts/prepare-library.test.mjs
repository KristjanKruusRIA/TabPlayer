import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,symlink,lstat,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {prepareLibrary} from './prepare-library.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const templateIds=['factory-guitar-6','factory-guitar-7','factory-guitar-8','factory-guitar-9','factory-bass-4','factory-bass-5','factory-bass-6','factory-keys','factory-drums','factory-band'];
const exampleIds=['example-windowline','example-seven-steps-five-echoes','example-lantern-counterpoint'];
async function fixture(t){
  const directory=await mkdtemp(join(await realpath(tmpdir()),'tabplayer-library-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const source=join(directory,'source'),destination=join(directory,'prepared');await mkdir(source);await mkdir(destination);
  const manifest={format:'TabPlayerBundledLibrary',version:1,templates:[],examples:[],documents:[]};
  for(const [kind,ids] of [['templates',templateIds],['examples',exampleIds]]){
    await mkdir(join(source,kind));
    for(const id of ids){const bytes=Buffer.from(`original ${id}\n`),path=`${kind}/${id}.tabplayer`;await writeFile(join(source,path),bytes);manifest[kind].push({id,title:id,description:'Original offline content',instruments:['Keys'],origin:kind==='templates'?'factory':'example',license:'CC0-1.0',path,sha256:hash(bytes)});}
  }
  for(const path of ['README.md','CC0-1.0.txt']){const bytes=Buffer.from(`Original ${path}\n`);await writeFile(join(source,path),bytes);manifest.documents.push({path,sha256:hash(bytes)});}
  const save=()=>writeFile(join(source,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');await save();
  return{directory,source,destination,manifest,save};
}

test('copies the exact offline owned inventory and preserves unrelated destination content',async t=>{
  const f=await fixture(t);await writeFile(join(f.source,'unlisted-private.txt'),'not a resource');await writeFile(join(f.destination,'unrelated.txt'),'keep');
  const result=await prepareLibrary(f);assert.equal(result.files.length,16);assert.equal(await readFile(join(f.destination,'unrelated.txt'),'utf8'),'keep');
  assert.equal(await readFile(join(f.destination,f.manifest.templates[0].path),'utf8'),'original factory-guitar-6\n');assert.deepEqual(JSON.parse(await readFile(join(f.destination,'manifest.json'),'utf8')),f.manifest);
  await assert.rejects(lstat(join(f.destination,'unlisted-private.txt')),/ENOENT/);
  await prepareLibrary({...f,checkOnly:true});
});

test('check-only rejects missing and stale resources without creating or repairing files',async t=>{
  const f=await fixture(t);await assert.rejects(prepareLibrary({...f,checkOnly:true}),/missing/i);await assert.rejects(lstat(join(f.destination,'manifest.json')),/ENOENT/);
  await prepareLibrary(f);const target=join(f.destination,f.manifest.examples[0].path);await writeFile(target,'stale');await assert.rejects(prepareLibrary({...f,checkOnly:true}),/stale|hash/i);assert.equal(await readFile(target,'utf8'),'stale');
});

test('rejects missing or corrupt source payloads before touching the destination',async t=>{
  const f=await fixture(t);await writeFile(join(f.source,f.manifest.examples[2].path),'corrupt');await assert.rejects(prepareLibrary(f),/hash/i);await assert.rejects(lstat(join(f.destination,'manifest.json')),/ENOENT/);
  await rm(join(f.source,f.manifest.examples[2].path));await assert.rejects(prepareLibrary(f),/missing/i);
});

test('rejects unsupported versions, unknown fields, missing inventory and duplicate IDs or paths',async t=>{
  const f=await fixture(t),original=structuredClone(f.manifest);
  const mutations=[m=>m.version=2,m=>m.format='OtherLibrary',m=>m.extra=true,m=>m.templates[0].unexpected=true,m=>m.templates.pop(),m=>m.documents.pop(),m=>m.examples[0].id=m.templates[0].id,m=>m.examples[0].path=m.templates[0].path,m=>m.templates[0].sha256='A'.repeat(64),m=>m.examples[0].origin='personal',m=>m.templates[0].license='proprietary'];
  for(const change of mutations){Object.assign(f.manifest,structuredClone(original));delete f.manifest.extra;change(f.manifest);await f.save();await assert.rejects(prepareLibrary(f));}
  await assert.rejects(lstat(join(f.destination,'manifest.json')),/ENOENT/);
});

test('rejects traversal, absolute, backslash, URL and unknown resource paths',async t=>{
  const f=await fixture(t);
  for(const path of ['../escape.tabplayer','templates/../escape.tabplayer','/escape.tabplayer','C:/escape.tabplayer','templates\\factory-guitar-6.tabplayer','https://example.invalid/a','templates/unknown.tabplayer']){f.manifest.templates[0].path=path;await f.save();await assert.rejects(prepareLibrary(f),/path|resource/i);}
  await assert.rejects(lstat(join(f.destination,'manifest.json')),/ENOENT/);
});

async function link(t,target,path,type){try{await symlink(target,path,type);return true;}catch(error){if(['EPERM','EACCES','ENOTSUP'].includes(error.code)){t.skip(`Symlinks unavailable: ${error.code}`);return false;}throw error;}}

test('rejects source directory symlinks instead of following them',async t=>{
  const f=await fixture(t),outside=join(f.directory,'outside');await mkdir(outside);await rm(join(f.source,'examples'),{recursive:true});if(!await link(t,outside,join(f.source,'examples'),'junction'))return;
  await assert.rejects(prepareLibrary(f),/symlink/i);await assert.rejects(lstat(join(f.destination,'manifest.json')),/ENOENT/);
});

test('rejects destination symlinks before writing any resource or outside file',async t=>{
  const f=await fixture(t),outside=join(f.directory,'outside');await mkdir(outside);await writeFile(join(outside,'sentinel.txt'),'keep');if(!await link(t,outside,join(f.destination,'templates'),'junction'))return;
  await assert.rejects(prepareLibrary(f),/symlink/i);assert.equal(await readFile(join(outside,'sentinel.txt'),'utf8'),'keep');await assert.rejects(lstat(join(f.destination,'manifest.json')),/ENOENT/);
});

test('rejects symlink payloads and manifests in source and destination',async t=>{
  const f=await fixture(t),outside=join(f.directory,'outside.txt');await writeFile(outside,'outside');const payload=join(f.source,f.manifest.templates[0].path);await rm(payload);if(!await link(t,outside,payload,'file'))return;
  await assert.rejects(prepareLibrary(f),/symlink/i);await rm(payload);await writeFile(payload,'original factory-guitar-6\n');await prepareLibrary(f);
  const output=join(f.destination,'CC0-1.0.txt');await rm(output);if(!await link(t,outside,output,'file'))return;await assert.rejects(prepareLibrary(f),/symlink/i);assert.equal(await readFile(outside,'utf8'),'outside');
  await rm(join(f.source,'manifest.json'));if(!await link(t,outside,join(f.source,'manifest.json'),'file'))return;await assert.rejects(prepareLibrary(f),/symlink/i);
});

test('rejects overlapping source and destination and symlink roots',async t=>{
  const f=await fixture(t);await assert.rejects(prepareLibrary({...f,destination:f.source}),/overlap/i);await assert.rejects(prepareLibrary({...f,destination:join(f.source,'prepared')}),/overlap/i);
  const alias=join(f.directory,'alias');if(!await link(t,f.source,alias,'junction'))return;await assert.rejects(prepareLibrary({...f,source:alias}),/symlink/i);await assert.rejects(prepareLibrary({...f,destination:alias}),/symlink/i);
});

test('prepares and verifies the authored source inventory into a new temporary destination',async t=>{
  const f=await fixture(t),source=fileURLToPath(new URL('../assets/library/',import.meta.url)),destination=join(f.directory,'nested','authored');
  await assert.rejects(prepareLibrary({source,destination,checkOnly:true}),/missing/i);await assert.rejects(lstat(destination),/ENOENT/);
  const result=await prepareLibrary({source,destination});assert.equal(result.files.length,16);assert.equal(result.manifest.templates.length,10);assert.equal(result.manifest.examples.length,3);await prepareLibrary({source,destination,checkOnly:true});
  for(const entry of [...result.manifest.templates,...result.manifest.examples,...result.manifest.documents])assert.equal(hash(await readFile(join(destination,entry.path))),entry.sha256);
});
