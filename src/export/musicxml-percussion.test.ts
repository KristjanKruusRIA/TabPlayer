// @vitest-environment jsdom
import { describe,expect,it } from 'vitest';
import { model,Settings } from '@coderline/alphatab';
import { strFromU8 } from 'fflate';
import { loadInterchangeScore } from '../interchange/gp';
import { resolvePercussionArticulation } from '../editor/percussion-catalog';
import { exportMusicXml } from './musicxml';

const settings=new Settings();
type HitSpec={id:number|model.InstrumentArticulation;ghost?:boolean;tieDestination?:boolean};
type BeatSpec={duration:model.Duration;dots?:number;tuplet?:[number,number];grace?:model.GraceType;hits?:HitSpec[];dynamics?:model.DynamicValue};
type BarSpec={repeatStart?:boolean;repeatCount?:number;voices:BeatSpec[][]};
const {Eighth,Quarter,Half,Sixteenth}=model.Duration;
const hit=(id:number|model.InstrumentArticulation,extra:Partial<HitSpec>={}):HitSpec=>({id,...extra});

// A kit pattern authored through the model API, independent of any importer.
function kit(bars:BarSpec[],options:{articulations?:model.InstrumentArticulation[]}={}){
  const score=new model.Score();score.title='Kit';
  const track=new model.Track();track.name='Drums';track.shortName='Dr.';score.addTrack(track);track.ensureStaveCount(1);
  Object.assign(track.playbackInfo,{program:0,primaryChannel:9,secondaryChannel:9,volume:12,balance:8});
  const staff=track.staves[0];staff.isPercussion=true;staff.showStandardNotation=true;staff.showTablature=false;
  track.percussionArticulations=options.articulations??[];
  for(const spec of bars){
    const master=new model.MasterBar();master.timeSignatureNumerator=4;master.timeSignatureDenominator=4;
    master.isRepeatStart=!!spec.repeatStart;master.repeatCount=spec.repeatCount??0;score.addMasterBar(master);
    const bar=new model.Bar();bar.clef=model.Clef.Neutral;staff.addBar(bar);
    for(const beats of spec.voices){
      const voice=new model.Voice();bar.addVoice(voice);
      for(const spec of beats){
        const beat=new model.Beat();beat.duration=spec.duration;beat.dots=spec.dots??0;beat.isEmpty=false;
        if(spec.tuplet){beat.tupletNumerator=spec.tuplet[0];beat.tupletDenominator=spec.tuplet[1];}
        if(spec.grace!==undefined)beat.graceType=spec.grace;
        if(spec.dynamics!==undefined)beat.dynamics=spec.dynamics;
        voice.addBeat(beat);
        for(const h of spec.hits??[]){
          const note=new model.Note();
          note.percussionArticulation=typeof h.id==='number'?h.id:track.percussionArticulations.push(h.id)-1;
          note.isGhost=!!h.ghost;note.isTieDestination=!!h.tieDestination;beat.addNote(note);
        }
      }
    }
  }
  // A bar without a second voice still holds an empty one, as the model keeps every bar's voices alike.
  const count=Math.max(...staff.bars.map(bar=>bar.voices.length));
  for(const bar of staff.bars)while(bar.voices.length<count){const voice=new model.Voice(),beat=new model.Beat();beat.isEmpty=true;voice.addBeat(beat);bar.addVoice(voice);}
  score.finish(settings);
  return score;
}
const eighths=(...groups:number[][]):BeatSpec[]=>groups.map(ids=>({duration:Eighth,hits:ids.map(id=>hit(id))}));
// Bar 1: kick, closed and open hi-hat, snare with a ghost, ride and bell, crash; a pedal hi-hat in voice 2.
const groove:BarSpec={repeatStart:true,voices:[
  [...eighths([36,42],[42],[38,42],[46],[36,51],[53]),{duration:Eighth,hits:[hit(38,{ghost:true})]},{duration:Eighth,hits:[hit(49)]}],
  [{duration:Quarter,hits:[hit(44)]},{duration:Quarter,hits:[hit(44)]},{duration:Quarter,hits:[hit(44)]},{duration:Quarter,hits:[hit(44)]}],
]};
// Bar 2: toms, a flam (grace snare before a snare), a triplet of toms and a louder dynamic.
const fills:BarSpec={voices:[[
  {duration:Quarter,dynamics:model.DynamicValue.PP,hits:[hit(48)]},{duration:Quarter,hits:[hit(47)]},
  {duration:Sixteenth,grace:model.GraceType.BeforeBeat,hits:[hit(38)]},{duration:Quarter,hits:[hit(38)]},
  ...[45,45,43].map(id=>({duration:Eighth,tuplet:[3,2] as [number,number],hits:[hit(id)]})),
]]};
// Bars 3 and 4: a crash held across the barline, a dotted snare and a floor-tom roll.
const tail:BarSpec[]=[
  {voices:[[{duration:Half,hits:[hit(49)]},{duration:Half,hits:[hit(36)]}]]},
  {repeatCount:2,voices:[[{duration:Half,hits:[hit(49,{tieDestination:true})]},{duration:Quarter,dots:1,hits:[hit(38)]},{duration:Eighth,hits:[hit(42)]}]]},
];
const pattern=()=>kit([groove,fills,...tail]);

const selectAll=(score:model.Score)=>({tracks:score.tracks.map((_,index)=>index),range:null});
const parse=(bytes:Uint8Array)=>{const doc=new DOMParser().parseFromString(strFromU8(bytes),'application/xml');expect(doc.querySelector('parsererror')).toBeNull();return doc;};
const reimport=(score:model.Score)=>loadInterchangeScore(exportMusicXml(score,selectAll(score)),settings);

// The sound, place and head of every hit, in document order, as the app resolves them.
function hits(score:model.Score){
  const track=score.tracks[0];
  return track.staves[0].bars.map(bar=>bar.voices.filter(voice=>!voice.isEmpty).map(voice=>voice.beats.map(beat=>({
    start:beat.playbackStart,ticks:beat.playbackDuration,duration:beat.duration,dots:beat.dots,grace:beat.graceType,
    tuplet:beat.hasTuplet?[beat.tupletNumerator,beat.tupletDenominator]:null,dynamics:beat.dynamics,
    notes:beat.notes.map(note=>{
      const articulation=resolvePercussionArticulation(track,note.percussionArticulation)!;
      return {key:articulation.outputMidiNumber,line:articulation.staffLine,ghost:note.isGhost,tie:note.isTieDestination,head:note.style?.noteHead??articulation.noteHeadDefault};
    }).sort((a,b)=>a.key-b.key||a.line-b.line||Number(a.ghost)-Number(b.ghost)),
  }))));
}
const symbols=model.MusicFontSymbol;

describe('MusicXML percussion export',()=>{
  it('writes a percussion part with unpitched notes and one instrument per sound',()=>{
    const doc=parse(exportMusicXml(pattern(),selectAll(pattern())));
    expect(doc.querySelector('attributes > clef > sign')?.textContent).toBe('percussion');
    const instruments=[...doc.querySelectorAll('score-part > score-instrument')].map(node=>node.getAttribute('id')!);
    const midi=[...doc.querySelectorAll('score-part > midi-instrument')];
    expect(midi.map(node=>node.getAttribute('id'))).toEqual(instruments);
    expect(new Set(instruments).size).toBe(instruments.length);
    // Every standard sound of the pattern, once each: 36 38 42 44 43 45 46 47 48 49 51 53.
    expect(midi.map(node=>node.querySelector('midi-unpitched')?.textContent).sort()).toEqual(['37','39','43','44','45','46','47','48','49','50','52','54'].sort());
    expect(midi.every(node=>node.querySelector('midi-channel')?.textContent==='10')).toBe(true);
    expect(doc.querySelectorAll('note > pitch').length).toBe(0);
    const notes=[...doc.querySelectorAll('note')];
    expect(notes.filter(note=>!note.querySelector('rest')).every(note=>note.querySelector('unpitched > display-step')&&note.querySelector('unpitched > display-octave')&&instruments.includes(note.querySelector('instrument')?.getAttribute('id')??''))).toBe(true);
    // The staff line the app draws the hit on: snare C5, kick F4, closed hi-hat G5, ride F5.
    const place=(selector:string)=>[...doc.querySelectorAll(selector)].map(node=>`${node.querySelector('display-step')?.textContent}${node.querySelector('display-octave')?.textContent}`);
    expect(place('note > unpitched').slice(0,5)).toEqual(['F4','G5','G5','C5','G5']);
    expect(doc.querySelectorAll('note > grace').length).toBe(1);
    expect([...doc.querySelectorAll('barline > repeat')].map(node=>node.getAttribute('direction'))).toEqual(['forward','backward']);
    expect([...doc.querySelectorAll('direction dynamics > *')].map(node=>node.localName)).toEqual(['pp','f']);
  });

  it('orders the children of every note as the schema does',()=>{
    const order=['grace','chord','cue','pitch','unpitched','rest','duration','tie','instrument','voice','type','dot','accidental','time-modification','stem','notehead','staff','beam','notations','lyric','play'];
    const doc=parse(exportMusicXml(pattern(),selectAll(pattern())));
    for(const note of doc.querySelectorAll('note')){
      const ranks=[...note.children].map(child=>order.indexOf(child.localName));
      expect(ranks.includes(-1)).toBe(false);
      expect(ranks).toEqual([...ranks].sort((a,b)=>a-b));
    }
    // A percussion note with a duration names its instrument after its ties and before its voice.
    const tied=[...doc.querySelectorAll('note')].find(note=>note.querySelector('tie[type="stop"]'))!;
    expect([...tied.children].map(child=>child.localName).slice(0,5)).toEqual(['unpitched','duration','tie','instrument','voice']);
    const flam=doc.querySelector('note > grace')!.parentElement!;
    expect([...flam.children].map(child=>child.localName).slice(0,4)).toEqual(['grace','unpitched','instrument','voice']);
    expect(flam.querySelector('duration')).toBeNull();
    expect(flam.querySelector('grace')?.getAttribute('slash')).toBe('yes');
  });

  it('writes the notehead of the articulation and parentheses for a ghost',()=>{
    const doc=parse(exportMusicXml(pattern(),selectAll(pattern())));
    const head=(key:number)=>{
      const unit=[...doc.querySelectorAll('score-part > midi-instrument')].find(node=>node.querySelector('midi-unpitched')?.textContent===String(key+1))!.getAttribute('id')!;
      return [...doc.querySelectorAll('note')].filter(note=>note.querySelector('instrument')?.getAttribute('id')===unit).map(note=>{const node=note.querySelector('notehead');return node?`${node.textContent}${node.getAttribute('parentheses')==='yes'?'()':''}${node.getAttribute('filled')??''}/${node.getAttribute('smufl')??''}`:'';});
    };
    expect(head(42)).toContain('x/noteheadXBlack');
    expect(head(46)).toContain('circle-x/noteheadCircleX');
    expect(head(49)).toContain('x/noteheadHeavyX');
    expect(head(53).some(text=>text.startsWith('diamond'))).toBe(true);
    expect(head(36).every(text=>text==='')).toBe(true);
    // The ghost snare is the only parenthesised hit; the plain snares carry no notehead.
    expect(head(38).filter(Boolean)).toEqual(['normal()/']);
    expect(doc.querySelectorAll('notehead[parentheses="yes"]').length).toBe(1);
  });

  it('re-imports the sounds, places, rhythm, ties and dynamics of a kit pattern',()=>{
    const source=pattern(),back=reimport(source);
    expect(back.tracks[0].staves[0].isPercussion).toBe(true);
    expect(back.tracks[0].playbackInfo.primaryChannel).toBe(9);
    const wanted=hits(source),got=hits(back);
    // The head is the one drawn shape the import can carry; compare it separately below.
    const bare=(value:ReturnType<typeof hits>)=>value.map(bar=>bar.map(voice=>voice.map(beat=>({...beat,notes:beat.notes.map(({head,...rest})=>rest)}))));
    expect(bare(got)).toEqual(bare(wanted));
    expect(got.length).toBe(4);
    expect(got[0].length).toBe(2);
    expect(got[3][0][0].notes[0].tie).toBe(true);
    expect(got[1][0].map(beat=>beat.grace)).toEqual([model.GraceType.None,model.GraceType.None,model.GraceType.BeforeBeat,model.GraceType.None,model.GraceType.None,model.GraceType.None,model.GraceType.None]);
    expect(back.masterBars[0].isRepeatStart).toBe(true);
    expect(back.masterBars[3].repeatCount).toBe(2);
    // Heads the app draws that MusicXML names: closed and open hi-hat, ghost kept as ghost.
    const closed=got[0][0][0].notes.find(note=>note.key===42)!,open=got[0][0][3].notes[0];
    expect([closed.head,open.head]).toEqual([symbols.NoteheadXBlack,symbols.NoteheadCircleX]);
    expect(got[0][0][6].notes[0].ghost).toBe(true);
  });

  it('keeps two articulations of one sound apart by instrument',()=>{
    const bar:BarSpec={voices:[[{duration:Quarter,hits:[hit(46)]},{duration:Quarter,hits:[hit(92)]},{duration:Half,hits:[hit(42)]}]]};
    const back=reimport(kit([bar]));
    const track=back.tracks[0],notes=track.staves[0].bars[0].voices[0].beats.map(beat=>beat.notes[0]);
    // The open and the half-open hi-hat both sound key 46 on the same line, yet stay two articulations.
    expect(notes.map(note=>resolvePercussionArticulation(track,note.percussionArticulation)!.outputMidiNumber)).toEqual([46,46,42]);
    expect(new Set(notes.map(note=>note.percussionArticulation)).size).toBe(3);
  });

  it('writes an articulation of the track\'s own table with its place and key',()=>{
    const own=new model.InstrumentArticulation('Cowbell',-3,56,symbols.NoteheadTriangleUpBlack,symbols.NoteheadTriangleUpHalf,symbols.NoteheadTriangleUpWhole);
    const score=kit([{voices:[[{duration:Quarter,hits:[hit(own)]},{duration:Quarter,hits:[hit(36)]},{duration:Half}]]}],{});
    const doc=parse(exportMusicXml(score,selectAll(score)));
    expect(doc.querySelector('note > notehead')?.textContent).toBe('triangle');
    expect(doc.querySelector('score-instrument > instrument-name')?.textContent).toBe('Cowbell');
    expect(doc.querySelector('note > unpitched > display-step')?.textContent).toBe('B');
    const back=reimport(score),track=back.tracks[0];
    const articulation=resolvePercussionArticulation(track,track.staves[0].bars[0].voices[0].beats[0].notes[0].percussionArticulation)!;
    expect([articulation.outputMidiNumber,articulation.staffLine]).toEqual([56,-3]);
  });

  it('refuses what MusicXML cannot carry instead of dropping it',()=>{
    const bar=(id:number):BarSpec=>({voices:[[{duration:Quarter,hits:[hit(id)]},{duration:Half},{duration:Quarter}]]});
    const run=(score:model.Score)=>()=>exportMusicXml(score,selectAll(score));
    // A cymbal choke and a cymbal edge are technique marks on the head.
    expect(run(kit([bar(94)]))).toThrow(/technique mark/);
    expect(run(kit([bar(93)]))).toThrow(/technique mark/);
    const keyed=kit([bar(36)]);keyed.tracks[0].staves[0].bars[0].keySignature=3;
    expect(run(keyed)).toThrow(/key signature on a percussion staff/);
    const grand=kit([bar(36)]);grand.tracks[0].ensureStaveCount(2);
    expect(run(grand)).toThrow(/percussion staff beside another staff/);
    const hidden=kit([bar(36)]);hidden.tracks[0].staves[0].showStandardNotation=false;
    expect(run(hidden)).toThrow(/percussion staff without standard notation/);
    const lined=kit([bar(36)]);lined.tracks[0].staves[0].standardNotationLineCount=3;
    expect(run(lined)).toThrow(/percussion staff with 3 lines/);
    const unknown=kit([bar(36)]);unknown.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].percussionArticulation=500;
    expect(run(unknown)).toThrow(/unknown percussion sound/);
    const clefOff=kit([bar(36)]);clefOff.tracks[0].staves[0].bars[0].clef=model.Clef.G2;
    expect(run(clefOff)).toThrow(/clef on a percussion staff/);
  });

  it('refuses a percussion note on a pitched staff and keeps pitched notes unchanged',()=>{
    const score=kit([{voices:[[{duration:Quarter,hits:[hit(36)]},{duration:Half},{duration:Quarter}]]}]);
    score.tracks[0].staves[0].isPercussion=false;score.tracks[0].staves[0].bars[0].clef=model.Clef.G2;
    expect(()=>exportMusicXml(score,selectAll(score))).toThrow(/note percussionarticulation/);
  });
});
