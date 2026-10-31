import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {exporter,model,Settings} from '@coderline/alphatab';
import {JSDOM} from 'jsdom';
import {rolldown} from 'rolldown';
import {unzipSync,zipSync} from 'fflate';
import {sha256} from './document-tabs-fixture.mjs';

export const workstationDirectory=resolve(dirname(fileURLToPath(import.meta.url)),'../../.analysis/desktop-smoke');
const root=resolve(workstationDirectory,'../..'),settings=new Settings(),tuning=[64,59,55,50,45,40];
const definitions=[
  {name:'Harbour lead — independently authored guitar',program:25,kind:'guitar',key:69},
  {name:'Evening rhythm · a deliberately long track name for the compact workstation mixer',program:26,kind:'guitar',key:64},
  {name:'Low lantern bass',program:33,kind:'bass',key:43},
  {name:'Piano — 同じ窓',program:0,kind:'keys',key:60},
  {name:'Original snare kit',program:0,kind:'drums',key:38},
  {name:'Rest-only guitar',program:25,kind:'rest',key:null},
  {name:'Empty voice guitar',program:25,kind:'empty',key:null},
  {name:'Flute · Õhtu melody with a long independently authored name',program:73,kind:'keys',key:72},
];
let apiPromise;
async function engine(){
  apiPromise??=(async()=>{
    const bundle=await rolldown({input:resolve(root,'src/engine.ts'),external:['@coderline/alphatab','fflate']});
    try{const {output}=await bundle.generate({format:'es',paths:Object.fromEntries(['@coderline/alphatab','fflate'].map(name=>[name,import.meta.resolve(name)]))});return await import(`data:text/javascript;base64,${Buffer.from(output.find(item=>item.type==='chunk'&&item.isEntry).code).toString('base64')}`);}finally{await bundle.close();}
  })();return apiPromise;
}
export function readWorkstationNotes(score){
  return score.tracks.flatMap(track=>track.staves.flatMap(staff=>staff.bars.flatMap(bar=>bar.voices.flatMap(voice=>voice.beats.flatMap(beat=>beat.notes.map(note=>({track:track.index,bar:bar.index,key:staff.isPercussion?track.percussionArticulations[note.percussionArticulation].outputMidiNumber:note.realValue,startTick:bar.masterBar.start+beat.playbackStart,endTick:bar.masterBar.start+beat.playbackStart+beat.playbackDuration})))))));
}
const sorted=events=>events.map(event=>JSON.stringify(event)).sort();
export function assertWorkstationNotes(score,literal){assert.deepEqual(sorted(readWorkstationNotes(score)),sorted(literal),'Complete independently specified written notes and ticks');}
function wav(){
  const rate=32000,frames=rate*8,bytes=Buffer.alloc(44+frames*4);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(2,22);bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*4,28);bytes.writeUInt16LE(4,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(frames*4,40);
  for(let frame=0;frame<frames;frame++){const value=Math.round(Math.sin(2*Math.PI*211*frame/rate)*1200);bytes.writeInt16LE(value,44+frame*4);bytes.writeInt16LE(value,46+frame*4);}return {bytes,sha256:sha256(bytes),sampleRate:rate,durationSeconds:8};
}

// The long score and optional WAV are allocated only by explicit caller flags.
// One whole-note/rest carrier per measure bounds original fixture authoring.
export async function buildWorkstationFixture({long=false,backing=false}={}){
  assert.equal(typeof long,'boolean');assert.equal(typeof backing,'boolean');
  const bars=long?2000:16,tracks=long?32:8,score=new model.Score(),literal=[];
  score.title='Harbour windows — original workstation study · 同じ楽譜 🎸';score.artist='TabPlayer original redistributable acceptance';
  const sections=long?[[0,'Departure'],[512,'Long crossing'],[1999,'Home']]:[[0,'Harbour'],[4,'Verse — Õhtu'],[8,'Bridge'],[12,'Home']];
  for(let index=0;index<bars;index++){const bar=new model.MasterBar();if(!index)bar.tempoAutomations=[model.Automation.buildTempoAutomation(false,0,120,2)];const section=sections.find(([at])=>at===index);if(section){bar.section=new model.Section();bar.section.text=section[1];bar.section.marker=String(sections.indexOf(section)+1);}score.addMasterBar(bar);}
  let beatId=0,noteId=0;const trackData=[];
  for(let index=0;index<tracks;index++){
    const definition=definitions[index%8],track=new model.Track(),staff=new model.Staff(),drums=definition.kind==='drums';
    track.name=`${definition.name}${index>=8?` · ${index+1}`:''}`;track.shortName=`W${index+1}`;track.playbackInfo.program=definition.program;
    track.playbackInfo.primaryChannel=drums?9:[0,2,4,6,8,10,12,14][index%8];track.playbackInfo.secondaryChannel=drums?9:Math.min(15,track.playbackInfo.primaryChannel+1);
    if(drums)track.percussionArticulations=[new model.InstrumentArticulation('Snare',3,38,model.MusicFontSymbol.NoteheadBlack,model.MusicFontSymbol.NoteheadHalf,model.MusicFontSymbol.NoteheadWhole,model.MusicFontSymbol.None,model.TechniqueSymbolPlacement.Above,38)];
    staff.stringTuning.tunings=drums||definition.kind==='keys'?[]:definition.kind==='bass'?[43,38,33,28]:[...tuning];staff.isPercussion=drums;staff.showTablature=staff.stringTuning.tunings.length>0;staff.showStandardNotation=true;track.addStaff(staff);score.addTrack(track);
    for(let indexBar=0;indexBar<bars;indexBar++){
      const bar=new model.Bar(),voice=new model.Voice(),beat=new model.Beat();bar.id=index*bars+indexBar;voice.id=bar.id;bar.clef=drums?model.Clef.Neutral:definition.kind==='bass'?model.Clef.F4:model.Clef.G2;staff.addBar(bar);bar.addVoice(voice);beat.id=beatId++;beat.duration=model.Duration.Whole;beat.isEmpty=definition.kind==='empty';voice.addBeat(beat);
      if(definition.key===null||long&&index%8!==3&&indexBar%17!==0)continue;
      const key=definition.key+(drums?0:indexBar%3),note=new model.Note();note.id=noteId++;
      if(drums)note.percussionArticulation=0;else if(staff.stringTuning.tunings.length){note.string=definition.kind==='bass'?4:6;note.fret=key-staff.stringTuning.tunings[0];}else{note.octave=Math.floor(key/12);note.tone=key%12;}
      beat.addNote(note);literal.push({track:index,bar:indexBar,key,startTick:indexBar*3840,endTick:(indexBar+1)*3840});
    }
    trackData.push({index,name:track.name,kind:definition.kind,program:definition.program});
  }
  score.rebuildRepeatGroups();score.finish(settings);
  const bytes=zipSync(unzipSync(new exporter.Gp7Exporter().export(score,settings)),{mtime:new Date(2000,0,1)}),api=await engine(),dom=new JSDOM(''),previous=['DOMParser','XMLSerializer'].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]);
  for(const [name]of previous)Object.defineProperty(globalThis,name,{value:dom.window[name],configurable:true,writable:true});
  try{const imported=api.buildScore({format:'TabPlayer',schemaVersion:2,engineVersion:'1.8.4',base:{kind:'file',filename:'original-workstation.gp',bytesBase64:Buffer.from(bytes).toString('base64'),sha256:sha256(bytes)},edits:[],assets:{}});assertWorkstationNotes(imported,literal);assert.equal(imported.tracks.length,tracks);assert.equal(imported.masterBars.length,bars);assert.equal(imported.tracks[4].isPercussion,true);assert.equal(imported.tracks[3].staves[0].tuning.length,0);assert.ok(imported.tracks[5].staves[0].bars.every(bar=>bar.voices[0].beats.every(beat=>!beat.isEmpty&&beat.isRest)));assert.ok(imported.tracks[6].staves[0].bars.every(bar=>bar.voices[0].beats.every(beat=>beat.isEmpty)));assert.deepEqual(imported.masterBars.filter(bar=>bar.section).map(bar=>[bar.index,bar.section.text]),sections);}
  finally{for(const [name,descriptor]of previous){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}dom.window.close();}
  return {authored:true,long,bytes,sha256:sha256(bytes),measureCount:bars,trackCount:tracks,tracks:trackData,sections,literalNotes:literal,backing:backing?wav():null,limits:['Original public alphaTab 1.8.4 authoring; original GP8 runtime equivalence unverified.','Written straight 4/4 whole notes, rests and empty carriers; no repeat-occurrence claim.','Long fixture reuses MIDI channels across tracks; intended for grid structure and native continuity, not independent 32-channel audio fidelity.']};
}
export function writeWorkstationFixture(fixture,prefix=`workstation-${Date.now()}-${randomUUID()}`){
  assert.match(prefix,/^workstation-[a-zA-Z0-9-]+$/);mkdirSync(workstationDirectory,{recursive:true});const hashes={};
  const put=(name,bytes)=>{const path=resolve(workstationDirectory,`${prefix}-${name}`);writeFileSync(path,bytes,{flag:'wx'});hashes[path]=sha256(bytes);return path;};
  const path=put('original.gp',fixture.bytes),backingPath=fixture.backing?put('backing.wav',fixture.backing.bytes):null;
  const metadata={...fixture,prefix,path,backingPath,hashes};delete metadata.bytes;if(metadata.backing)metadata.backing={...metadata.backing,bytes:undefined};
  const metadataPath=put('fixture.json',Buffer.from(JSON.stringify(metadata,null,2)));return {...metadata,metadataPath};
}
export function assertWorkstationFixtureHashes(fixture){for(const [path,hash]of Object.entries(fixture.hashes))assert.equal(sha256(readFileSync(path)),hash,`Preserve original authored input: ${path}`);}
