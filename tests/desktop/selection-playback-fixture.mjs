import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {exporter,importer,midi,model,Settings} from '@coderline/alphatab';
import {unzipSync,zipSync} from 'fflate';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
export const selectionDirectory=resolve(root,'.analysis/desktop-smoke');
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const settings=new Settings(),Q=model.Duration.Quarter,E=model.Duration.Eighth,W=model.Duration.Whole;
const target=(bar,beat,voice=0,track=0)=>({track,staff:0,bar,voice,beat});
const sorted=rows=>rows.map(row=>JSON.stringify(row)).sort();

// Independently decode the actual SMF bytes, rather than comparing two views of
// alphaTab's in-memory event objects or importing the production playback map.
function decodeNotes(bytes){
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let cursor=0;
  const text=count=>String.fromCharCode(...bytes.subarray(cursor,cursor+=count));
  const u32=()=>{const value=view.getUint32(cursor);cursor+=4;return value;};
  const u16=()=>{const value=view.getUint16(cursor);cursor+=2;return value;};
  const variable=()=>{let value=0,byte;do{assert.ok(cursor<bytes.length);byte=bytes[cursor++];value=value*128+(byte&127);}while(byte&128);return value;};
  assert.equal(text(4),'MThd');assert.equal(u32(),6);u16();const tracks=u16();assert.equal(u16(),960);const notes=[];
  for(let track=0;track<tracks;track++){
    assert.equal(text(4),'MTrk');const length=u32(),end=cursor+length;let tick=0,running=0;
    while(cursor<end){
      tick+=variable();let status=bytes[cursor++];if(status<128){cursor--;status=running;}else if(status<240)running=status;
      if(status===255){cursor++;const size=variable();cursor+=size;continue;}
      if(status===240||status===247){const size=variable();cursor+=size;continue;}
      const command=status&240,key=bytes[cursor++],velocity=command===192||command===208?null:bytes[cursor++];
      if(command===144||command===128)notes.push({type:command===144&&velocity>0?'noteOn':'noteOff',track,tick,channel:status&15,key,velocity});
    }
    assert.equal(cursor,end);
  }
  assert.equal(cursor,bytes.length);return notes;
}

function author(bars,tracks=1,voices=1){
  const score=new model.Score();score.title='Original selected-passage study';score.artist='TabPlayer authored verification';
  score.defaultSystemsLayout=3;score.stylesheet.multiTrackMultiBarRest=false;
  for(let index=0;index<bars;index++){const master=new model.MasterBar();if(index===0)master.tempoAutomations=[model.Automation.buildTempoAutomation(false,0,120,2)];score.addMasterBar(master);}
  let barId=0,voiceId=0,beatId=0,noteId=0;
  for(let index=0;index<tracks;index++){
    const track=new model.Track(),staff=new model.Staff();track.name=index?'Held piano':'Selection guitar';
    Object.assign(track.playbackInfo,{program:index?0:25,primaryChannel:index*2,secondaryChannel:index*2+1});
    staff.stringTuning.tunings=index?[]:[64,59,55,50,45,40];staff.showStandardNotation=true;staff.showTablature=!index;track.addStaff(staff);score.addTrack(track);
    for(let b=0;b<bars;b++){const bar=new model.Bar();bar.id=barId++;bar.clef=model.Clef.G2;staff.addBar(bar);for(let v=0;v<voices;v++){const voice=new model.Voice();voice.id=voiceId++;bar.addVoice(voice);}}
  }
  const beat=(bar,duration,key=null,voice=0,track=0,options={})=>{
    const result=new model.Beat();result.id=beatId++;result.duration=duration;result.isEmpty=false;Object.assign(result,options);
    score.tracks[track].staves[0].bars[bar].voices[voice].addBeat(result);
    if(key!==null){const note=new model.Note();note.id=noteId++;if(track){note.octave=Math.floor(key/12);note.tone=key%12;}else{note.string=voice?2:6;note.fret=key-(voice?45:64);}result.addNote(note);}
    return result;
  };
  return {score,beat};
}

class ReferenceHandler extends midi.AlphaSynthMidiFileHandler {
  shift=0;
  addTickShift(ticks){this.shift=ticks;super.addTickShift(ticks);}
}
function reference(score){
  const file=new midi.MidiFile(),handler=new ReferenceHandler(file,true),generator=new midi.MidiFileGenerator(score,settings,handler);generator.generate();
  const bytes=file.toBinary(),notes=decodeNotes(bytes);
  const objectNotes=file.tracks.flatMap((track,index)=>track.events.filter(event=>event.type===midi.MidiEventType.NoteOn||event.type===midi.MidiEventType.NoteOff).map(event=>({type:event.type===midi.MidiEventType.NoteOn?'noteOn':'noteOff',track:index,tick:event.tick,channel:event.channel,key:event.noteKey,velocity:event.noteVelocity})));
  assert.deepEqual(sorted(notes),sorted(objectNotes));
  return {bytes,notes,tickShift:handler.shift,itinerary:generator.tickLookup.masterBars.map(bar=>bar.masterBar.index),masterTicks:generator.tickLookup.masterBars.map(bar=>[bar.start+handler.shift,bar.end+handler.shift])};
}

function mainScore(){
  const {score,beat}=author(3,2,2);score.masterBars[0].isRepeatStart=true;score.masterBars[1].repeatCount=2;score.masterBars[1].alternateEndings=1;score.masterBars[2].alternateEndings=2;
  beat(0,Q);const origin=beat(0,Q,69).notes[0],destination=beat(0,Q,69).notes[0];
  destination.isTieDestination=true;origin.tieDestination=destination;destination.tieOrigin=origin;beat(0,Q,85);
  for(const [bar,keys]of [[1,[71,72,74,76]],[2,[66,67,68,70]]])for(const key of keys)beat(bar,Q,key);
  for(let bar=0;bar<3;bar++){beat(bar,W,57,1);beat(bar,W,48+bar*2,0,1);beat(bar,W,null,1,1,{isEmpty:true});}
  score.rebuildRepeatGroups();score.finish(settings);
  const lyrics=new model.Lyrics();lyrics.startBar=0;lyrics.text='Hold the light re-turn';lyrics.finish();score.tracks[0].applyLyrics([lyrics]);
  return score;
}

function edgeScores(){
  const grace=author(3);for(let bar=0;bar<3;bar++){
    grace.beat(bar,E,72,0,0,{graceType:bar===1?model.GraceType.OnBeat:model.GraceType.BeforeBeat});
    for(const key of [69,71,72,74])grace.beat(bar,Q,key);
  }
  grace.score.tracks[0].staves[0].bars[2].simileMark=model.SimileMark.Simple;
  const rhythm=author(3);rhythm.score.masterBars[0].isAnacrusis=true;rhythm.beat(0,Q,69);
  rhythm.score.masterBars[1].tripletFeel=model.TripletFeel.Triplet8th;for(let index=0;index<8;index++)rhythm.beat(1,E,69+index);
  for(let index=0;index<3;index++)rhythm.beat(2,E,69+index,0,0,{tupletNumerator:3,tupletDenominator:2});for(let index=0;index<3;index++)rhythm.beat(2,Q,72+index);
  const directed=author(4);for(let bar=0;bar<4;bar++)for(let beat=0;beat<4;beat++)directed.beat(bar,Q,66+bar);
  directed.score.masterBars[1].directions=new Set([model.Direction.TargetFine]);directed.score.masterBars[3].directions=new Set([model.Direction.JumpDaCapoAlFine]);
  for(const item of [grace,rhythm,directed]){item.score.rebuildRepeatGroups();item.score.finish(settings);}
  return {grace:grace.score,rhythm:rhythm.score,directed:directed.score};
}

function encode(score){return zipSync(unzipSync(new exporter.Gp7Exporter().export(score,settings)),{mtime:new Date(2000,0,1)});}
function assertMain(score,ref){
  assert.deepEqual(ref.itinerary,[0,1,0,2]);assert.deepEqual(ref.masterTicks,[[0,3840],[3840,7680],[7680,11520],[11520,15360]]);
  const expected=[];
  for(const [occurrence,bar]of [0,1,0,2].entries()){
    const start=occurrence*3840;
    const melody=bar===0?[[960,2880,69],[2880,3840,85]]:[0,1,2,3].map(index=>[index*960,(index+1)*960,(bar===1?[71,72,74,76]:[66,67,68,70])[index]]);
    for(const [left,right,key]of [...melody,[0,3840,57]])expected.push(['noteOn',start+left,0,key],['noteOff',start+right,0,key]);
    expected.push(['noteOn',start,2,48+bar*2],['noteOff',start+3840,2,48+bar*2]);
  }
  assert.deepEqual(sorted(ref.notes.map(event=>[event.type,event.tick,event.channel,event.key])),sorted(expected),'Literal complete note stream, including absence of a tied destination attack');
  const bars=score.tracks[0].staves[0].bars;assert.equal(bars[0].voices[0].beats[0].isRest,true);assert.ok(bars[0].voices[0].beats[2].notes[0].tieOrigin);
  assert.equal(bars[0].voices[0].beats[3].notes[0].realValue,85);return expected;
}

// Authored backing input: its 32 kHz source rate is deliberately distinct from
// the device rate. Captures must report the real device rate themselves.
function backingBytes(){
  const rate=32000,frames=rate*12,bytes=Buffer.alloc(44+frames*4);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(2,22);bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*4,28);bytes.writeUInt16LE(4,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(frames*4,40);
  for(let frame=0;frame<frames;frame++){const value=Math.round(Math.sin(frame/rate*220*Math.PI*2)*1800);bytes.writeInt16LE(value,44+frame*4);bytes.writeInt16LE(value,46+frame*4);}return bytes;
}

export function buildSelectionFixtures(prefix=`selection-${Date.now()}-${process.pid}`){
  assert.match(prefix,/^selection-[a-zA-Z0-9-]+$/);mkdirSync(selectionDirectory,{recursive:true});const scores={main:mainScore(),...edgeScores()},fixtures={};
  for(const [name,score]of Object.entries(scores)){
    const before=JSON.stringify(model.JsonConverter.scoreToJson(score)),source=encode(score),copy=importer.ScoreLoader.loadScoreFromBytes(source,settings),ref=reference(copy),original=reference(score);
    assert.deepEqual(sorted(ref.notes),sorted(original.notes),'Authored and imported complete SMF note streams agree');
    assert.equal(JSON.stringify(model.JsonConverter.scoreToJson(score)),before,'Export and reference generation preserve the original model');
    const path=resolve(selectionDirectory,`${prefix}-${name}.gp`),midiPath=resolve(selectionDirectory,`${prefix}-${name}.mid`);
    writeFileSync(path,source);writeFileSync(midiPath,ref.bytes);
    fixtures[name]={path,midiPath,sha256:sha256(source),midiSha256:sha256(ref.bytes),tickShift:ref.tickShift,itinerary:ref.itinerary,masterTicks:ref.masterTicks,referenceMidi:ref.notes};
    if(name==='main')fixtures[name].literalMidi=assertMain(copy,ref);
    if(name==='directed')assert.deepEqual(ref.itinerary,[0,1,2,3,0,1]);
    if(name==='rhythm'){assert.deepEqual(ref.masterTicks,[[0,960],[960,4800],[4800,8640]]);assert.deepEqual(copy.tracks[0].staves[0].bars[1].voices[0].beats.slice(0,2).map(beat=>[beat.displayStart,beat.displayDuration]),[[0,480],[480,480]]);}
    if(name==='grace'){assert.equal(copy.tracks[0].staves[0].bars[0].voices[0].beats[0].graceType,model.GraceType.BeforeBeat);assert.equal(copy.tracks[0].staves[0].bars[1].voices[0].beats[0].graceType,model.GraceType.OnBeat);assert.equal(copy.tracks[0].staves[0].bars[2].simileMark,model.SimileMark.Simple);}
    // New public models with explicit IDs and fixed ZIP timestamps prove bytes
    // deterministic without editing any retained/archive fixture.
    assert.equal(sha256(encode(name==='main'?mainScore():edgeScores()[name])),fixtures[name].sha256);
  }
  const backingPath=resolve(selectionDirectory,`${prefix}-backing.wav`),backing=backingBytes();writeFileSync(backingPath,backing);
  const metadata={authored:true,prefix,fixtures,backing:{path:backingPath,sha256:sha256(backing),sourceRate:32000,durationSeconds:12,frequencyHz:220},targets:{rest:target(0,0),tieOrigin:target(0,1),tieDestination:target(0,2),sentinel:target(0,3),secondVoice:target(0,0,1),otherTrack:target(0,0,0,1)},expected:{durationTick:15360,durationSeconds:8,cursorOccurrence2:8640,selection:[960,2880],selectionOccurrence2:[8640,10560],sentinelTick:2880,sentinelKey:85,sentinelHz:440*2**((85-69)/12)},limits:['Public alphaTab authored/reference evidence; original GP8 runtime equivalence unverified.','Simile exposes its played placeholder, never hidden borrowed beat timing.','Loopback is shared device output; quiet surrounding output is required.','Logical fractional endpoint/sample-rate guarantees belong to native renderer tests; device capture has driver buffering and reports its actual rate.']};
  const metadataPath=resolve(selectionDirectory,`${prefix}-fixture.json`);writeFileSync(metadataPath,JSON.stringify(metadata,null,2));return {...metadata,metadataPath};
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){const value=buildSelectionFixtures();for(const fixture of Object.values(value.fixtures))assert.equal(sha256(readFileSync(fixture.path)),fixture.sha256);console.log(JSON.stringify(value,null,2));}
