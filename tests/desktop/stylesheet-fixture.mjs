import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {exporter,importer,midi,model,Settings} from '@coderline/alphatab';
import {strToU8,unzipSync,zipSync} from 'fflate';
import {directory} from './harness.mjs';

// Entirely original public-model music and independently authored wire bytes.
// These are not retained native probes or original-GP8-opened fixtures.
export const currentPath='Content/Stylesheets/score.gpss';
export const legacyPath='Content/BinaryStylesheet';
export const viewPath='Content/Stylesheets/scoreview1.gpss';
export const yes=Uint8Array.of(0x08,0x19,0x5a,4,0x2a,2,8,1,0x12,3,0x53,0x54,0x59);
export const no=Uint8Array.of(0x08,0x19,0x5a,4,0x2a,2,8,0,0x12,3,0x53,0x54,0x59);
export const inherited=Uint8Array.of(0x08,0x19,0x5a,0,0x12,3,0x53,0x54,0x59);
export const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const settings=new Settings();
const legacyKey='Staff/drawTimeSignatureC';
const pitches=[64,65,66,67,69,70,71,72,74,75,76];

function legacyBytes(value){
  const record=(key,type,payload)=>[strToU8(key).length,...strToU8(key),type,...payload];
  return Uint8Array.of(0,0,0,3,
    ...record('Authored/before',0,[1]),
    ...record(legacyKey,0,[Number(value)]),
    ...record('Authored/after',1,[0x12,0x34,0x56,0x78]));
}

// Independent small archive inspector: no imports from product adapters. Its
// inputs are bounded authored fixtures and actual files written by the app.
function wireRecords(bytes){
  let cursor=0;
  const varint=()=>{let value=0n;for(let shift=0n;shift<70n;shift+=7n){assert.ok(cursor<bytes.length);const byte=bytes[cursor++];value|=BigInt(byte&127)<<shift;if(!(byte&128))return value;}throw new Error('Unterminated fixture varint');};
  const records=[];
  while(cursor<bytes.length){
    const tag=varint(),field=Number(tag>>3n),wire=Number(tag&7n);let value;
    if(wire===0)value=varint();
    else {const length=wire===2?Number(varint()):wire===1?8:wire===5?4:-1;assert.ok(length>=0&&cursor+length<=bytes.length);value=bytes.subarray(cursor,cursor+length);cursor+=length;}
    records.push({field,wire,value});
  }
  return records;
}
export function inspectCurrent(bytes){
  if(bytes===undefined)return null;
  let message=bytes;
  for(const field of [11,5]){const matches=wireRecords(message).filter(record=>record.field===field);assert.ok(matches.length<=1);if(!matches.length)return null;assert.equal(matches[0].wire,2);message=matches[0].value;}
  const matches=wireRecords(message).filter(record=>record.field===1);assert.ok(matches.length<=1);
  if(!matches.length)return false;assert.equal(matches[0].wire,0);assert.ok(matches[0].value===0n||matches[0].value===1n);return matches[0].value===1n;
}
export function inspectLegacy(bytes){
  assert.ok(bytes&&bytes.length>=4);const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),count=view.getInt32(0);assert.ok(count>=0&&count<=8192);let cursor=4,value=null;
  const unrelated=[];
  for(let index=0;index<count;index++){
    const start=cursor,length=bytes[cursor++];assert.ok(cursor+length+1<=bytes.length);const key=Buffer.from(bytes.subarray(cursor,cursor+length)).toString('utf8');cursor+=length;const type=bytes[cursor++],payload=cursor;
    let size=[1,4,4,null,8,8,16,4][type];
    if(type===3){assert.ok(cursor+2<=bytes.length);const textLength=view.getInt16(cursor);assert.ok(textLength>=0);size=2+textLength;}
    assert.ok(Number.isInteger(size)&&cursor+size<=bytes.length);cursor+=size;
    if(key===legacyKey){assert.equal(value,null);assert.equal(type,0);assert.ok(bytes[payload]===0||bytes[payload]===1);value=bytes[payload]===1;}
    else unrelated.push(Buffer.from(bytes.subarray(start,cursor)).toString('hex'));
  }
  assert.equal(cursor,bytes.length);return {value,unrelated};
}
export function musical(bytes){
  // alphaTab's public loader does not read GPSS. Only musical data is read here;
  // the native app's checkbox/reopen and screenshots establish symbol import.
  const score=importer.ScoreLoader.loadScoreFromBytes(bytes,settings),file=new midi.MidiFile();
  new midi.MidiFileGenerator(score,settings,new midi.AlphaSynthMidiFileHandler(file,true)).generate();
  return {
    clocks:score.masterBars.map(bar=>[bar.start,bar.calculateDuration(),bar.timeSignatureNumerator,bar.timeSignatureDenominator]),
    notes:file.tracks.flatMap(track=>track.events).filter(event=>event instanceof midi.NoteOnEvent).map(event=>[event.tick,event.noteKey]),
    midiSha256:hash(file.toBinary()),
  };
}
export function buildStylesheetFixtures(prefix){
  mkdirSync(directory,{recursive:true});const score=new model.Score(),track=new model.Track(),staff=new model.Staff();
  score.title='Original common and cut time study';score.artist='TabPlayer authored verification';
  track.name='Style study guitar';track.playbackInfo.program=25;track.playbackInfo.secondaryChannel=1;
  staff.stringTuning.tunings=[64,59,55,50,45,40];staff.showStandardNotation=true;staff.showTablature=true;track.addStaff(staff);score.addTrack(track);
  for(const [index,[numerator,denominator,frets]]of [[4,4,[0,1,2,3]],[2,2,[5,6,7,8]],[3,4,[10,11,12]]].entries()){
    const master=new model.MasterBar();master.timeSignatureNumerator=numerator;master.timeSignatureDenominator=denominator;score.addMasterBar(master);
    const bar=new model.Bar(),voice=new model.Voice();bar.clef=model.Clef.G2;bar.addVoice(voice);staff.addBar(bar);
    for(const fret of frets){const beat=new model.Beat(),note=new model.Note();beat.duration=4;beat.isEmpty=false;note.string=6;note.fret=fret;beat.addNote(note);voice.addBeat(beat);}
    assert.equal(master.index,index);
  }
  score.finish(settings);
  const original=unzipSync(new exporter.Gp7Exporter().export(score,settings)),fixtures={};
  for(const [name,flag,legacy,views]of [
    ['true',yes,false,{}],['false',no,true,{}],['inherited',inherited,true,{}],
    ['views',yes,false,{[viewPath]:no,'Content/Stylesheets/scoreview2.gpss':yes}],
    ['malformed-view',yes,false,{[viewPath]:Uint8Array.of(255)}],
    ['legacy-only',null,true,{}],
  ]){
    const entries={...original,[legacyPath]:legacyBytes(legacy),'Content/Assets/style-authored-sentinel.bin':Uint8Array.of(0,255,31,83,84,89),...views};
    if(flag)entries[currentPath]=flag.slice();else delete entries[currentPath];
    const bytes=zipSync(entries,{mtime:new Date('2020-01-01T00:00:00Z')}),path=resolve(directory,`${prefix}-${name}-source.gp`),music=musical(bytes);
    assert.deepEqual(music.clocks,[[0,3840,4,4],[3840,3840,2,2],[7680,2880,3,4]]);
    assert.deepEqual(music.notes,pitches.map((pitch,index)=>[index*960,pitch]));
    assert.equal(inspectCurrent(entries[currentPath]),flag===yes?true:flag===no?false:null);
    assert.equal(inspectLegacy(entries[legacyPath]).value,legacy);
    writeFileSync(path,bytes);fixtures[name]={path,bytes,entries,music,sha256:hash(bytes)};
  }
  return fixtures;
}

export function assertExport(bytes,fixture,{current,legacy,changed=false}={}){
  const entries=unzipSync(bytes);assert.deepEqual(musical(bytes),fixture.music,'GP export preserves literal music, clocks and standard MIDI notes/controls');
  if(current!==undefined)assert.equal(inspectCurrent(entries[currentPath]),current);
  if(legacy!==undefined)assert.equal(inspectLegacy(entries[legacyPath]).value,legacy);
  for(const [path,original]of Object.entries(fixture.entries)){
    if(path==='Content/score.gpif'||changed&&(path===currentPath||path===legacyPath))continue;
    assert.deepEqual(entries[path],original,`Source archive sibling ${path}`);
  }
  if(changed){
    if(fixture.entries[currentPath])assert.deepEqual(entries[currentPath],current?yes:no,'Only the authored current target value changes');
    else assert.equal(entries[currentPath],undefined,'Legacy-only source does not acquire incomplete GPSS');
    assert.deepEqual(inspectLegacy(entries[legacyPath]).unrelated,inspectLegacy(fixture.entries[legacyPath]).unrelated);
  }
}
