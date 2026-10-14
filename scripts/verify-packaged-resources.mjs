import { readFile, readdir, realpath, stat, mkdir, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

/** Inspect extracted package bytes only. No process launch or network access. */
export async function verifyPackage({packageRoot,referenceRoot=join(repository,'src-tauri/resources/audio'),sourceRoot=repository}) {
  const packageFiles=await files(packageRoot);
  const manifests=packageFiles.filter(path=>basename(path)==='manifest.json'&&basename(dirname(path))==='audio');
  if(manifests.length!==1)throw new Error(`Expected one extracted audio manifest, found ${manifests.length}`);
  const audioRoot=dirname(manifests[0]);
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
    }else if(/\.(gp[345]?|gpx|tabplayer|pdf|wav|mp3|flac|ogg)$/i.test(path))throw new Error(`Unexpected score/private media in package: ${relative(packageRoot,path)}`);
  }
  return {scope:'extracted packaged resource verification; native audition, print and installer lifecycle remain separate',platform:process.platform,architecture:process.arch,manifestSha256:digest(bytes),sampleCount:manifest.samples.length,regionCount,encodedSampleBytes:manifest.samples.reduce((total,item)=>total+item.size,0),sourceRevisions};
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
