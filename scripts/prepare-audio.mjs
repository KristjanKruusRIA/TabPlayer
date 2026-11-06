import { mkdir, readFile, writeFile, copyFile, rename } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const preparationFingerprint = (config, script) => sha256(JSON.stringify(config)+script.replaceAll('\r\n','\n'));
function confined(root, name) {
  if (isAbsolute(name) || /^[A-Za-z]:/.test(name)) throw new Error(`Sample path escapes source: ${name}`);
  const path = resolve(root, name.replaceAll('\\', '/'));
  const rel = relative(resolve(root), path);
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) throw new Error(`Path escapes source: ${name}`);
  return path;
}
const allowed = new Set(['sample','lokey','hikey','key','pitch_keycenter','lovel','hivel','seq_length','seq_position','volume','ampeg_attack','ampeg_release','loop_mode','loop_start','loop_end','trigger','pitch_keytrack','rt_decay','transpose','bend_up','bend_down','lfo02_pitch_oncc113','group','off_by','amplitude_curvecc29']);
const numeric = (value, fallback) => value === undefined ? fallback : Number(value);

// Resolve selected centre maps, including inherited SFZ scope. Controller-generated
// unison, vibrato, muting, and pitched feedback are implemented by the native renderer.
export async function resolveSfz(sourceRoot, entry, defaults = {}) {
  const inputs = new Set();
  const active = new Set();
  async function expand(path) {
    const full = confined(sourceRoot, path);
    if (active.has(full)) throw new Error(`Recursive SFZ include: ${path}`);
    active.add(full); inputs.add(relative(sourceRoot,full).replaceAll('\\','/'));
    const text = (await readFile(full,'utf8')).replace(/\/\/[^\r\n]*/g,'');
    let expanded = '', last = 0;
    for (const match of text.matchAll(/#include\s+"([^"]+)"/g)) {
      expanded += text.slice(last,match.index);
      expanded += await expand(relative(sourceRoot,confined(sourceRoot,join(dirname(path),match[1]))));
      last = match.index + match[0].length;
    }
    active.delete(full);
    return expanded + text.slice(last);
  }
  const text = await expand(entry);
  let global = {...defaults.opcodes}, master = {}, group = {}, region = null, scope = global;
  const regions=[];
  function flush() {
    if (!region) return;
    const op={...global,...master,...group,...region};
    if (!op.sample) throw new Error(`Region has no sample in ${entry}`);
    if (op.sample.startsWith('*')) throw new Error(`Synthetic SFZ samples cannot replace recorded voices: ${op.sample}`);
    const base=defaults.sampleBasePath ?? dirname(entry);
    const full=confined(sourceRoot,join(base,op.sample));
    const root=numeric(op.pitch_keycenter,numeric(op.key,60));
    const gainCap=Object.entries(op).find(([key,value])=>/^amp_velcurve_\d+$/.test(key)&&Number(value)===1);
    const item={sourcePath:relative(sourceRoot,full).replaceAll('\\','/'), rootKey:root,
      keyLow:numeric(op.lokey,numeric(op.key,0)),keyHigh:numeric(op.hikey,numeric(op.key,127)),
      velocityLow:numeric(op.lovel,1),velocityHigh:numeric(op.hivel,127),articulation:defaults.articulation ?? 'picked',
      variant:numeric(op.seq_position,1),sequenceLength:numeric(op.seq_length,1),
      loopStart:op.loop_start===undefined?null:Number(op.loop_start),loopEnd:op.loop_end===undefined?null:Number(op.loop_end),
      attackSeconds:numeric(op.ampeg_attack,0),releaseSeconds:numeric(op.ampeg_release,0.1),gainDb:numeric(op.volume,0),
      trigger:op.trigger??'attack',pitchKeytrack:numeric(op.pitch_keytrack,100),
      velocityGainHigh:gainCap?Number(gainCap[0].slice(13)):127,
      releaseDecayDbPerSecond:numeric(op.rt_decay,0),loopMode:op.loop_mode??'no_loop'};
    if (numeric(op.transpose,0)!==0) throw new Error(`Unsupported recorded-region transpose in ${entry}`);
    for(const [key,value] of Object.entries(item)) if(typeof value==='number'&&!Number.isFinite(value))throw new Error(`Invalid ${key} in ${entry}`);
    for(const key of ['rootKey','keyLow','keyHigh','velocityLow','velocityHigh','velocityGainHigh']) if(!Number.isInteger(item[key])||item[key]<0||item[key]>127)throw new Error(`Invalid ${key} in ${entry}`);
    if(item.keyLow>item.keyHigh||item.velocityLow>item.velocityHigh||item.variant<1||item.variant>item.sequenceLength||item.attackSeconds<0||item.releaseSeconds<0)throw new Error(`Invalid region bounds in ${entry}`);
    regions.push(item);
  }
  for(const match of text.matchAll(/<([a-z]+)>|([\w]+)\s*=\s*([^\s<]+)/gi)) {
    if(match[1]) {
      flush(); region=null;
      switch(match[1].toLowerCase()) {
        case 'global': global={...defaults.opcodes};master={};group={};scope=global;break;
        case 'master': master={};group={};scope=master;break;
        case 'group': group={};scope=group;break;
        case 'region': region={};scope=region;break;
        default:throw new Error(`Unhandled SFZ scope ${match[1]} in ${entry}`);
      }
    } else {
      const key=match[2].toLowerCase();
      if(!allowed.has(key)&&!/^amp_velcurve_\d+$/.test(key))throw new Error(`Unhandled mapping opcode ${key} in ${entry}`);
      scope[key]=match[3];
    }
  }
  flush();
  Object.defineProperty(regions,'inputs',{value:[...inputs]});
  return regions;
}

function wavFrames(bytes) {
  if(bytes.length<44||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE')throw new Error('Corrupt recorded WAV sample');
  let block=0, frames=0, loop=null;
  for(let p=12;p+8<=bytes.length;) {
    const size=bytes.readUInt32LE(p+4),start=p+8,end=start+size;
    if(end>bytes.length)throw new Error('Corrupt truncated WAV sample');
    const type=bytes.toString('ascii',p,p+4);
    if(type==='fmt '&&size>=16)block=bytes.readUInt16LE(start+12);
    if(type==='data'&&block)frames=size/block;
    if(type==='smpl'&&size>=60&&bytes.readUInt32LE(start+28)>0)loop=[bytes.readUInt32LE(start+44),bytes.readUInt32LE(start+48)+1];
    p=end+(size&1);
  }
  if(!Number.isInteger(frames)||frames<1)throw new Error('Corrupt WAV frame count');
  return {frames,loop};
}

// FLAC recordings ship unchanged; STREAMINFO gives the frame count used to check loops.
function flacFrames(bytes) {
  if(bytes.length<42||bytes.toString('ascii',0,4)!=='fLaC'||(bytes[4]&0x7f)!==0||bytes.readUIntBE(5,3)<34)throw new Error('Corrupt recorded FLAC sample');
  const frames=(bytes[21]&0x0f)*2**32+bytes.readUInt32BE(22);
  if(!Number.isSafeInteger(frames)||frames<1)throw new Error('Corrupt FLAC frame count');
  return {frames,loop:null};
}

function normalizeWave(bytes) {
  let block=0,pcm24=false;
  for(let p=12;p+8<=bytes.length;) {
    const size=bytes.readUInt32LE(p+4),start=p+8,end=start+size;
    if(end>bytes.length)throw new Error('Corrupt truncated WAV sample');
    const type=bytes.toString('ascii',p,p+4);
    if(type==='fmt '&&size>=16) {block=bytes.readUInt16LE(start+12);pcm24=bytes.readUInt16LE(start)===1&&bytes.readUInt16LE(start+14)===24;}
    if(type==='data'&&block&&size%block) {
      const remainder=size%block;
      if(!pcm24||bytes.subarray(end-remainder,end).some(v=>v!==0))throw new Error('Corrupt partial PCM frame');
      const dataSize=size-remainder,header=Buffer.from(bytes.subarray(p,start));header.writeUInt32LE(dataSize,4);
      const result=Buffer.concat([bytes.subarray(0,p),header,bytes.subarray(start,start+dataSize),...(dataSize&1?[Buffer.alloc(1)]:[]),bytes.subarray(end+(size&1))]);
      result.writeUInt32LE(result.length-8,4);return result;
    }
    p=end+(size&1);
  }
  return bytes;
}

export async function prepareLibrary({sourceRoot, outputRoot, source, instruments, inventory}) {
  const expected=inventory?new Map(inventory.map(item=>[item.path,item])):null;
  const observed=new Map(),samples=new Map(),parsed=[];
  async function verified(path) {
    const bytes=await readFile(confined(sourceRoot,path));
    const item={path,sha256:sha256(bytes),size:bytes.length};
    if(expected) {
      const prior=expected.get(path);
      if(!prior||prior.sha256!==item.sha256||prior.size!==item.size)throw new Error(`Pinned source hash mismatch: ${source.id}/${path}`);
    }
    observed.set(path,item);return bytes;
  }
  for(const instrument of instruments) {
    const regions=[];
    for(const map of instrument.maps) {
      const mapped=await resolveSfz(sourceRoot,map.path,{...map,sampleBasePath:map.sampleBasePath??'Programs'});
      for(const path of mapped.inputs)await verified(path);
      for(const region of mapped) {
        const id=`${source.id}:${region.sourcePath}`;
        let info=samples.get(id);
        if(!info) {
          const original=await verified(region.sourcePath),flac=/\.flac$/i.test(region.sourcePath);
          const bytes=flac?original:normalizeWave(original),wave=flac?flacFrames(bytes):wavFrames(bytes);
          const path=`samples/${source.id}/${region.sourcePath}`;
          await mkdir(dirname(confined(outputRoot,path)),{recursive:true});
          await writeFile(confined(outputRoot,path),bytes);
          info={id,path,sha256:sha256(bytes),size:bytes.length,sourceSha256:sha256(original),...wave};samples.set(id,info);
        }
        if(region.loopMode==='loop_continuous') {
          region.loopStart??=info.loop?.[0]??0;region.loopEnd??=info.loop?.[1]??info.frames;
        }
        if(region.loopStart!==null&&(region.loopStart<0||region.loopEnd===null||region.loopEnd<=region.loopStart||region.loopEnd>info.frames))throw new Error(`Invalid sample loop: ${id}`);
        const {sourcePath,loopMode,...mapping}=region;
        regions.push({sampleId:id,...mapping});
      }
    }
    parsed.push({id:instrument.id,name:instrument.name,sourceId:source.id,regions});
  }
  const license=await verified(source.licensePath);
  await mkdir(join(outputRoot,'licenses'),{recursive:true});
  await writeFile(join(outputRoot,`licenses/${source.id}.txt`),license);
  return {instruments:parsed,samples:[...samples.values()].map(({frames,loop,...item})=>item),inventory:[...observed.values()].sort((a,b)=>a.path.localeCompare(b.path)),licenseSha256:sha256(license)};
}

// An archive source is one pinned download. Its bounded, flat entries are extracted on
// demand; the app-owned map and license come from assets/audio/<localRoot>.
const archiveLimits={entries:64,entryBytes:16*1024*1024,totalBytes:64*1024*1024};
const archives=new Map();
export function extractArchive(bytes, limits=archiveLimits) {
  let count=0,total=0;
  const files=unzipSync(new Uint8Array(bytes),{filter(file) {
    if(file.name.endsWith('/'))return false;
    if(!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(file.name))throw new Error(`Unexpected archive entry: ${file.name}`);
    count++;total+=file.originalSize;
    if(count>limits.entries||file.originalSize>limits.entryBytes||total>limits.totalBytes)throw new Error('Audio archive expands beyond its limits');
    return true;
  }});
  const result=new Map();
  for(const [name,data] of Object.entries(files)) {
    if(data.length>limits.entryBytes)throw new Error('Audio archive entry expands beyond its limits');
    result.set(name,Buffer.from(data));
  }
  return result;
}
async function downloadPinned(url, sha, size) {
  const response=await fetch(url,{signal:AbortSignal.timeout(120000)});
  if(!response.ok)throw new Error(`Audio source download failed (${response.status}): ${url}`);
  // An encoded response declares its compressed length, so only a plain one is checked up front.
  const declared=Number(response.headers.get('content-length'));
  if(!response.headers.get('content-encoding')&&declared&&declared!==size)throw new Error(`Downloaded archive size mismatch: ${url}`);
  const chunks=[];let received=0;
  for await(const chunk of response.body) {received+=chunk.length;if(received>size)throw new Error(`Downloaded archive size mismatch: ${url}`);chunks.push(chunk);}
  const bytes=Buffer.concat(chunks);
  if(bytes.length!==size||sha256(bytes)!==sha)throw new Error(`Downloaded archive hash mismatch: ${url}`);
  return bytes;
}
async function loadArchive(source, cacheRoot, offline) {
  const path=`${cacheRoot}.zip`;
  let bytes=null;
  try {bytes=await readFile(path);}catch(error) {if(error.code!=='ENOENT')throw error;}
  if(bytes&&(bytes.length!==source.archiveSize||sha256(bytes)!==source.revision)) {
    if(offline)throw new Error(`Pinned archive hash mismatch: ${source.id}; delete ${path} or run npm run prepare:audio`);
    bytes=null;
  }
  if(!bytes) {
    if(offline)throw new Error(`Missing offline source ${source.id}; run npm run prepare:audio`);
    bytes=await downloadPinned(source.archiveUrl,source.revision,source.archiveSize);
    // Written beside and renamed, so an interrupted run never leaves a truncated archive.
    await mkdir(dirname(path),{recursive:true});await writeFile(`${path}.partial`,bytes);await rename(`${path}.partial`,path);
  }
  return extractArchive(bytes);
}
// One download per run: the promise is stored before any await, so parallel sample workers share it.
function archiveEntries(source, cacheRoot, offline) {
  if(!archives.has(source.id))archives.set(source.id,loadArchive(source,cacheRoot,offline));
  return archives.get(source.id);
}
async function localBytes(source, path, root) {
  if(!source.localRoot)return null;
  try {return await readFile(confined(join(root,'assets/audio',source.localRoot),path));}catch(error) {if(error.code!=='ENOENT')throw error;return null;}
}

async function fetchSource(source, path, cacheRoot, inventory, offline, root) {
  const destination=confined(cacheRoot,path);
  // App-owned files are copied every time, so an edited map is never served stale from the cache.
  const owned=await localBytes(source,path,root);
  // An archive entry is always taken from the verified archive, never from a loose cached copy.
  const archived=!owned&&source.kind==='archive'?(await archiveEntries(source,cacheRoot,offline)).get(path):null;
  if(source.kind==='archive'&&!owned&&!archived)throw new Error(`Archive source has no ${source.id}/${path}`);
  const fresh=owned??archived;
  if(fresh) {
    const pinned=inventory?.find(item=>item.path===path);
    if(archived&&pinned&&(pinned.sha256!==sha256(fresh)||pinned.size!==fresh.length))throw new Error(`Pinned source hash mismatch: ${path}`);
    await mkdir(dirname(destination),{recursive:true});await writeFile(destination,fresh);return;
  }
  try {
    const bytes=await readFile(destination);
    const pinned=inventory?.find(item=>item.path===path);
    if(pinned&&(pinned.sha256!==sha256(bytes)||pinned.size!==bytes.length))throw new Error(`Pinned source hash mismatch: ${path}`);
    return;
  }catch(error) {if(error.code!=='ENOENT')throw error;}
  if(offline)throw new Error(`Missing offline source ${source.id}/${path}; run npm run prepare:audio`);
  const url=`https://raw.githubusercontent.com/${source.repository}/${source.revision}/${path.split('/').map(encodeURIComponent).join('/')}`;
  const response=await fetch(url);
  if(!response.ok)throw new Error(`Audio source download failed (${response.status}): ${url}`);
  const bytes=Buffer.from(await response.arrayBuffer());
  const pinned=inventory?.find(item=>item.path===path);
  if(pinned&&(pinned.sha256!==sha256(bytes)||pinned.size!==bytes.length))throw new Error(`Downloaded source hash mismatch: ${path}`);
  await mkdir(dirname(destination),{recursive:true});await writeFile(destination,bytes);
}

export async function prepareAudio({recordInventory=false,offline=false}={}) {
  const root=fileURLToPath(new URL('../',import.meta.url));
  const config=JSON.parse(await readFile(join(root,'assets/audio/sources.json'),'utf8'));
  const outputRoot=join(root,'src-tauri/resources/audio');
  // App-owned maps and licenses are part of the preparation, so editing one prepares again.
  let owned='';
  for(const source of config.sources.filter(item=>item.localRoot))for(const path of [source.licensePath,...source.instruments.flatMap(i=>i.maps.map(m=>m.path))])owned+=`
${path}
`+await readFile(confined(join(root,'assets/audio',source.localRoot),path),'utf8');
  const preparationId=preparationFingerprint(config,await readFile(fileURLToPath(import.meta.url),'utf8')+owned);
  if(!recordInventory)try {
    const manifest=JSON.parse(await readFile(join(outputRoot,'manifest.json'),'utf8'));
    if(manifest.preparationId===preparationId) {
      if(manifest.soundFont.sha256!==config.soundFont.sha256)throw new Error('Bundled GM SoundFont pin mismatch');
      for(const source of config.sources) {
        const pins=JSON.parse(await readFile(join(root,'assets/audio',source.inventoryPath),'utf8'));
        const hashes=new Map(pins.map(item=>[item.path,item.sha256]));
        const provenance=manifest.sources.find(item=>item.id===source.id);
        if(!provenance||provenance.revision!==source.revision||provenance.licenseSha256!==hashes.get(source.licensePath))throw new Error(`Bundled audio provenance mismatch: ${source.id}`);
        for(const sample of manifest.samples.filter(item=>item.id.startsWith(`${source.id}:`)))if(sample.sourceSha256!==hashes.get(sample.id.slice(source.id.length+1)))throw new Error(`Bundled audio source hash mismatch: ${sample.id}`);
      }
      for(const item of [...manifest.samples,manifest.soundFont,...manifest.sources.map(s=>({path:s.licensePath,sha256:s.licenseSha256}))]) {
        const bytes=await readFile(confined(outputRoot,item.path));
        if(sha256(bytes)!==item.sha256)throw new Error(`Bundled audio hash mismatch: ${item.path}`);
      }
      console.log(`Verified offline audio: ${manifest.instruments.reduce((n,i)=>n+i.regions.length,0)} regions, ${manifest.samples.length} samples`);return manifest;
    }
  }catch(error){if(error.code!=='ENOENT')throw error;}
  const manifest={schemaVersion:1,preparationId,sources:[],instruments:[],samples:[],soundFont:null};
  for(const source of config.sources) {
    const cacheRoot=join(root,'.analysis/expansion/audio-assets',source.id);
    const inventoryPath=join(root,'assets/audio',source.inventoryPath);
    const inventory=recordInventory?null:JSON.parse(await readFile(inventoryPath,'utf8'));
    const wanted=new Set([source.licensePath,...source.instruments.flatMap(i=>i.maps.map(m=>m.path))]);
    // Chosen maps use no includes today; recursively fetch includes for future pinned maps.
    for(const path of wanted) {
      await fetchSource(source,path,cacheRoot,inventory,offline,root);
      if(path.endsWith('.sfz'))for(const m of (await readFile(confined(cacheRoot,path),'utf8')).matchAll(/#include\s+"([^"]+)"/g))wanted.add(relative(cacheRoot,confined(cacheRoot,join(dirname(path),m[1]))).replaceAll('\\','/'));
    }
    const samples=new Set();
    for(const i of source.instruments)for(const m of i.maps)for(const r of await resolveSfz(cacheRoot,m.path,{...m,sampleBasePath:m.sampleBasePath??'Programs'}))samples.add(r.sourcePath);
    const entries=[...samples];let next=0,done=0;
    await Promise.all(Array.from({length:8},async()=>{while(next<entries.length){const path=entries[next++];await fetchSource(source,path,cacheRoot,inventory,offline,root);done++;if(done%200===0)console.log(`${source.id}: ${done}/${entries.length} samples ready`);}}));
    const result=await prepareLibrary({sourceRoot:cacheRoot,outputRoot,source,instruments:source.instruments,inventory});
    if(recordInventory) {await mkdir(dirname(inventoryPath),{recursive:true});await writeFile(inventoryPath,JSON.stringify(result.inventory,null,2)+'\n');await mkdir(join(root,'assets/audio/licenses'),{recursive:true});await copyFile(confined(cacheRoot,source.licensePath),join(root,`assets/audio/licenses/${source.id}.txt`));}
    manifest.sources.push({id:source.id,repository:source.repository,revision:source.revision,license:source.license,licensePath:`licenses/${source.id}.txt`,licenseSha256:result.licenseSha256});
    // An extending source adds recorded layers to a voice another source already defines.
    for(const instrument of result.instruments) {
      const configured=source.instruments.find(item=>item.id===instrument.id);
      if(!configured.extends) {manifest.instruments.push(instrument);continue;}
      const base=manifest.instruments.find(item=>item.id===instrument.id);
      if(!base)throw new Error(`${source.id} extends unknown instrument ${instrument.id}`);
      base.regions.push(...instrument.regions);
    }
    manifest.samples.push(...result.samples);
    console.log(`${source.id}: ${result.instruments.reduce((n,i)=>n+i.regions.length,0)} regions, ${result.samples.length} recorded samples`);
  }
  const packageRoot=join(root,'node_modules',config.soundFont.package);
  const sfPackage=JSON.parse(await readFile(join(packageRoot,'package.json'),'utf8'));
  if(sfPackage.version!==config.soundFont.version)throw new Error('GM SoundFont package version does not match its pin');
  const sfPath=join(packageRoot,config.soundFont.path);
  const sf=await readFile(sfPath);
  if(sha256(sf)!==config.soundFont.sha256)throw new Error('GM SoundFont source hash does not match its pin');
  await mkdir(join(outputRoot,'soundfont'),{recursive:true});
  await copyFile(sfPath,join(outputRoot,'soundfont/sonivox.sf2'));
  await copyFile(join(dirname(sfPath),'LICENSE'),join(outputRoot,'soundfont/LICENSE'));
  await copyFile(join(root,'legal/Apache-2.0.txt'),join(outputRoot,'licenses/Apache-2.0.txt'));
  manifest.soundFont={path:'soundfont/sonivox.sf2',sha256:sha256(sf),size:sf.length};
  await writeFile(join(outputRoot,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  console.log(`Prepared ${manifest.samples.length} recorded samples offline at ${outputRoot}`);return manifest;
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  prepareAudio({recordInventory:process.argv.includes('--record-inventory'),offline:process.argv.includes('--offline')}).catch(error=>{console.error(error.message);process.exitCode=1;});
}
