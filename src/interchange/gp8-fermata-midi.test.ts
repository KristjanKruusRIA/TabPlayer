import { readFileSync } from 'node:fs';
import { expect,it } from 'vitest';
import { analyseSmf,CASES,conclude,describeFile,parseSmf,probePlan } from '../../scripts/fermata-probe.mjs';

// THE-60 evidence. The two files below are what an activated Guitar Pro 8 exported as MIDI on 2026-11-12 from the probe written by
// scripts/fermata-probe.mjs as it stood then (see fixtures/fermata-probe.gp8.README.md). That probe had a defect: Guitar Pro put
// every note at MIDI key 0, so the analyser matches by track. Nobody confirmed the fermata symbols were visible in Guitar Pro.
const load=(bpm:number)=>parseSmf(new Uint8Array(readFileSync(new URL(`./fixtures/fermata-probe-${bpm}.gp8.mid`,import.meta.url))));
const files=[120,60].map(bpm=>({bpm,smf:load(bpm)}));
const onTrack=(smf:ReturnType<typeof load>,index:number)=>smf.notes.filter(n=>n.track===index).sort((a,b)=>a.on-b.on);
const QUARTER=480,HALF=960,EIGHTH=240,WHOLE=1920,BAR=1920;

it("the MIDI Guitar Pro 8 exported from the fermata probe contains no hold, whether or not it read the fermatas: the structure of the two committed exports",()=>{
  for(const {bpm,smf} of files){
    expect(smf.warnings).toEqual([]);
    expect(smf.format).toBe(1);expect(smf.tracks).toBe(3);expect(smf.declaredTracks).toBe(3);expect(smf.ppq).toBe(480);
    // One tempo event, on the tempo track at tick 0, and no other tempo anywhere (so no tempo-based hold).
    expect(smf.tempos).toEqual([{tick:0,usPerQuarter:bpm===120?500000:1000000,track:0}]);
    expect(smf.notes).toHaveLength(107+69);
    expect(onTrack(smf,0)).toHaveLength(0);expect(onTrack(smf,1)).toHaveLength(107);expect(onTrack(smf,2)).toHaveLength(69);
    // Probe defect, not a finding about fermatas: Guitar Pro exported every note at key 0.
    expect(new Set(smf.notes.map(n=>n.key))).toEqual(new Set([0]));
    // 27 bars of 1920 ticks, and nothing runs past the last bar.
    expect(27*BAR).toBe(51840);
    expect(Math.max(...smf.notes.map(n=>n.off!))).toBe(51840);
    expect(Math.max(...smf.notes.map(n=>n.on))).toBe(51840-QUARTER);
  }
});

it('every onset and length is the written value in every fermata bar and control bar, at both tempos, and the files agree in ticks',()=>{
  const plan=probePlan();expect(plan).toHaveLength(27);
  for(const {smf} of files){
    const fermata=onTrack(smf,1),sustain=onTrack(smf,2);
    const written=(key:'t1'|'t2')=>plan.flatMap(bar=>bar[key].map(n=>({on:(bar.index*4+n.start)*QUARTER,len:n.dur*QUARTER})));
    expect(fermata.map(n=>({on:n.on,len:n.off!-n.on}))).toEqual(written('t1'));
    expect(sustain.map(n=>({on:n.on,len:n.off!-n.on}))).toEqual(written('t2'));
    // Literal spot checks. Bar 2 is the Short, Length 0 case: four quarters, the fermata on beat 3 (tick 1920+960 = 2880).
    expect(fermata.slice(4,8).map(n=>[n.on,n.off])).toEqual([[1920,2400],[2400,2880],[2880,3360],[3360,3840]]);
    // Bar 24 (half-note case): quarter, quarter, half. Bar 26 (eighth-note case): quarter, quarter, eighth, eighth, quarter.
    const inBar=(bar:number)=>fermata.filter(n=>n.on>=(bar-1)*BAR&&n.on<bar*BAR).map(n=>[n.on-(bar-1)*BAR,n.off!-n.on]);
    expect(inBar(24)).toEqual([[0,QUARTER],[QUARTER,QUARTER],[2*QUARTER,HALF]]);
    expect(inBar(26)).toEqual([[0,QUARTER],[QUARTER,QUARTER],[2*QUARTER,EIGHTH],[2*QUARTER+EIGHTH,EIGHTH],[3*QUARTER,QUARTER]]);
    // The sustain whole notes (one per case bar, bars 2, 4 ... 26) are exactly one bar long.
    const wholes=sustain.filter(n=>n.off!-n.on===WHOLE);
    expect(wholes).toHaveLength(13);expect(wholes.map(n=>n.on/BAR+1)).toEqual(CASES.map((_,i)=>2+2*i));
    expect(new Set(fermata.map(n=>n.off!-n.on))).toEqual(new Set([QUARTER,HALF,EIGHTH]));
    expect(new Set(sustain.map(n=>n.off!-n.on))).toEqual(new Set([QUARTER,WHOLE]));
  }
  const [a,b]=files;
  const ticks=(smf:typeof a.smf)=>smf.notes.map(n=>[n.track,n.channel,n.key,n.velocity,n.on,n.off]);
  expect(ticks(a.smf)).toEqual(ticks(b.smf));
  expect(a.smf.tempos[0].usPerQuarter*2).toBe(b.smf.tempos[0].usPerQuarter);
});

it('the analyser reads both exports by track, finds no mechanism in any of the 13 cases, and states the finding and both caveats',()=>{
  const analysed=files.map(({bpm,smf})=>({name:`fermata-probe-${bpm}.gp8.mid`,bpm,result:analyseSmf(smf,bpm)}));
  for(const {result} of analysed){
    expect(result.problems).toEqual([]);expect(result.matchedBy).toBe('track');expect(result.cases).toHaveLength(13);
    expect(result.keyNote).toContain('Keys seen: 0 ');
    expect(result.cases.every(c=>c.mechanism==='none')).toBe(true);
    expect(result.cases.every(c=>c.added1.ticks===0&&c.added2.ticks===0&&c.added1.seconds===0)).toBe(true);
    expect(describeFile('x',result).join('\n')).toContain('Matched by track and note count');
  }
  const out=conclude(analysed).join('\n');
  expect(out.match(/The MIDI Guitar Pro exported from this probe contains no hold for any fermata type or length tried; it is not established that Guitar Pro read the fermatas/g)).toHaveLength(2);
  expect(out.match(/Caveat 1: these notes were matched by track and note count/g)).toHaveLength(2);
  expect(out.match(/the first probe wrote notes that Guitar Pro exported at key 0/g)).toHaveLength(2);
  expect(out.match(/Caveat 2: nothing in the MIDI shows whether Guitar Pro read the fermatas at all/g)).toHaveLength(2);
  expect(out).toContain('Tempo: no added time at either tempo');
});

it('the committed layout is the one the exports were made from: 27 bars and the 13 cases with their types, lengths and positions',()=>{
  const layout=JSON.parse(readFileSync(new URL('./fixtures/fermata-probe.layout.json',import.meta.url),'utf8')) as {bar:number;name:string;fermata:{type:string;length:number;offsetTicks:number}|null}[];
  expect(layout.map(l=>l.bar)).toEqual(Array.from({length:27},(_,i)=>i+1));
  expect(layout.filter(l=>l.fermata).map(l=>[l.name.split(':')[0],l.fermata!.type,l.fermata!.length,l.fermata!.offsetTicks])).toEqual(CASES.map(c=>[c.id,c.type,c.length,c.beat*960]));
});
