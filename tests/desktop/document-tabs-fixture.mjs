import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {exporter,importer,model,Settings} from '@coderline/alphatab';
import {unzipSync,zipSync} from 'fflate';

export const documentTabsDirectory=resolve(dirname(fileURLToPath(import.meta.url)),'../../.analysis/desktop-smoke');
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export const duplicateTitle='Öölaul — 同じ楽譜 🎸 · A very long independently authored document title for horizontal score tab overflow';
const mix=()=>({gain:1,pan:0,mute:false,solo:false});
export const backingSettings=assetId=>({assetId,offsetMs:0,anchors:[],mix:mix()});

function scoreBytes(key){
  const score=new model.Score(),settings=new Settings();score.title=duplicateTitle;score.artist='TabPlayer original document ownership study';
  for(let bar=0;bar<8;bar++){const master=new model.MasterBar();if(!bar)master.tempoAutomations=[model.Automation.buildTempoAutomation(false,0,120,2)];score.addMasterBar(master);}
  let beatId=0,noteId=0;
  for(let index=0;index<2;index++){
    const track=new model.Track(),staff=new model.Staff();track.name=index?'Silent second guitar':'Literal melody';track.shortName=index?'Rest':'Lead';
    Object.assign(track.playbackInfo,{program:25,primaryChannel:index*2,secondaryChannel:index*2+1});
    staff.stringTuning.tunings=[64,59,55,50,45,40];staff.showTablature=true;staff.showStandardNotation=true;track.addStaff(staff);score.addTrack(track);
    for(let b=0;b<8;b++){
      const bar=new model.Bar(),voice=new model.Voice();bar.id=index*8+b;voice.id=index*8+b;bar.clef=model.Clef.G2;staff.addBar(bar);bar.addVoice(voice);
      for(let q=0;q<4;q++){
        const beat=new model.Beat();beat.id=beatId++;beat.duration=model.Duration.Quarter;beat.isEmpty=false;voice.addBeat(beat);
        if(!index){const note=new model.Note();note.id=noteId++;note.string=5;note.fret=key-59;beat.addNote(note);}
      }
    }
  }
  score.rebuildRepeatGroups();score.finish(settings);
  const bytes=zipSync(unzipSync(new exporter.Gp7Exporter().export(score,settings)),{mtime:new Date(2000,0,1)});
  const loaded=importer.ScoreLoader.loadScoreFromBytes(bytes,settings);
  assert.equal(loaded.title,duplicateTitle);assert.equal(loaded.tracks.length,2);assert.equal(loaded.masterBars.length,8);
  const notes=loaded.tracks.flatMap(track=>track.staves.flatMap(staff=>staff.bars.flatMap(bar=>bar.voices.flatMap(voice=>voice.beats.flatMap(beat=>beat.notes)))));
  assert.equal(notes.length,32);assert.deepEqual([...new Set(notes.map(note=>note.realValue))],[key],'Imported score must retain independently specified literal MIDI pitch');
  return bytes;
}
function sineBytes(hz){
  const rate=32000,frames=rate*20,bytes=Buffer.alloc(44+frames*4);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(2,22);bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*4,28);bytes.writeUInt16LE(4,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(frames*4,40);
  for(let frame=0;frame<frames;frame++){const sample=Math.round(Math.sin(2*Math.PI*hz*frame/rate)*1800);bytes.writeInt16LE(sample,44+frame*4);bytes.writeInt16LE(sample,46+frame*4);}
  return bytes;
}

export function buildDocumentTabsFixtures(prefix=`document-tabs-${Date.now()}-${randomUUID()}`){
  assert.match(prefix,/^document-tabs-[a-zA-Z0-9-]+$/);mkdirSync(documentTabsDirectory,{recursive:true});const hashes={},documents={};
  const put=(name,bytes)=>{const path=resolve(documentTabsDirectory,`${prefix}-${name}`);writeFileSync(path,bytes,{flag:'wx'});hashes[path]=sha256(bytes);return path;};
  for(const [name,key,frequencyHz]of [['A',60,173],['B',67,293]]){
    const source=scoreBytes(key),backing=sineBytes(frequencyHz),sourcePath=put(`${name}.gp`,source),backingPath=put(`${name}-backing.wav`,backing),backingHash=sha256(backing);
    const project={format:'TabPlayer',schemaVersion:2,engineVersion:'1.8.4',base:{kind:'file',filename:sourcePath,bytesBase64:Buffer.from(source).toString('base64'),sha256:sha256(source)},edits:[],assets:{}};
    if(name==='B'){project.edits.push({type:'setBacking',backing:backingSettings(backingHash)});project.assets[backingHash]={filename:backingPath,mediaType:'audio/wav',bytesBase64:backing.toString('base64')};}
    const projectPath=put(`${name}.tabplayer`,Buffer.from(JSON.stringify(project,null,2)));
    const legacy={...project,schemaVersion:1,edits:[]};delete legacy.assets;
    const schema1Path=put(`${name}-schema1.tabplayer`,Buffer.from(JSON.stringify(legacy,null,2)));
    const backingAlias=put(`${name}-backing-copy.tabplayer`,backing);
    documents[name]={key,frequencyHz,scoreHz:440*2**((key-69)/12),sourcePath,projectPath,schema1Path,backingPath,backingAlias,backingHash,sourceHash:sha256(source),projectHash:hashes[projectPath]};
  }
  assert.notEqual(documents.A.sourceHash,documents.B.sourceHash);assert.notEqual(documents.A.backingHash,documents.B.backingHash);
  const overflowPaths=Array.from({length:5},(_,index)=>put(`overflow-${index+1}.tabplayer`,readFileSync(documents.A.projectPath)));
  const metadata={authored:true,prefix,duplicateTitle,documents,overflowPaths,hashes,view:{A:{measure:3,beat:2,zoom:85,display:'all'},B:{measure:6,beat:3,zoom:120,display:'selected'}},limits:['Fixture uses public alphaTab 1.8.4; original Guitar Pro 8 runtime parity is unverified.','Physical capture uses shared device output; native status is only an observer.','Ordinary disk save compacts applied edits/assets; live redo and forced-crash recovery are separate.']};
  const metadataPath=put('fixture.json',Buffer.from(JSON.stringify(metadata,null,2)));return {...metadata,metadataPath};
}
export function assertFixtureHashes(fixture){for(const [path,hash]of Object.entries(fixture.hashes))assert.equal(sha256(readFileSync(path)),hash,`Preserve authored input: ${path}`);}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){const fixture=buildDocumentTabsFixtures();assertFixtureHashes(fixture);console.log(JSON.stringify(fixture,null,2));}
