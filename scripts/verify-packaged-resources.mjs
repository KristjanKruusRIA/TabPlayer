import { readFile, readdir, realpath, stat, mkdir, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareLibrary } from './prepare-library.mjs';

const repository=fileURLToPath(new URL('../',import.meta.url));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function files(directory) {
  const result=[];
  for(const entry of await readdir(directory,{withFileTypes:true})) {
    const path=join(directory,entry.name);
    if(entry.isDirectory())result.push(...await files(path));
    else if(entry.isFile())result.push(path);
    else if(entry.isSymbolicLink())continue; // System-library links are not traversed.
  }
  return result;
}
async function checkedPath(root,path) {
  if(typeof path!=='string'||isAbsolute(path)||path.includes('\\')||path.includes(':')||path.split('/').some(part=>!part||part==='.'||part==='..'))throw new Error(`Invalid packaged resource path: ${path}`);
  const actual=await realpath(join(root,path)),base=await realpath(root),rel=relative(base,actual);
  if(isAbsolute(rel)||rel==='..'||rel.startsWith('../')||rel.startsWith('..\\'))throw new Error(`Packaged resource path escapes root: ${path}`);
  return actual;
}
async function fileHash(path) {
  const hash=createHash('sha256');
  for await(const bytes of createReadStream(path))hash.update(bytes);
  return hash.digest('hex');
}
async function verifyHash(root,path,sha256,size) {
  const actual=await checkedPath(root,path);
  if(size!==undefined&&(await stat(actual)).size!==size)throw new Error(`Packaged resource size mismatch: ${path}`);
  if(await fileHash(actual)!==sha256)throw new Error(`Packaged resource hash mismatch: ${path}`);
}
async function verifyLibraryInventory(root,allowed) {
  const paths=[...allowed];
  async function visit(directory,prefix='') {
    for(const entry of await readdir(directory,{withFileTypes:true})) {
      const path=prefix?`${prefix}/${entry.name}`:entry.name;
      if(entry.isDirectory()&&paths.some(known=>known.startsWith(`${path}/`)))await visit(join(directory,entry.name),path);
      else if(!entry.isFile()||!allowed.has(path))throw new Error(`Unexpected library resource: ${path}`);
    }
  }
  await visit(root);
}

/** Inspect extracted package bytes only. No process launch or network access. */
export async function verifyPackage({packageRoot,referenceRoot=join(repository,'src-tauri/resources/audio'),cabinetRoot=join(repository,'src-tauri/resources/cabinet-irs'),sourceRoot=repository}) {
  const packageFiles=await files(packageRoot);
  const manifests=packageFiles.filter(path=>basename(path)==='manifest.json'&&basename(dirname(path))==='audio');
  if(manifests.length!==1)throw new Error(`Expected one extracted audio manifest, found ${manifests.length}`);
  const audioRoot=dirname(manifests[0]);
  const libraryManifests=packageFiles.filter(path=>basename(path)==='manifest.json'&&basename(dirname(path))==='library');
  if(libraryManifests.length!==1)throw new Error(`Expected one extracted library manifest, found ${libraryManifests.length}`);
  const libraryRoot=dirname(libraryManifests[0]);
  const library=await prepareLibrary({source:join(sourceRoot,'assets/library'),destination:libraryRoot,checkOnly:true});
  const libraryFiles=new Set(library.files);
  await verifyLibraryInventory(libraryRoot,libraryFiles);
  const cabinetManifests=packageFiles.filter(path=>basename(path)==='manifest.json'&&basename(dirname(path))==='cabinet-irs');
  if(cabinetManifests.length!==1)throw new Error(`Expected one extracted cabinet IR manifest, found ${cabinetManifests.length}`);
  const irRoot=dirname(cabinetManifests[0]);
  const irBytes=await readFile(cabinetManifests[0]),irReference=await readFile(join(cabinetRoot,'manifest.json'));
  if(digest(irBytes)!==digest(irReference))throw new Error('Packaged cabinet IR manifest does not match the bundled reference');
  const irManifest=JSON.parse(irBytes);
  if(irManifest.schemaVersion!==1||irManifest.license!=='CC0-1.0'||typeof irManifest.licenseFile!=='string'||!Array.isArray(irManifest.irs))throw new Error('Invalid packaged cabinet IR manifest');
  const irAllowed=new Set(['manifest.json','README.txt',irManifest.licenseFile]),irIds=new Set();
  for(const ir of irManifest.irs) {
    if(typeof ir.file!=='string'||!ir.file.endsWith('.wav')||ir.file!==basename(ir.file)||/[\\/:]/.test(ir.file))throw new Error(`Invalid packaged cabinet IR path: ${ir.file}`);
    if(typeof ir.id!=='string'||!/^[a-f0-9]{32}$/.test(ir.id))throw new Error(`Invalid packaged cabinet IR identity: ${ir.file}`);
    if(typeof ir.sha256!=='string'||!/^[a-f0-9]{64}$/.test(ir.sha256)||!ir.sha256.startsWith(ir.id))throw new Error(`Invalid packaged cabinet IR hash: ${ir.file}`);
    if(irIds.has(ir.id))throw new Error(`Duplicate packaged cabinet IR: ${ir.id}`);
    irIds.add(ir.id);
    await verifyHash(irRoot,ir.file,ir.sha256,ir.size);irAllowed.add(ir.file);
  }
  for(const path of ['README.txt',irManifest.licenseFile])await verifyHash(irRoot,path,await fileHash(await checkedPath(cabinetRoot,path)));
  for(const path of packageFiles) {
    const rel=relative(irRoot,path).replaceAll('\\','/');
    if(rel!=='..'&&!rel.startsWith('../')&&!isAbsolute(rel)&&!irAllowed.has(rel))throw new Error(`Unexpected cabinet IR resource: ${rel}`);
  }
  const bytes=await readFile(manifests[0]),reference=await readFile(join(referenceRoot,'manifest.json'));
  if(digest(bytes)!==digest(reference))throw new Error('Packaged audio manifest does not match the prepared offline reference');
  const manifest=JSON.parse(bytes),config=JSON.parse(await readFile(join(sourceRoot,'assets/audio/sources.json'),'utf8'));
  if(manifest.schemaVersion!==1||!Array.isArray(manifest.samples)||!Array.isArray(manifest.instruments))throw new Error('Invalid packaged audio manifest');
  const allowed=new Set(['manifest.json','licenses/Apache-2.0.txt','soundfont/LICENSE']);
  const sampleIds=new Set(manifest.samples.map(item=>item.id));
  const sourceRevisions={};
  for(const source of config.sources) {
    const packaged=manifest.sources.find(item=>item.id===source.id);
    const pins=new Map(JSON.parse(await readFile(join(sourceRoot,'assets/audio',source.inventoryPath),'utf8')).map(item=>[item.path,item.sha256]));
    if(!packaged||packaged.repository!==source.repository||packaged.revision!==source.revision||packaged.license!==source.license||packaged.licenseSha256!==pins.get(source.licensePath))throw new Error(`Packaged source/license pin mismatch: ${source.id}`);
    await verifyHash(audioRoot,packaged.licensePath,packaged.licenseSha256);allowed.add(packaged.licensePath);
    sourceRevisions[source.id]=source.revision;
    for(const sample of manifest.samples.filter(item=>item.id.startsWith(`${source.id}:`)))if(sample.sourceSha256!==pins.get(sample.id.slice(source.id.length+1)))throw new Error(`Packaged sample source pin mismatch: ${sample.id}`);
  }
  if(manifest.soundFont.sha256!==config.soundFont.sha256)throw new Error('Packaged GM SoundFont pin mismatch');
  for(const sample of [...manifest.samples,manifest.soundFont]) {
    await verifyHash(audioRoot,sample.path,sample.sha256,sample.size);allowed.add(sample.path);
  }
  for(const path of ['licenses/Apache-2.0.txt','soundfont/LICENSE']) {
    await verifyHash(audioRoot,path,await fileHash(await checkedPath(referenceRoot,path)));
  }
  let regionCount=0;
  for(const instrument of manifest.instruments)for(const region of instrument.regions) {
    if(!sampleIds.has(region.sampleId))throw new Error(`Packaged region has no sample: ${region.sampleId}`);
    regionCount++;
  }
  for(const path of packageFiles) {
    const rel=relative(audioRoot,path).replaceAll('\\','/');
    if(rel!== '..'&&!rel.startsWith('../')&&!isAbsolute(rel)) {
      if(!allowed.has(rel))throw new Error(`Unexpected audio resource: ${rel}`);
    }else {
      const libraryRelative=relative(libraryRoot,path).replaceAll('\\','/');
      if(libraryRelative!=='..'&&!libraryRelative.startsWith('../')&&!isAbsolute(libraryRelative)) {
        if(!libraryFiles.has(libraryRelative))throw new Error(`Unexpected library resource: ${libraryRelative}`);
      }else {
        const irRelative=relative(irRoot,path).replaceAll('\\','/');
        if(irRelative!=='..'&&!irRelative.startsWith('../')&&!isAbsolute(irRelative)) {
          if(!irAllowed.has(irRelative))throw new Error(`Unexpected cabinet IR resource: ${irRelative}`);
        }else if(/\.(gp[345]?|gpx|tabplayer|pdf|wav|mp3|flac|ogg)$/i.test(path))throw new Error(`Unexpected score/private media in package: ${relative(packageRoot,path)}`);
      }
    }
  }
  return {scope:'extracted packaged resource verification; native audition, print and installer lifecycle remain separate',platform:process.platform,architecture:process.arch,manifestSha256:digest(bytes),sampleCount:manifest.samples.length,regionCount,encodedSampleBytes:manifest.samples.reduce((total,item)=>total+item.size,0),sourceRevisions,library:{manifestSha256:await fileHash(libraryManifests[0]),templateCount:library.manifest.templates.length,exampleCount:library.manifest.examples.length,fileCount:library.files.length},cabinetIrs:{manifestSha256:digest(irBytes),count:irManifest.irs.length}};
}

export async function packageArtifacts(bundleRoot,formats) {
  const artifacts=(await files(bundleRoot)).filter(path=>formats.includes(extname(path).slice(1).toLowerCase()));
  for(const format of formats)if(!artifacts.some(path=>extname(path).slice(1).toLowerCase()===format))throw new Error(`No ${format} package was produced`);
  return Promise.all(artifacts.map(async path=>({path:relative(bundleRoot,path).replaceAll('\\','/'),size:(await stat(path)).size,sha256:await fileHash(path)})));
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const args=process.argv.slice(2),option=name=>args[args.indexOf(name)+1];
  const run=async()=> {
    if(!args.includes('--package-root'))throw new Error('Provide --package-root with an extracted installer/application directory');
    const report=await verifyPackage({packageRoot:option('--package-root'),referenceRoot:args.includes('--reference-root')?option('--reference-root'):undefined});
    if(args.includes('--bundle-root'))report.artifacts=await packageArtifacts(option('--bundle-root'),option('--formats').split(',').map(value=>value.toLowerCase()));
    if(args.includes('--report')) {const path=option('--report');await mkdir(dirname(path),{recursive:true});await writeFile(path,JSON.stringify(report,null,2)+'\n');}
    console.log(JSON.stringify(report,null,2));
  };
  run().catch(error=>{console.error(error.message);process.exitCode=1;});
}
