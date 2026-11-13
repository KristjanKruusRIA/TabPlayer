import { expect,it } from 'vitest';
import { strFromU8,unzipSync } from 'fflate';
import { analyseSmf,buildProbeFile,CASES,conclude,describeFile,GUITAR_TUNING,MAX_FRET,parseSmf,probePlan,stringAndFret } from '../../scripts/fermata-probe.mjs';

// THE-60: the fermata probe (scripts/fermata-probe.mjs). The written files must carry the intended fermatas, and the
// analyser must tell the possible Guitar Pro behaviours apart before any real export exists. The MIDI below is synthetic.
const PPQ=960;
type Mode='none'|'longer'|'tempo'|'shift';
type Ev={tick:number;order:number;bytes:number[]};
const varlen=(n:number)=>{const out=[n&127];for(n=Math.floor(n/128);n>0;n=Math.floor(n/128))out.unshift((n&127)|128);return out;};
function chunk(id:string,body:number[]){const n=body.length;return [...id].map(c=>c.charCodeAt(0)).concat([n>>>24,(n>>16)&255,(n>>8)&255,n&255],body);}
function track(events:Ev[]){
  const sorted=[...events].sort((a,b)=>a.tick-b.tick||a.order-b.order);let last=0;const body:number[]=[];
  for(const e of sorted){body.push(...varlen(e.tick-last),...e.bytes);last=e.tick;}
  body.push(...varlen(0),255,47,0);return chunk('MTrk',body);
}
const tempoBytes=(bpm:number)=>{const us=Math.round(60e6/bpm);return [255,81,3,(us>>16)&255,(us>>8)&255,us&255];};
type Add=(c:{id:string})=>number;
/** Builds the probe's MIDI as Guitar Pro might have written it under one hypothetical behaviour. `add` is the hold in ticks. */
function synth(mode:Mode,bpm:number,add:Add=()=>PPQ,rekey:(key:number)=>number=key=>key){
  const plan=probePlan(),holds:{at:number;add:number}[]=[],tempo=[{tick:0,bpm}];
  for(const bar of plan)if(bar.case){
    const start=(bar.index*4+bar.case.beat)*PPQ,end=start+PPQ;
    if(mode==='shift')holds.push({at:end,add:add(bar.case)});
    if(mode==='tempo')tempo.push({tick:start,bpm:bpm/2},{tick:end,bpm});
  }
  const map=(t:number)=>t+holds.filter(h=>t>=h.at).reduce((s,h)=>s+h.add,0);
  const t0=track(tempo.map(t=>({tick:t.tick,order:0,bytes:tempoBytes(t.bpm)})));
  const build=(key:'t1'|'t2',channel:number)=>{
    const ev:Ev[]=[];
    for(const bar of plan)for(const note of bar[key]){
      const on=(bar.index*4+note.start)*PPQ;let off=on+note.dur*PPQ;
      if(mode==='longer'&&key==='t1'&&bar.case&&note.start===bar.case.beat)off+=add(bar.case);
      ev.push({tick:map(on),order:1,bytes:[0x90|channel,rekey(note.key),80]},{tick:map(off),order:0,bytes:[0x80|channel,rekey(note.key),0]});
    }
    return track(ev);
  };
  return new Uint8Array([...chunk('MThd',[0,1,0,3,PPQ>>8,PPQ&255]),...t0,...build('t1',0),...build('t2',1)]);
}
const analyse=(mode:Mode,bpm:number,add?:Add,rekey?:(key:number)=>number)=>{
  const smf=parseSmf(synth(mode,bpm,add,rekey));expect(smf.warnings).toEqual([]);
  return {name:`synthetic-${mode}-${bpm}.mid`,bpm,result:analyseSmf(smf,bpm)};
};
const text=(files:ReturnType<typeof analyse>[])=>conclude(files).join('\n');
const gcd=(a:number,b:number):number=>b?gcd(b,a%b):a;

it('writes the probe files with the intended fermata Type, Length and Offset on the right bars, and nothing else',()=>{
  for(const bpm of [120,60]){
    const gpif=strFromU8(unzipSync(buildProbeFile(bpm))['Content/score.gpif']);
    expect(gpif).toContain(`<Value>${bpm} 2</Value>`);
    const bars=gpif.split('</MasterBar>').slice(0,-1);
    const plan=probePlan();expect(bars).toHaveLength(plan.length);
    const found=bars.map(bar=>[...bar.matchAll(/<Fermata><Type>(\w+)<\/Type><Length>([\d.]+)<\/Length><Offset>([\d/]+)<\/Offset><\/Fermata>/g)].map(m=>[m[1],Number(m[2]),m[3]]));
    plan.forEach((bar,i)=>{
      if(!bar.case){expect(found[i]).toEqual([]);return;}
      const ticks=bar.case.beat*960,divisor=gcd(ticks,960);
      expect(found[i]).toEqual([[bar.case.type,bar.case.length,`${ticks/divisor}/${960/divisor}`]]);
    });
    expect(found.flat()).toHaveLength(CASES.length);
    // Identifiable case bars: the id is in the beat text and the section label names the case.
    for(const bar of plan.filter(b=>b.case)){expect(gpif).toContain(`<![CDATA[${bar.case!.id}]]>`);expect(gpif).toContain(`${bar.case!.id}: ${bar.case!.label}`);}
  }
  expect([...new Set(CASES.map(c=>c.length))].sort()).toEqual([0,0.5,1,2]);
  expect(new Set(CASES.map(c=>c.type))).toEqual(new Set(['Short','Medium','Long']));
});

it('reads running status, tempo events and notes, and survives truncated and odd input without throwing',()=>{
  // Running status: one 0x90 status byte, then more note-ons; releases are note-ons with velocity 0.
  const body=[0,255,81,3,7,161,32, 0,0x90,60,100, 10,62,100, 10,60,0, 10,62,0, 0,255,47,0];
  const smf=parseSmf(new Uint8Array([...chunk('MThd',[0,0,0,1,1,224]),...chunk('MTrk',body)]));
  expect(smf.warnings).toEqual([]);expect(smf.ppq).toBe(480);
  expect(smf.tempos).toEqual([{tick:0,usPerQuarter:500000,track:0}]);
  expect(smf.notes.map(n=>[n.key,n.on,n.off])).toEqual([[60,0,20],[62,10,30]]);
  const whole=synth('none',120);
  for(const cut of [0,3,13,14,20,50,whole.length-1,whole.length>>1])expect(()=>parseSmf(whole.slice(0,cut))).not.toThrow();
  expect(parseSmf(whole.slice(0,whole.length>>1)).warnings.length).toBeGreaterThan(0);
  expect(parseSmf(new Uint8Array([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16])).ok).toBe(false);
  expect(parseSmf(whole,100).ok).toBe(false);
  const noise=new Uint8Array(4000).map((_,i)=>(i*2654435761>>>24)&255);noise.set(whole.slice(0,14));
  expect(()=>analyseSmf(parseSmf(noise),120)).not.toThrow();
  expect(analyseSmf(parseSmf(whole.slice(0,whole.length>>1)),120).problems.length).toBeGreaterThan(0);
});

it('finds no difference when the export contains no hold',()=>{
  const none=analyse('none',120);
  expect(none.result.cases).toHaveLength(CASES.length);
  expect(none.result.cases.every(c=>c.mechanism==='none')).toBe(true);
  const out=text([none]);
  expect(out).toContain('No difference at all');
  expect(out).toContain('contains no hold for any fermata type or length tried');
});

it('recognises longer notes at constant tempo with later events and the sustain track unmoved',()=>{
  const longer=analyse('longer',120);
  const byId=new Map(longer.result.cases.map(c=>[c.id,c]));
  expect(byId.get('medium-0')!.mechanism).toBe('longer-only');
  expect(byId.get('rest')!.mechanism).toBe('none');
  expect(byId.get('medium-0')!.added1.ticks).toBe(0);
  const out=text([longer]);
  expect(out).toContain('the fermata note is longer, later events are not moved');
  expect(out).not.toContain('inserted tempo events');
  expect(describeFile(longer.name,longer.result).join('\n')).toContain('-> longer-only');
});

it('recognises inserted tempo changes with the tick grid unchanged',()=>{
  const tempo=analyse('tempo',120);
  expect(tempo.result.cases.every(c=>c.mechanism==='tempo')).toBe(true);
  const medium=tempo.result.cases.find(c=>c.id==='medium-0')!;
  expect(medium.added1.ticks).toBe(0);expect(medium.added1.seconds).toBeCloseTo(0.5,6);
  const out=text([tempo]);
  expect(out).toContain('inserted tempo events');
  expect(out).toContain('The sustain track is delayed by the same amount');
});

it('recognises a shift of all later events on both tracks, and separates constant beats from constant seconds across tempos',()=>{
  const fast=analyse('shift',120),slow=analyse('shift',60);
  expect(fast.result.cases.every(c=>c.mechanism==='shift')).toBe(true);
  const out=text([fast,slow]);
  expect(out).toContain('later events moved later in ticks at constant tempo');
  expect(out).toContain('applies to every track');
  expect(out).toContain('same number of beats at both tempos (constant beats');
  // A hold of half a second at either tempo is 960 ticks at 120 BPM and 480 ticks at 60 BPM.
  const bySeconds=(bpm:number)=>analyse('shift',bpm,()=>bpm===120?960:480);
  expect(text([bySeconds(120),bySeconds(60)])).toContain('same number of seconds at both tempos (constant seconds)');
  // Time proportional to the note length: a half note holds twice as long as a quarter, an eighth half as long.
  const proportional=analyse('shift',120,c=>c.id==='half-note'?2*PPQ:c.id==='eighth-note'?PPQ/2:PPQ);
  expect(text([proportional])).toContain("scales with the note's length");
  expect(text([fast])).toContain('cannot be told apart without the other tempo');
});

it('says so when the file does not match the probe',()=>{
  const smf=parseSmf(new Uint8Array([...chunk('MThd',[0,0,0,1,3,192]),...track([{tick:0,order:1,bytes:[0x90,72,80]},{tick:100,order:0,bytes:[0x80,72,0]}])]));
  const file={name:'odd.mid',bpm:120,result:analyseSmf(smf,120)};
  expect(file.result.problems.join(' ')).toContain('notes found');
  expect(conclude([file]).join('\n')).toContain('No usable file');
});

it('writes every probe note as a stringed note on a standard-tuned guitar staff, keeping the key split between the tracks',()=>{
  // The first probe wrote bare pitched notes on a staff with no tuning and Guitar Pro 8 exported all of them at key 0.
  expect(GUITAR_TUNING).toEqual([64,59,55,50,45,40]);
  const plan=probePlan();
  for(const bar of plan)for(const note of [...bar.t1,...bar.t2]){
    const {string,fret}=stringAndFret(note.key);
    expect(fret).toBeGreaterThanOrEqual(0);expect(fret).toBeLessThanOrEqual(MAX_FRET);
    expect(GUITAR_TUNING[GUITAR_TUNING.length-string]+fret).toBe(note.key);
  }
  expect(stringAndFret(40)).toEqual({string:1,fret:0});expect(stringAndFret(72)).toEqual({string:6,fret:8});
  expect(()=>stringAndFret(39)).toThrow();
  expect(Math.min(...plan.flatMap(bar=>bar.t1.map(n=>n.key)))).toBeGreaterThanOrEqual(60);
  expect(Math.max(...plan.flatMap(bar=>bar.t2.map(n=>n.key)))).toBeLessThan(60);
  for(const bpm of [120,60]){
    const gpif=strFromU8(unzipSync(buildProbeFile(bpm))['Content/score.gpif']);
    expect(gpif.match(/<Property name="Tuning"><Pitches>[\d ]+<\/Pitches>/g)).toEqual(Array(2).fill('<Property name="Tuning"><Pitches>40 45 50 55 59 64</Pitches>'));
    const notes=[...gpif.matchAll(/<Note id="\d+"><Properties>(.*?)<\/Properties>/g)].map(m=>m[1]);
    expect(notes).toHaveLength(107+69);
    expect(gpif).not.toContain('<Property name="Octave">');
    // GPIF numbers strings from 0 at the lowest, and Midi is the string's open pitch plus the fret.
    const keys=notes.map(props=>{
      const string=Number(/<Property name="String"><String>(\d+)<\/String>/.exec(props)?.[1]),fret=Number(/<Property name="Fret"><Fret>(\d+)<\/Fret>/.exec(props)?.[1]),midi=Number(/<Property name="Midi"><Number>(\d+)<\/Number>/.exec(props)?.[1]);
      expect(string).toBeGreaterThanOrEqual(0);expect(string).toBeLessThanOrEqual(5);
      expect(midi).toBe(GUITAR_TUNING[GUITAR_TUNING.length-1-string]+fret);return midi;
    });
    expect(keys.filter(key=>key>=60)).toHaveLength(107);expect(keys.filter(key=>key<60)).toHaveLength(69);
  }
});

it('falls back to matching by track and note count when the keys are wrong, says so, and still finds the same mechanism',()=>{
  // Guitar Pro 8 exported every note of the first probe at key 0; this mimics that with the synthetic shift export.
  const keyed=analyse('shift',120),flat=analyse('shift',120,undefined,()=>0);
  expect(keyed.result.matchedBy).toBe('keys');expect(keyed.result.keyNote).toBeNull();
  expect(flat.result.matchedBy).toBe('track');expect(flat.result.problems).toEqual([]);
  expect(flat.result.keyNote).toContain('Matched by track and note count because the keys did not match the layout');
  expect(flat.result.keyNote).toContain('track 1 has 107 notes (the fermata track) and track 2 has 69 (the sustain track)');
  expect(flat.result.keyNote).toContain('Keys seen: 0 ');
  expect(flat.result.cases.map(c=>c.mechanism)).toEqual(keyed.result.cases.map(c=>c.mechanism));
  expect(flat.result.cases.map(c=>c.added1)).toEqual(keyed.result.cases.map(c=>c.added1));
  expect(describeFile(flat.name,flat.result).join('\n')).toContain('Matched by track and note count');
  const out=text([analyse('none',60,undefined,()=>0)]);
  expect(out).toContain('Caveat 1: these notes were matched by track and note count');
  expect(out).toContain('Caveat 2: nothing in the MIDI shows whether Guitar Pro read the fermatas');
  expect(text([analyse('none',60)])).not.toContain('Caveat 1');
  // Keys that are wrong but not all equal still match by track.
  const odd=analyse('none',120,undefined,key=>key%7);
  expect(odd.result.matchedBy).toBe('track');expect(odd.result.keyNote).toContain('Keys seen: 0, 1, 2, 3, 4, 5, 6');
});

it('still refuses when neither the keys nor the track note counts match the layout',()=>{
  const smf=parseSmf(synth('none',120,undefined,()=>0));expect(smf.warnings).toEqual([]);
  smf.notes.splice(smf.notes.findIndex(n=>n.track===1),1);
  const short=analyseSmf(smf,120);
  expect(short.problems.join(' ')).toContain('Matching by track and note count did not work either');
  expect(short.problems.join(' ')).toContain('track 1: 106, track 2: 69');expect(short.cases).toEqual([]);
  // Both tracks merged into one: no track has the right count.
  const merged=parseSmf(synth('none',120,undefined,()=>0));merged.notes.forEach(n=>{n.track=1;});
  expect(analyseSmf(merged,120).problems.join(' ')).toContain('Matching by track and note count did not work either');
  expect(conclude([{name:'bad.mid',bpm:120,result:short}]).join('\n')).toContain('No usable file');
});
