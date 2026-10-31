import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {rolldown} from 'rolldown';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
export const libraryDirectory=resolve(root,'.analysis/desktop-smoke');
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const target=(track,bar,beat)=>({track,staff:0,bar,voice:0,beat});
const note=(track,bar,beat,string,fret)=>({type:'setNote',target:target(track,bar,beat),string,fret});
const metadata=album=>({subTitle:'',album,words:'',music:'',copyright:'',tab:'',notices:'',instructions:''});
let apiPromise;
async function engine(){
  apiPromise??=(async()=>{const entry='library-fixture-entry',modules=[['src/engine.ts','buildScore'],['src/project.ts','blankProject']];const bundle=await rolldown({input:entry,external:['@coderline/alphatab','fflate'],plugins:[{name:entry,resolveId:id=>id===entry?id:null,load:id=>id===entry?modules.map(([path,names])=>`export {${names}} from ${JSON.stringify(resolve(root,path).replaceAll('\\','/'))};`).join('\n'):null}]});try{const {output}=await bundle.generate({format:'es',paths:Object.fromEntries(['@coderline/alphatab','fflate'].map(name=>[name,import.meta.resolve(name)]))});return await import(`data:text/javascript;base64,${Buffer.from(output.find(item=>item.type==='chunk'&&item.isEntry).code).toString('base64')}`);}finally{await bundle.close();}})();return apiPromise;
}
const viewProject=project=>({...project,assets:Object.fromEntries(Object.entries(project.assets).map(([id,asset])=>[id,{filename:asset.filename,mediaType:asset.mediaType,byteLength:Buffer.from(asset.bytesBase64,'base64').length}]))});
function notes(score){return score.tracks.flatMap(track=>track.staves.flatMap(staff=>staff.bars.flatMap(bar=>bar.voices.flatMap(voice=>voice.beats.flatMap(beat=>beat.notes.map(note=>({track:track.index,key:note.realValue,startTick:bar.masterBar.start+beat.playbackStart,endTick:bar.masterBar.start+beat.playbackStart+beat.playbackDuration})))))));}
const literal=(track,key,startTick)=>({track,key,startTick,endTick:startTick+960});
function backing(){const rate=32000,bytes=Buffer.alloc(44+rate*4);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(2,22);bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*4,28);bytes.writeUInt16LE(4,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(rate*4,40);for(let frame=0;frame<rate;frame++){const sample=Math.round(Math.sin(frame/rate*239*Math.PI*2)*1300);bytes.writeInt16LE(sample,44+frame*4);bytes.writeInt16LE(sample,46+frame*4);}return bytes;}

// Original, small schema3 scores. No private GP, vendor music or live catalog.
export async function buildLibraryFixture(){
  const api=await engine(),bytes=backing(),assetId=sha256(bytes),project=api.blankProject();
  project.base.title='Amber Estuary — Õhtu 同じ楽譜 · A long original Library score title';project.base.artist='Nacre Ensemble 417';
  const added={type:'addTrack',name:'Copper Basin Bass 928',tuning:[43,38,33,28],program:33};
  project.baselineEdits=[{type:'setScoreMetadata',fields:metadata('Glass Atlas 603')},{type:'setTrackInfo',track:0,name:'Northern Lantern Guitar 751',shortName:'NL',program:25},added,note(0,0,0,6,5),note(1,0,0,4,0),{type:'setBacking',backing:{assetId,offsetMs:0,anchors:[],mix:{gain:1,pan:0,mute:false,solo:false}}}];
  const band=JSON.parse(readFileSync(resolve(root,'assets/library/templates/factory-band.tabplayer'))),sound=band.baselineEdits.find(edit=>edit.type==='setTrackSound'&&edit.sound.presetId==='bass').sound;project.baselineEdits.push({type:'setTrackSound',trackId:`added/2/${JSON.stringify(added)}`,sound:structuredClone(sound)});
  project.edits=[note(0,0,1,6,7),note(1,1,2,4,2)];project.assets[assetId]={filename:'original-library-backing.wav',mediaType:'audio/wav',bytesBase64:bytes.toString('base64')};
  const other=structuredClone(project);other.base.title='Moon Orchard — independently authored second score';other.base.artist='Cobalt Quartet 286';other.baselineEdits[0].fields.album='Paper Meridian 934';other.baselineEdits[1].name='Quiet Arcade Guitar 562';other.baselineEdits[2].name='Distant Foundry Bass 849';other.baselineEdits.find(edit=>edit.type==='setTrackSound').trackId=`added/2/${JSON.stringify(other.baselineEdits[2])}`;other.edits=[];
  const appliedNotes=[literal(0,69,0),literal(1,43,0),literal(0,71,960)],allNotes=[...appliedNotes,literal(1,45,5760)],sort=rows=>rows.map(row=>JSON.stringify(row)).sort();
  assert.deepEqual(sort(notes(api.buildScore(viewProject(project)))),sort(allNotes),'Independent complete original notes and clocks');assert.deepEqual(sort(notes(api.buildScore(viewProject({...project,edits:project.edits.slice(0,1)})))),sort(appliedNotes));api.buildScore(viewProject(other));
  const manifestPath=resolve(root,'assets/library/manifest.json'),manifest=JSON.parse(readFileSync(manifestPath)),bundled=[...manifest.templates,...manifest.examples].map(descriptor=>{const path=resolve(root,'assets/library',descriptor.path),bytes=readFileSync(path);assert.equal(sha256(bytes),descriptor.sha256);const project=JSON.parse(bytes);api.buildScore(viewProject(project));return {descriptor,path,project,sha256:descriptor.sha256};});assert.equal(bundled.length,13);
  return {authored:true,project,other,backing:{bytes,sha256:assetId},metadata:{title:project.base.title,artist:project.base.artist,album:'Glass Atlas 603',trackNames:['Northern Lantern Guitar 751','Copper Basin Bass 928'],metadataTruncated:false},otherMetadata:{title:other.base.title,artist:other.base.artist,album:'Paper Meridian 934',trackNames:['Quiet Arcade Guitar 562','Distant Foundry Bass 849'],metadataTruncated:false},appliedNotes,allNotes,bundled,manifestPath,manifestSha256:sha256(readFileSync(manifestPath)),templateName:'Estuary ensemble — personal 同じ template',limits:['Original schema3 native fixtures and original CC0 bundled content only; no original GP8 runtime equivalence claim.','One-second original backing is an exact embedded asset/hash case, not physical audio acceptance.']};
}
export function writeLibraryFixture(fixture){
  mkdirSync(libraryDirectory,{recursive:true});const workDirectory=mkdtempSync(resolve(libraryDirectory,'file-library-')),inputs=resolve(workDirectory,'inputs'),folderRoot=resolve(workDirectory,'search scores — Õhtu 同じ'),outputs=resolve(workDirectory,'outputs'),nativeDirectory=resolve(workDirectory,'native');for(const path of [inputs,folderRoot,outputs,nativeDirectory])mkdirSync(path,{recursive:true});const hashes={};
  const put=(path,bytes)=>{writeFileSync(path,bytes,{flag:'wx'});hashes[path]=sha256(bytes);return path;};
  const backingPath=put(resolve(inputs,'original-backing.wav'),fixture.backing.bytes),project=structuredClone(fixture.project),other=structuredClone(fixture.other);project.assets[fixture.backing.sha256].filename=backingPath;other.assets[fixture.backing.sha256].filename=backingPath;
  const encode=value=>Buffer.from(JSON.stringify(value,null,2)),sourcePath=put(resolve(inputs,'parcel-0042.tabplayer'),encode(project)),folderSource=put(resolve(folderRoot,'box-0021.tabplayer'),encode(project)),folderOther=put(resolve(folderRoot,'crate-0087.tabplayer'),encode(other));
  const invalidPath=put(resolve(inputs,'invalid-0098.tabplayer'),Buffer.from('{"format":"TabPlayer","schemaVersion":99}')),unsupportedPath=put(resolve(inputs,'unsupported-0099.txt'),Buffer.from('Original unsupported drop sentinel.'));
  for(const item of fixture.bundled)hashes[item.path]=item.sha256;hashes[fixture.manifestPath]=fixture.manifestSha256;
  const expectedFork={...structuredClone(project),baselineEdits:[...project.baselineEdits,...project.edits.slice(0,1)],edits:[]};
  const state={format:'TabPlayerLibraryAcceptance',version:1,authored:true,authorCheckpoint:'d7a2130',workDirectory,nativeDirectory,folderRoot,sourcePath,folderSource,folderOther,invalidPath,unsupportedPath,backingPath,backingHash:fixture.backing.sha256,project,other,expectedFork,metadata:fixture.metadata,otherMetadata:fixture.otherMetadata,appliedNotes:fixture.appliedNotes,allNotes:fixture.allNotes,bundled:fixture.bundled,templateName:fixture.templateName,savePath:resolve(outputs,'independent-fork.tabplayer'),missingHeldPath:resolve(outputs,'independent-fork.missing-held'),hashes,receipts:{},limits:fixture.limits};
  const statePath=resolve(workDirectory,'fixture-state.json');writeFileSync(statePath,JSON.stringify(state,null,2),{flag:'wx'});return {...state,statePath};
}
export function assertLibraryFixtureHashes(fixture){for(const [path,hash]of Object.entries(fixture.hashes))assert.equal(sha256(readFileSync(path)),hash,`Preserve original Library input: ${path}`);}
