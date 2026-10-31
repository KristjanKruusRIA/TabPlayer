// @vitest-environment jsdom
import { expect,it } from 'vitest';
import { exporter,importer,midi,model,Settings } from '@coderline/alphatab';
import { strFromU8,unzipSync } from 'fflate';
import { applyBarGestureEdit } from './bar-gestures';
import type { BarGestureCommand } from './gestures-types';
import { music,reopened } from './fixtures';

const settings=new Settings();
const bars=(score:model.Score)=>score.tracks[0].staves[0].bars;
const snapshot=(score:model.Score)=>JSON.stringify(model.JsonConverter.scoreToJson(score));
function authored() {
  const score=music();
  bars(score).forEach((bar,i)=>bar.voices[0].beats.forEach((beat,b)=>{beat.notes[0].string=1;beat.notes[0].fret=i*5+b;}));
  score.finish(settings);return score;
}
function simile(score:model.Score,bar:number,kind:'none'|'single'|'double') {
  return applyBarGestureEdit(score,{type:'setSimile',track:0,staff:0,bar,kind});
}
const masterCommand=(patch:Partial<Extract<BarGestureCommand,{type:'setMasterBarGestures'}>>={}):BarGestureCommand=>({type:'setMasterBarGestures',bar:0,commonTime:false,doubleBar:false,tripletFeel:0,beaming:null,...patch});

// Independent SMF byte decoding: note starts are read without alphaTab's MIDI reader.
function noteOns(score:model.Score) {
  const file=new midi.MidiFile(),handler=new midi.AlphaSynthMidiFileHandler(file,true);
  new midi.MidiFileGenerator(reopened(score),settings,handler).generate();
  const bytes=file.toBinary(),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let p=0;
  const ascii=(n:number)=>String.fromCharCode(...bytes.slice(p,p+=n));
  const u32=()=>{const value=view.getUint32(p);p+=4;return value;};
  const u16=()=>{const value=view.getUint16(p);p+=2;return value;};
  const variable=()=>{let value=0,b=0;do{b=bytes[p++];value=(value<<7)|(b&127);}while(b&128);return value;};
  expect(ascii(4)).toBe('MThd');expect(u32()).toBe(6);u16();const count=u16();expect(u16()).toBe(960);
  const notes:{tick:number;key:number}[]=[];
  for(let t=0;t<count;t++) {
    expect(ascii(4)).toBe('MTrk');const length=u32(),end=p+length;let tick=0,status=0;
    while(p<end) {
      tick+=variable();let type=bytes[p++];if(type<128){p--;type=status;}else if(type<240)status=type;
      if(type===255){p++;const size=variable();p+=size;}
      else if(type===240||type===247){const size=variable();p+=size;}
      else {const kind=type&240,key=bytes[p++];if(kind!==192&&kind!==208){const value=bytes[p++];if(kind===144&&value>0)notes.push({tick,key});}}
    }
  }
  expect(p).toBe(bytes.length);return notes.sort((a,b)=>a.tick-b.tick);
}
const gp=(score:model.Score)=>new exporter.Gp7Exporter().export(reopened(score),settings);

it('single_and_double_simile_replay_source_music without deleting destination notes',()=>{
  const score=authored(),original=bars(score).map(bar=>bar.voices[0].beats.map(beat=>beat.notes[0].fret));
  expect(simile(score,1,'single')).toBe(true);
  expect(noteOns(score).slice(0,8).map(note=>note.key)).toEqual([40,41,42,43,40,41,42,43]);
  simile(score,1,'none');expect(simile(score,2,'double')).toBe(true);
  expect(bars(score).map(bar=>bar.simileMark)).toEqual([0,0,2,3]);
  expect(noteOns(score).map(note=>note.key)).toEqual([40,41,42,43,45,46,47,48,40,41,42,43,45,46,47,48]);
  expect(bars(score).map(bar=>bar.voices[0].beats.map(beat=>beat.notes[0].fret))).toEqual(original);
  const imported=importer.ScoreLoader.loadScoreFromBytes(gp(score),settings);
  expect(bars(imported).map(bar=>bar.simileMark)).toEqual([0,0,2,3]);
  expect(noteOns(imported).map(note=>note.key)).toEqual([40,41,42,43,45,46,47,48,40,41,42,43,45,46,47,48]);
});

it.each([2,3])('clearing double half %i atomically reveals original destination notes',bar=>{
  const score=authored();simile(score,2,'double');simile(score,bar,'none');
  expect(bars(score).map(bar=>bar.simileMark)).toEqual([0,0,0,0]);
  expect(noteOns(score).map(note=>note.key)).toEqual([40,41,42,43,45,46,47,48,50,51,52,53,55,56,57,58]);
});

it('replacing either member clears the existing double pair before assigning the new symbol',()=>{
  const score=authored();simile(score,2,'double');simile(score,3,'single');
  expect(bars(score).map(bar=>bar.simileMark)).toEqual([0,0,0,1]);
  expect(noteOns(score).slice(-4).map(note=>note.key)).toEqual([50,51,52,53]);
  simile(score,3,'none');simile(score,2,'double');simile(score,2,'single');
  expect(bars(score).map(bar=>bar.simileMark)).toEqual([0,0,1,0]);
});

it.each([
  {bar:0,kind:'single'},{bar:0,kind:'double'},{bar:1,kind:'double'},{bar:3,kind:'double'},
  {bar:-1,kind:'none'},{bar:1.5,kind:'none'},{bar:2,kind:'triple'},
  {bar:2,kind:'single',track:9},{bar:2,kind:'single',staff:1},
])('simile_rejects_orphans_and_wrong_meter_atomically: %j',invalid=>{
  const score=authored(),before=snapshot(score);
  expect(()=>applyBarGestureEdit(score,{type:'setSimile',track:0,staff:0,...invalid} as BarGestureCommand)).toThrow();
  expect(snapshot(score)).toBe(before);
});

it.each([2,3])('rejects malformed existing double half %i even when clearing',mark=>{
  const score=authored();bars(score)[2].simileMark=mark;const before=snapshot(score);
  expect(()=>simile(score,2,'none')).toThrow(/simile|pair/i);expect(snapshot(score)).toBe(before);
});

it('rejects mismatched meter, pickup duration and double follower without partial pair clearing',()=>{
  const score=authored();simile(score,2,'double');score.masterBars[1].timeSignatureNumerator=3;
  let before=snapshot(score);expect(()=>simile(score,2,'single')).toThrow(/duration|meter/i);expect(snapshot(score)).toBe(before);
  score.masterBars[1].timeSignatureNumerator=4;score.masterBars[0].isAnacrusis=true;bars(score)[0].voices[0].beats.pop();score.finish(settings);
  before=snapshot(score);expect(()=>simile(score,1,'single')).toThrow(/duration|meter/i);expect(snapshot(score)).toBe(before);
  score.masterBars[0].isAnacrusis=false;score.masterBars[3].timeSignatureDenominator=8;
  before=snapshot(score);expect(()=>simile(score,2,'double')).toThrow(/duration|meter/i);expect(snapshot(score)).toBe(before);
});

it.each([0,1,2,3,4])('clef ottava %i survives JSON and standard GPIF without changing pitches',clefOttava=>{
  const score=authored(),before=noteOns(score);
  expect(applyBarGestureEdit(score,{type:'setBarGestures',track:0,staff:0,bar:1,clefOttava})).toBe(true);
  expect(bars(reopened(score))[1].clefOttava).toBe(clefOttava);
  expect(bars(importer.ScoreLoader.loadScoreFromBytes(gp(score),settings))[1].clefOttava).toBe(clefOttava);
  expect(noteOns(score)).toEqual(before);expect(bars(score)[0].clefOttava).toBe(2);
});

it('master_and_clef_gestures_validate_before_assignment and retain unrelated notation',()=>{
  const score=authored();score.masterBars[0].section=Object.assign(new model.Section(),{text:'Verse',marker:'A'});
  for(const denominator of [4,2]) {
    score.masterBars[0].timeSignatureNumerator=denominator===4?4:2;score.masterBars[0].timeSignatureDenominator=denominator;
    applyBarGestureEdit(score,masterCommand({commonTime:true,doubleBar:true,tripletFeel:6}));
    const copy=reopened(score);expect(copy.masterBars[0].timeSignatureCommon).toBe(true);expect(copy.masterBars[0].isDoubleBar).toBe(true);expect(copy.masterBars[0].tripletFeel).toBe(6);
    expect(copy.masterBars[0].section?.text).toBe('Verse');expect(copy.masterBars[1].tripletFeel).toBe(0);
  }
  score.masterBars[0].timeSignatureNumerator=3;score.masterBars[0].timeSignatureDenominator=4;const before=snapshot(score);
  expect(()=>applyBarGestureEdit(score,masterCommand({commonTime:true,doubleBar:false,tripletFeel:1}))).toThrow(/common|time/i);expect(snapshot(score)).toBe(before);
});

it('explicit 7/8 beaming groups survive rebuilt standard GPIF and null restores inheritance',()=>{
  const score=authored();score.masterBars[0].timeSignatureNumerator=7;score.masterBars[0].timeSignatureDenominator=8;
  expect(applyBarGestureEdit(score,masterCommand({beaming:{unit:8,groups:[2,2,3]},doubleBar:true,tripletFeel:2}))).toBe(true);
  const output=gp(score),xml=new DOMParser().parseFromString(strFromU8(unzipSync(output)['Content/score.gpif']),'application/xml');
  expect(xml.querySelector('MasterBar > XProperties > XProperty[id="1124139010"] > Int')?.textContent).toBe('8');
  for(const [id,value] of [[1124139264,'2'],[1124139265,'2'],[1124139266,'3']] as const)expect(xml.querySelector(`MasterBar > XProperties > XProperty[id="${id}"] > Int`)?.textContent).toBe(value);
  const copy=importer.ScoreLoader.loadScoreFromBytes(output,settings);
  expect(copy.masterBars[0].beamingRules?.groups.get(8)).toEqual([2,2,3]);expect(copy.masterBars[0].isDoubleBar).toBe(true);expect(copy.masterBars[0].tripletFeel).toBe(2);
  applyBarGestureEdit(score,masterCommand({bar:1,beaming:{unit:8,groups:[4,4]}}));
  applyBarGestureEdit(score,masterCommand({bar:1,beaming:null}));
  expect(score.masterBars[1].beamingRules).toBeUndefined();
  const rebuilt=reopened(score) as model.Score & {masterBars:(model.MasterBar&{actualBeamingRules?:model.BeamingRules})[]};
  expect(rebuilt.masterBars[1].actualBeamingRules?.groups.get(8)).toEqual([2,2,3]);
});

it.each([
  {tripletFeel:-1},{tripletFeel:7},{tripletFeel:1.5},{commonTime:1},{doubleBar:null},{bar:NaN},
  {beaming:{unit:4,groups:[4]}},{beaming:{unit:8,groups:[2,2]}},{beaming:{unit:8,groups:[]}},
  {beaming:{unit:8,groups:[4,0,4]}},{beaming:{unit:8,groups:[4,1.5,2.5]}},{beaming:{unit:8,groups:[4,Infinity]}},
  {beaming:{unit:8,groups:[8],extra:true}},{extra:true},
])('invalid master gesture is atomic: %j',patch=>{
  const score=authored(),before=snapshot(score);
  expect(()=>applyBarGestureEdit(score,masterCommand({doubleBar:true,...patch} as never))).toThrow();expect(snapshot(score)).toBe(before);
});

it.each([-1,5,1.5,NaN])('rejects invalid octave clef %s without mutation',clefOttava=>{
  const score=authored(),before=snapshot(score);
  expect(()=>applyBarGestureEdit(score,{type:'setBarGestures',track:0,staff:0,bar:0,clefOttava})).toThrow();expect(snapshot(score)).toBe(before);
});

it.each([
  [2,8,[0,640,960,1600]],[4,8,[0,720,960,1680]],[6,8,[0,240,960,1200]],
  [1,16,[0,320,480,800]],[3,16,[0,360,480,840]],[5,16,[0,120,480,600]],
  [0,8,[0,480,960,1440]],
] as const)('rhythmic_feels_have_literal_onsets: feel %i duration %i',(tripletFeel,duration,onsets)=>{
  const score=authored();bars(score)[0].voices[0].beats.forEach(beat=>beat.duration=duration);
  expect(applyBarGestureEdit(score,masterCommand({tripletFeel}))).toBe(true);
  expect(noteOns(score).slice(0,4).map(note=>note.tick)).toEqual(onsets);
  applyBarGestureEdit(score,masterCommand());expect(noteOns(score).slice(0,4).map(note=>note.tick)).toEqual(duration===8?[0,480,960,1440]:[0,240,480,720]);
});

it('leaves commands belonging to another router untouched',()=>{
  const score=authored(),before=snapshot(score);expect(applyBarGestureEdit(score,{type:'appendMeasure'} as never)).toBe(false);expect(snapshot(score)).toBe(before);
});
