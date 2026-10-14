import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

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
          const original=await verified(region.sourcePath),bytes=normalizeWave(original),wave=wavFrames(bytes);
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

async function fetchSource(source, path, cacheRoot, inventory, offline) {
  const destination=confined(cacheRoot,path);
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
  const preparationId=preparationFingerprint(config,await readFile(fileURLToPath(import.meta.url),'utf8'));
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
      await fetchSource(source,path,cacheRoot,inventory,offline);
      if(path.endsWith('.sfz'))for(const m of (await readFile(confined(cacheRoot,path),'utf8')).matchAll(/#include\s+"([^"]+)"/g))wanted.add(relative(cacheRoot,confined(cacheRoot,join(dirname(path),m[1]))).replaceAll('\\','/'));
    }
    const samples=new Set();
    for(const i of source.instruments)for(const m of i.maps)for(const r of await resolveSfz(cacheRoot,m.path,{...m,sampleBasePath:m.sampleBasePath??'Programs'}))samples.add(r.sourcePath);
    const entries=[...samples];let next=0,done=0;
    await Promise.all(Array.from({length:8},async()=>{while(next<entries.length){const path=entries[next++];await fetchSource(source,path,cacheRoot,inventory,offline);done++;if(done%200===0)console.log(`${source.id}: ${done}/${entries.length} samples ready`);}}));
    const result=await prepareLibrary({sourceRoot:cacheRoot,outputRoot,source,instruments:source.instruments,inventory});
    if(recordInventory) {await mkdir(dirname(inventoryPath),{recursive:true});await writeFile(inventoryPath,JSON.stringify(result.inventory,null,2)+'\n');await mkdir(join(root,'assets/audio/licenses'),{recursive:true});await copyFile(confined(cacheRoot,source.licensePath),join(root,`assets/audio/licenses/${source.id}.txt`));}
    manifest.sources.push({id:source.id,repository:source.repository,revision:source.revision,license:source.license,licensePath:`licenses/${source.id}.txt`,licenseSha256:result.licenseSha256});
    manifest.instruments.push(...result.instruments);manifest.samples.push(...result.samples);
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
