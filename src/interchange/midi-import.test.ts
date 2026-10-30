import { describe,expect,it } from 'vitest';
import { model,Settings } from '@coderline/alphatab';
import { defaultMidiImportOptions,importMidi,midiImportFileName,type MidiImportOptions } from './midi-import';
import { readMidiFile } from './midi-smf';
import { exportGpInterchange,loadInterchangeScore } from './gp';

type Ev=[number,number[]];
const vlq=(value:number)=>{const out=[value&0x7f];while((value>>=7)>0)out.unshift((value&0x7f)|0x80);return out;};
const track=(events:Ev[],end=true)=>{
  const body=events.flatMap(([delta,data])=>[...vlq(delta),...data]);if(end)body.push(0,0xff,0x2f,0);
  return [0x4d,0x54,0x72,0x6b,body.length>>>24,body.length>>16&255,body.length>>8&255,body.length&255,...body];
};
const file=(format:number,division:number,tracks:number[][],count=tracks.length)=>new Uint8Array([0x4d,0x54,0x68,0x64,0,0,0,6,0,format,0,count,division>>8,division&255,...tracks.flat()]);
const text=(type:number,value:string)=>[0xff,type,value.length,...[...value].map(char=>char.charCodeAt(0))];
const tempo=(bpm:number)=>{const micros=Math.round(60e6/bpm);return [0xff,0x51,3,micros>>16&255,micros>>8&255,micros&255];};
const meter=(numerator:number,denominator:number)=>[0xff,0x58,4,numerator,Math.log2(denominator),24,8];
const on=(key:number,channel=0,velocity=90)=>[0x90|channel,key,velocity];
const off=(key:number,channel=0)=>[0x80|channel,key,0];
const program=(value:number,channel=0)=>[0xc0|channel,value];
/** Notes as [start tick, length ticks, key]. */
function line(notes:[number,number,number][],channel=0,lead:Ev[]=[]):Ev[] {
  const events=notes.flatMap(([start,length,key])=>[[start,on(key,channel)],[start+length,off(key,channel)]] as [number,number[]][]).sort((a,b)=>a[0]-b[0]||(a[1][0]&0xf0)-(b[1][0]&0xf0));
  let last=0;return [...lead,...events.map(([at,data])=>{const delta=at-last;last=at;return [delta,data] as Ev;})];
}
const options=(patch:Partial<MidiImportOptions>={}):MidiImportOptions=>({...defaultMidiImportOptions,...patch});
const run=(bytes:Uint8Array,patch:Partial<MidiImportOptions>={})=>importMidi(readMidiFile(bytes),options(patch),'Fallback');
const beatsOf=(score:model.Score,trackIndex=0,bar=0,voice=0)=>score.tracks[trackIndex].staves[0].bars[bar].voices[voice].beats;
const shape=(beats:model.Beat[])=>beats.map(beat=>`${beat.duration}${'.'.repeat(beat.dots)}${beat.tupletNumerator>1?`t${beat.tupletNumerator}`:''}${beat.notes.length?'*':'r'}`);
const settings=new Settings();

describe('readMidiFile',()=>{
  it('reads a format 0 file with running status, tempo, meter, key, names and unclosed notes',()=>{
    const events:Ev[]=[[0,text(3,'Riff')],[0,tempo(90)],[0,meter(3,4)],[0,[0xff,0x59,2,0xfe,0]],[0,[0xc0,25]],[0,[0x90,60,90]],[240,[62,90]],[240,[60,0]],[0,[62,0]],[0,[0x90,64,80]]];
    const song=readMidiFile(file(0,480,[track(events)]));
    expect(song).toMatchObject({format:0,division:480,title:'Riff',tempos:[{tick:0,microsPerQuarter:666667}],meters:[{tick:0,numerator:3,denominator:4}],keys:[{tick:0,sharps:-2,minor:false}]});
    expect(song.parts[0].notes.map(note=>[note.key,note.start,note.end])).toEqual([[60,0,480],[62,240,480],[64,480,480]]);
    expect(song.parts[0].programs).toEqual([{tick:0,channel:0,program:25}]);
  });
  it('keeps the conductor track of a format 1 file apart from note tracks and takes the title from it',()=>{
    const song=readMidiFile(file(1,96,[track([[0,text(3,'Song')],[0,tempo(100)]]),track([[0,text(3,'Lead')],...line([[0,96,60]])])]));
    expect(song.title).toBe('Song');expect(song.parts.map(part=>[part.index,part.name])).toEqual([[1,'Lead']]);
  });
  it('lets the last of several events at one tick win and skips unknown chunks',()=>{
    const odd=[0x58,0x58,0x58,0x58,0,0,0,2,1,2];
    const song=readMidiFile(file(1,480,[track([[0,tempo(60)],[0,tempo(120)]]),odd,track(line([[0,480,60]]))],2));
    expect(song.tempos).toEqual([{tick:0,microsPerQuarter:500000}]);
  });
  it.each([
    ['not MIDI',new Uint8Array([1,2,3,4,5,6,7,8,9,10,11,12,13,14]),/not a Standard MIDI File/],
    ['empty',new Uint8Array(),/not a Standard MIDI File/],
    ['RIFF-wrapped',new Uint8Array([0x52,0x49,0x46,0x46,0,0,0,0]),/RIFF-wrapped/],
    ['format 2',file(2,480,[track(line([[0,480,60]]))]),/Format 2/],
    ['SMPTE timing',file(1,0xe728,[track(line([[0,480,60]]))]),/SMPTE/],
    ['zero division',file(1,0,[track(line([[0,480,60]]))]),/time division is zero/],
    ['format 0 with two tracks',file(0,480,[track([]),track([])]),/exactly one track/],
    ['a missing track',file(1,480,[track(line([[0,480,60]]))],3),/2 of 3 tracks are missing/],
    ['a cut-off track chunk',file(1,480,[track(line([[0,480,60]])).slice(0,-4)]),/track 1 is cut off/],
    ['a data byte above 127',file(1,480,[track([[0,[0x90,200,90]]])]),/data byte above 127/],
    ['running status with nothing before it',file(1,480,[track([[0,[60,90]]])]),/no status byte/],
    ['a cut-off meta event',file(1,480,[track([[0,[0xff,0x51,3,1]]],false)]),/cut off/],
    ['a tempo event of the wrong size',file(1,480,[track([[0,[0xff,0x51,2,1,2]]])]),/wrong size/],
    ['a system event',file(1,480,[track([[0,[0xf8]]])]),/system event/],
    ['a file without notes',file(1,480,[track([[0,tempo(100)]])]),/no notes/],
  ])('refuses %s',(_name,bytes,message)=>{
    expect(()=>readMidiFile(bytes)).toThrow(message);
  });
  it('refuses an event time longer than four bytes',()=>{
    expect(()=>readMidiFile(file(1,480,[[0x4d,0x54,0x72,0x6b,0,0,0,7,0x81,0x81,0x81,0x81,0x81,0x90,60]]))).toThrow(/longer than four bytes/);
  });
});

describe('importMidi rhythm',()=>{
  const sixteenths=file(1,480,[track([[0,tempo(100)],[0,meter(4,4)]]),track(line([0,1,2,3].map(index=>[index*120,120,60+index] as [number,number,number]).concat([[480,480,67],[960,960,69]])))]);
  it('quantizes to the chosen smallest note value and fills every bar',()=>{
    const {score}=run(sixteenths);
    expect(score.masterBars).toHaveLength(1);
    expect(shape(beatsOf(score))).toEqual(['16*','16*','16*','16*','4*','2*']);
    expect(score.tempo).toBe(100);
  });
  it('snaps loose playing to the grid it is given',()=>{
    // Starts drift by up to 40 ticks (a 12th of a beat at most): the eighth grid pulls them to eighths, the 32nd grid to 32nds.
    const loose=file(1,480,[track(line([[7,230,60],[250,235,62],[497,240,64],[731,230,65],[960,960,67]]))]);
    expect(shape(beatsOf(run(loose,{quantization:8}).score))).toEqual(['8*','8*','8*','8*','2*']);
    const fine=run(loose,{quantization:32}).score;
    expect(beatsOf(fine).filter(beat=>beat.notes.length).length).toBeGreaterThanOrEqual(5);
  });
  it('writes a note that reaches across a bar line as tied notes',()=>{
    const {score}=run(file(1,480,[track(line([[960,1920,60]]))]));
    expect(score.masterBars).toHaveLength(2);
    expect(shape(beatsOf(score,0,0))).toEqual(['2r','2*']);expect(shape(beatsOf(score,0,1))).toEqual(['2*','2r']);
    const tied=beatsOf(score,0,1)[0].notes[0];
    expect(tied.isTieDestination).toBe(true);expect(tied.tieOrigin).toBe(beatsOf(score,0,0)[1].notes[0]);
  });
  it('follows time signature changes at bar lines and moves one inside a bar to the next bar line',()=>{
    const conductor=track([[0,meter(3,4)],[1500,meter(6,8)]]);
    const {score,summary}=run(file(1,480,[conductor,track(line([[0,3840,60]]))]));
    expect(score.masterBars.map(bar=>`${bar.timeSignatureNumerator}/${bar.timeSignatureDenominator}`).slice(0,3)).toEqual(['3/4','3/4','6/8']);
    expect(summary.notes.join(' ')).toMatch(/inside a measure moved to the next bar line/);
  });
  it('writes tempo changes at their position in the bar and starts at 120 when the file gives no tempo',()=>{
    const {score}=run(file(1,480,[track([[960,tempo(80)],[960,tempo(80)],[960,tempo(140)]]),track(line([[0,3840,60]]))]));
    const automations=score.masterBars.flatMap((bar,index)=>bar.tempoAutomations.map(item=>[index,item.ratioPosition,item.value]));
    expect(automations).toEqual([[0,0,120],[0,0.5,80],[1,0.5,140]]);
  });
});

describe('importMidi tuplets',()=>{
  const triplets=[0,160,320,480,640,800].map(start=>[start,160,60+start/160] as [number,number,number]);
  const bytes=file(1,480,[track(line([...triplets,[960,960,67]]))]);
  it('detects eighth-note triplets and writes them as 3:2 tuplets',()=>{
    const {score}=run(bytes);
    expect(shape(beatsOf(score))).toEqual(['8t3*','8t3*','8t3*','8t3*','8t3*','8t3*','2*']);
    expect(beatsOf(score)[0].tupletDenominator).toBe(2);
  });
  it('keeps a quantization with tuplets off on the straight grid',()=>{
    const {score}=run(bytes,{tuplets:'none'});
    expect(beatsOf(score).some(beat=>beat.tupletNumerator>1)).toBe(false);
  });
  it('does not turn straight playing into tuplets',()=>{
    const straight=file(1,480,[track(line([0,1,2,3].map(index=>[index*120,120,60+index] as [number,number,number])))]);
    expect(beatsOf(run(straight,{tuplets:'triplets-quintuplets'}).score).some(beat=>beat.tupletNumerator>1)).toBe(false);
  });
  it('writes a tuplet with a held note and a rest through ties and rests',()=>{
    // Triplet eighths: a note on the first, rest, then a note held across the last two.
    const {score}=run(file(1,480,[track(line([[0,160,60],[320,160,64],[480,480,67]]))]));
    expect(shape(beatsOf(score)).slice(0,4)).toEqual(['8t3*','8t3r','8t3*','4*']);
  });
  it('detects quintuplets only when asked for them',()=>{
    const fives=[0,1,2,3,4].map(index=>[index*96,96,60+index] as [number,number,number]);
    const quint=file(1,480,[track(line([...fives,[480,1440,67]]))]);
    expect(shape(beatsOf(run(quint,{tuplets:'triplets-quintuplets'}).score).slice(0,5))).toEqual(Array(5).fill('16t5*'));
    expect(beatsOf(run(quint,{tuplets:'triplets'}).score).some(beat=>beat.tupletNumerator===5)).toBe(false);
  });
  it('uses a sixteenth-triplet grid when the smallest note value is a 16th',()=>{
    const sixes=[0,1,2,3,4,5].map(index=>[index*80,80,60+index] as [number,number,number]);
    const {score}=run(file(1,480,[track(line([...sixes,[480,1440,67]]))]),{quantization:16});
    expect(shape(beatsOf(score).slice(0,6))).toEqual(Array(6).fill('16t3*'));
  });
});

describe('importMidi voices, programs and instruments',()=>{
  const bassAndMelody=line([[0,1920,36],[0,480,72],[480,480,74],[960,480,76],[1440,480,77]]);
  it('puts overlapping notes in separate voices and fills the second voice with rests',()=>{
    const {score,summary}=run(file(1,480,[track(bassAndMelody)]),{voices:2});
    expect(summary.tracks[0].voices).toBe(2);
    const bar=score.tracks[0].staves[0].bars[0];expect(bar.voices).toHaveLength(2);
    expect(bar.voices.map(voice=>shape(voice.beats))).toEqual([['4*','4*','4*','4*'],['1*']]);
    expect(bar.voices[0].beats.map(beat=>beat.notes[0].tone+beat.notes[0].octave*12)).toEqual([72,74,76,77]);
  });
  it('cuts overlapping notes short with one voice and says so',()=>{
    const {score,summary}=run(file(1,480,[track(line([[0,1920,36],[480,480,72]]))]),{voices:1});
    expect(score.tracks[0].staves[0].bars[0].voices).toHaveLength(1);
    expect(summary.notes.join(' ')).toMatch(/cut short/);
  });
  it('fills a later voice with an empty voice in bars where it is silent',()=>{
    const {score}=run(file(1,480,[track(line([[0,1920,36],[0,480,72],[1920,480,60]]))]),{voices:2});
    const second=score.tracks[0].staves[0].bars[1].voices[1];expect(second.isEmpty).toBe(true);
  });
  it('keeps chords whole and gives each channel of a format 0 file its own track with its program',()=>{
    const raw:Ev[]=[[0,program(25,0)],[0,program(33,1)],[0,program(0,2)],[0,on(64,0)],[0,on(40,1)],[0,on(60,2)],[0,on(64,2)],[480,off(64,0)],[0,off(60,2)],[0,off(64,2)],[480,off(40,1)]];
    const {score,summary}=run(file(0,480,[track(raw)]));
    expect(score.tracks.map(item=>item.playbackInfo.program)).toEqual([25,33,0]);
    expect(summary.tracks.map(item=>[item.kind,item.program])).toEqual([['guitar',25],['bass',33],['keys',0]]);
    expect(score.tracks[2].name).toBe('Acoustic Grand Piano');
    expect(beatsOf(score,2)[0].notes).toHaveLength(2);
    const channels=score.tracks.map(item=>item.playbackInfo.primaryChannel);expect(new Set(channels).size).toBe(3);expect(channels).not.toContain(9);
  });
  it('writes guitar and bass as tablature on the lowest frets, one note per string',()=>{
    const {score}=run(file(1,480,[track([[0,program(25)],...line([[0,480,40],[0,480,52],[480,480,64]])])]));
    const staff=score.tracks[0].staves[0];
    expect(staff.tuning).toEqual([64,59,55,50,45,40]);expect(staff.showTablature).toBe(true);
    const [first,second]=staff.bars[0].voices[0].beats;
    expect(first.notes.map(item=>[item.string,item.fret]).sort()).toEqual([[1,0],[3,2]]);
    expect(second.notes.map(item=>[item.string,item.fret])).toEqual([[6,0]]);
  });
  it('imports a guitar part with a note out of range as notation only',()=>{
    const {score,summary}=run(file(1,480,[track([[0,program(25)],...line([[0,480,20],[480,480,60]])])]));
    expect(score.tracks[0].staves[0].tuning).toEqual([]);expect(summary.notes.join(' ')).toMatch(/imported as notation only/);
  });
  it('imports guitar as notation when tablature is switched off',()=>{
    const {score}=run(file(1,480,[track([[0,program(25)],...line([[0,480,60]])])]),{tablature:false});
    expect(score.tracks[0].staves[0].showTablature).toBe(false);
  });
  it('maps channel 10 to a drum track and skips sounds without a drum symbol',()=>{
    const hits=line([[0,10,36],[240,10,42],[480,10,38],[480,10,42],[720,10,5]],9);
    const {score,summary}=run(file(1,480,[track(hits)]));
    const staff=score.tracks[0].staves[0];
    expect(staff.isPercussion).toBe(true);expect(score.tracks[0].playbackInfo.primaryChannel).toBe(9);
    expect(shape(staff.bars[0].voices[0].beats)).toEqual(['8*','8*','4*','2r']);
    expect(staff.bars[0].voices[0].beats[2].notes.map(item=>item.percussionArticulation).sort()).toEqual([38,42]);
    expect(summary.notes.join(' ')).toMatch(/1 drum note on sounds without a drum symbol was skipped/);
  });
  it('applies a key signature from its bar on',()=>{
    const {score}=run(file(1,480,[track([[0,[0xff,0x59,2,2,0]],[3840,[0xff,0x59,2,0xfd,1]]]),track(line([[0,7680,60]]))]));
    expect(score.masterBars.map(bar=>[bar.keySignature,bar.keySignatureType])).toEqual([[2,model.KeySignatureType.Major],[2,model.KeySignatureType.Major],[-3,model.KeySignatureType.Minor],[-3,model.KeySignatureType.Minor]]);
  });
  it('refuses more instrument parts than it can import',()=>{
    const many=Array.from({length:33},()=>track(line([[0,480,60]])));
    expect(()=>run(file(1,480,many))).toThrow(/limited to 32 instrument parts/);
  });
  it('notes program changes after the start of a part',()=>{
    const {summary}=run(file(1,480,[track([[0,program(0)],[0,on(60)],[480,off(60)],[0,program(40)],[0,on(62)],[480,off(62)]])]));
    expect(summary.notes.join(' ')).toMatch(/1 instrument change after the start of a part was not imported/);
  });
});

describe('importMidi as a Guitar Pro score',()=>{
  const clockOf=(score:model.Score)=>score.tracks.flatMap(item=>item.staves.flatMap(staff=>staff.bars.flatMap((bar,index)=>bar.voices.filter(voice=>!voice.isEmpty).map(voice=>voice.beats.reduce((sum,beat)=>sum+beat.playbackDuration,0)-score.masterBars[index].calculateDuration()))));
  it('fills every bar of every voice exactly, for straight and tuplet rhythms',()=>{
    const mixed=line([[0,160,60],[160,160,62],[320,160,64],[480,240,65],[720,240,67],[960,480,69],[1440,120,71],[1560,360,72],[1920,2880,64]]);
    const {score}=run(file(1,480,[track([[0,meter(4,4)]]),track(mixed),track(line([[0,3840,36],[3840,960,38]],1))]));
    expect(clockOf(score).every(difference=>difference===0)).toBe(true);
  });
  it('keeps drums and second voices through a Guitar Pro round trip',()=>{
    const {score}=run(file(1,480,[track(line([[0,1440,40],[480,480,47]],1)),track(line([[0,10,36],[480,10,38],[960,10,36]],9))]));
    const back=loadInterchangeScore(exportGpInterchange(score,settings),settings),drums=back.tracks[1];
    expect(back.tracks[0].staves[0].bars[0].voices).toHaveLength(2);expect(drums.isPercussion).toBe(true);
    const keys=drums.staves[0].bars[0].voices[0].beats.filter(beat=>beat.notes.length).map(beat=>drums.percussionArticulations[beat.notes[0].percussionArticulation].outputMidiNumber);
    expect(keys).toEqual([36,38,36]);
  });
  it('survives a Guitar Pro round trip with notes, ties, tuplets, tempo and programs',()=>{
    const bytes=file(1,480,[track([[0,tempo(110)],[0,meter(3,4)]]),track([[0,program(25)],...line([[0,160,52],[160,160,55],[320,160,59],[480,1920,64],[2400,480,40]])])]);
    const {score}=run(bytes),back=loadInterchangeScore(exportGpInterchange(score,settings),settings);
    expect(back.masterBars.length).toBe(score.masterBars.length);
    expect(back.tracks[0].playbackInfo.program).toBe(25);
    expect(back.masterBars[0].tempoAutomations[0].value).toBe(110);
    const pairs=(value:model.Score)=>value.tracks[0].staves[0].bars.flatMap(bar=>bar.voices[0].beats.map(beat=>[beat.duration,beat.dots,beat.tupletNumerator,beat.notes.map(item=>`${item.string}:${item.fret}${item.isTieDestination?'t':''}`).join(',')]));
    expect(pairs(back)).toEqual(pairs(score));
  });
});

describe('importMidi robustness',()=>{
  const random=(seed:number)=>()=>(seed=(seed*1664525+1013904223)>>>0)/2**32;
  const clockOf=(score:model.Score)=>score.tracks.flatMap(item=>item.staves.flatMap(staff=>staff.bars.flatMap((bar,index)=>bar.voices.filter(voice=>!voice.isEmpty).map(voice=>voice.beats.reduce((sum,beat)=>sum+beat.playbackDuration,0)-score.masterBars[index].calculateDuration()))));
  it('fills every bar exactly for random unquantized playing under every option',()=>{
    const next=random(7);
    for(let round=0;round<24;round++){
      const notes:[number,number,number][]=Array.from({length:40},()=>[Math.floor(next()*6000),1+Math.floor(next()*900),30+Math.floor(next()*50)]);
      const bytes=file(1,480,[track([[0,meter(round%2?5:4,round%3?4:8)]]),track(line(notes,round%4===3?9:0))]);
      const choices:Partial<MidiImportOptions>={quantization:([4,8,16,32,64] as const)[round%5],tuplets:(['none','triplets','triplets-quintuplets'] as const)[round%3],voices:([1,2,3,4] as const)[round%4]};
      const {score}=run(bytes,choices);
      expect(clockOf(score).every(difference=>difference===0)).toBe(true);
      loadInterchangeScore(exportGpInterchange(score,settings),settings);
    }
  });
  it('either reads or refuses every truncation and corruption of a valid file, with a plain Error',()=>{
    const valid=file(1,480,[track([[0,tempo(100)],[0,meter(4,4)]]),track([[0,program(25)],...line([[0,480,60],[480,240,64],[720,240,67]])])]);
    const next=random(3);
    for(let cut=0;cut<valid.length;cut++)try{readMidiFile(valid.subarray(0,cut));}catch(error){expect(error).toBeInstanceOf(Error);}
    for(let round=0;round<300;round++){
      const copy=valid.slice();copy[Math.floor(next()*copy.length)]=Math.floor(next()*256);
      try{importMidi(readMidiFile(copy));}catch(error){expect(error).toBeInstanceOf(Error);}
    }
  });
});

describe('midiImportFileName',()=>{
  it('uses the MIDI file name with a .gp extension',()=>{
    expect(midiImportFileName('Song one.mid')).toBe('Song one.gp');
    expect(midiImportFileName('a/b:c.midi')).toBe('a b c.gp');
    expect(midiImportFileName('.mid')).toBe('Imported MIDI.gp');
    expect(new TextEncoder().encode(midiImportFileName(`${'é'.repeat(300)}.mid`)).length).toBeLessThanOrEqual(200);
  });
});
