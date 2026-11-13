import { expect,it } from 'vitest';
import { model,Settings } from '@coderline/alphatab';
import { music } from './fixtures';
import { makeMusicClip } from './clipboard-source';
import { preparePasteMusic } from './clipboard-paste';
import { rhythmTicks } from './common';
import { scoreFromJson } from '../model-clone';
import { restoreNoteLinks } from './links';
import type { ClipboardCommand,MusicClip } from './clipboard-types';

const json=(score:model.Score)=>model.JsonConverter.scoreToJson(score);
const range=(start:[number,number],end:[number,number])=>({kind:'range' as const,range:{start:{bar:start[0],tick:start[1]},end:{bar:end[0],tick:end[1]},lanes:[{track:0,staff:0,voice:0}]}});
const decode=(clip:MusicClip)=>{const score=scoreFromJson(clip.scoreJson,new Settings());restoreNoteLinks(score,clip.links.map(link=>({...link,slideOutType:link.slideOutType??undefined})));return score;};
const beatsOf=(score:model.Score,bar:number)=>score.tracks[0].staves[0].bars[bar].voices[0].beats;
const total=(score:model.Score,bar:number)=>beatsOf(score,bar).reduce((sum,beat)=>sum+rhythmTicks(beat),0);
const shapes=(score:model.Score,bar:number)=>beatsOf(score,bar).map(beat=>[beat.duration,beat.dots]);
/** Bar 0 becomes [first, then quarters]; `first` is a sustained beat of the given written length. */
function sustained(duration:number,dots=0,quarters=0) {
  const score=music(),bar=score.tracks[0].staves[0].bars[0],voice=bar.voices[0];
  const lead=voice.beats[0];lead.duration=duration;lead.dots=dots;voice.beats=[lead];
  for(let index=0;index<quarters;index++){const beat=new model.Beat();beat.duration=4;beat.isEmpty=false;const note=new model.Note();note.string=5;note.fret=2;beat.addNote(note);voice.addBeat(beat);}
  return scoreFromJson(json(score),new Settings());
}

it('a range starting inside a sustained beat copies only the tail as tied-free exact time',()=>{
  const score=sustained(2,0,2),before=json(score),clip=makeMusicClip(score,range([0,480],[1,0]),'singleTrack'),copy=decode(clip);
  expect(total(copy,0)).toBe(1440+1920);expect(shapes(copy,0)[0]).toEqual([4,1]);expect(clip.links).toEqual([]);expect(json(score)).toBe(before);
});
it('a range ending inside a sustained beat copies only the head and drops the link to the excluded remainder',()=>{
  const score=sustained(2,0,2),before=json(score),clip=makeMusicClip(score,range([0,0],[0,480]),'singleTrack'),copy=decode(clip);
  expect(total(copy,0)).toBe(480);expect(shapes(copy,0)).toEqual([[8,0]]);expect(clip.links).toEqual([]);expect(json(score)).toBe(before);
});
it('cuts on both sides leave exactly the middle',()=>{
  const score=sustained(1),clip=makeMusicClip(score,range([0,960],[0,2880]),'singleTrack'),copy=decode(clip);
  expect(total(copy,0)).toBe(1920);expect(shapes(copy,0)).toEqual([[2,0]]);
});
it('a dotted note cut exactly splits into plain written lengths',()=>{
  const score=sustained(2,1,0),clip=makeMusicClip(score,range([0,0],[0,960]),'singleTrack');
  expect(total(decode(clip),0)).toBe(960);expect(shapes(decode(clip),0)).toEqual([[4,0]]);
  const tail=makeMusicClip(score,range([0,960],[0,2880]),'singleTrack');expect(shapes(decode(tail),0)).toEqual([[2,0]]);
});
it('pieces inside the selection are tied in sequence and paste as valid ties',()=>{
  const score=sustained(2,0,0),clip=makeMusicClip(score,range([0,0],[0,1200]),'singleTrack'),copy=decode(clip);
  expect(shapes(copy,0)).toEqual([[4,0],[16,0]]);expect(clip.links.map(link=>link.kind)).toEqual(['tie']);expect(total(copy,0)).toBe(1200);
  const destination=music(),command:ClipboardCommand={type:'pasteMusic',clip,options:{target:{track:0,staff:0,bar:1,voice:0,beat:0},destinations:[{sourceTrack:0,track:0,staffMap:[0]}],count:1,placement:'currentBar',filters:{diagrams:true,texts:true,timers:true,trackAutomations:true,masterAutomations:false,sections:false}}};
  const result=preparePasteMusic(destination,command).score,pasted=result.tracks[0].staves[0].bars[1].voices[0].beats;
  expect(pasted[0].notes[0].tieDestination).toBe(pasted[1].notes[0]);expect(pasted[1].notes[0].isTieDestination).toBe(true);
});
it('a chord ties every note',()=>{
  const score=sustained(2,0,0),beat=beatsOf(score,0)[0],extra=new model.Note();extra.string=4;extra.fret=2;beat.addNote(extra);
  const clip=makeMusicClip(score,range([0,0],[0,1200]),'singleTrack');expect(clip.links.filter(link=>link.kind==='tie')).toHaveLength(2);expect(decode(clip).tracks[0].staves[0].bars[0].voices[0].beats[1].notes).toHaveLength(2);
});
it('a cut across a barline copies the tail of one measure and the head of the next',()=>{
  const score=music(),staff=score.tracks[0].staves[0];
  for(const bar of [0,1]){const voice=staff.bars[bar].voices[0],lead=voice.beats[0];lead.duration=1;voice.beats=[lead];}
  const copy=scoreFromJson(json(score),new Settings()),clip=makeMusicClip(copy,range([0,2880],[1,480]),'singleTrack'),result=decode(clip);
  expect(total(result,0)).toBe(960);expect(total(result,1)).toBe(480);expect(shapes(result,0)).toEqual([[4,0]]);expect(shapes(result,1)).toEqual([[8,0]]);
});
it('a tuplet beat splits into the same tuplet or refuses',()=>{
  const score=sustained(8,0,0),lead=beatsOf(score,0)[0];lead.tupletNumerator=3;lead.tupletDenominator=2;
  const clip=makeMusicClip(score,range([0,0],[0,160]),'singleTrack'),piece=beatsOf(decode(clip),0)[0];
  expect([piece.duration,piece.tupletNumerator,piece.tupletDenominator]).toEqual([16,3,2]);expect(total(decode(clip),0)).toBe(160);
  expect(()=>makeMusicClip(score,range([0,0],[0,1]),'singleTrack')).toThrow(/exact written length/);
});
it('a bent note refuses the cut and a plain copy of whole beats still works',()=>{
  const score=sustained(2,0,0),note=beatsOf(score,0)[0].notes[0];note.bendType=model.BendType.Bend;note.addBendPoint(new model.BendPoint(0,0));note.addBendPoint(new model.BendPoint(60,4));
  expect(()=>makeMusicClip(score,range([0,0],[0,480]),'singleTrack')).toThrow(/bent note/);
  expect(makeMusicClip(score,range([0,0],[0,1920]),'singleTrack').links).toEqual([]);
});
it('a slide leaves from the final piece, so a head-only copy drops it and a tail copy keeps it',()=>{
  const score=sustained(2,0,1),first=beatsOf(score,0)[0].notes[0],next=beatsOf(score,0)[1].notes[0];
  first.string=5;first.fret=2;first.slideOutType=model.SlideOutType.Shift;first.slideTarget=next;next.slideOrigin=first;
  const head=decode(makeMusicClip(score,range([0,0],[0,480]),'singleTrack')).tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0];expect(head.slideOutType).toBe(model.SlideOutType.None);
  const clip=makeMusicClip(score,range([0,480],[1,0]),'singleTrack');expect(clip.links.map(link=>link.kind)).toEqual(['slide']);
  const tail=decode(clip).tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0];expect(tail.slideOutType).toBe(model.SlideOutType.Shift);
});
it('cut refuses a range that cuts a sustained beat but cut of whole beats is unchanged',()=>{
  const score=sustained(2,0,2);
  expect(()=>makeMusicClip(score,range([0,480],[1,0]),'singleTrack',{cut:true})).toThrow(/beat boundaries/);
  expect(makeMusicClip(score,range([0,1920],[1,0]),'singleTrack',{cut:true}).kind).toBe('phrase');
});

// Round two: sustained properties, plain written values, and what stays on the attack.
const note0=(score:model.Score,bar=0,beat=0)=>beatsOf(score,bar)[beat].notes[0];
function decorate(score:model.Score) {
  const beat=beatsOf(score,0)[0],note=beat.notes[0];
  note.dynamics=model.DynamicValue.PP;note.isPalmMute=true;note.isLetRing=true;note.vibrato=model.VibratoType.Slight;note.isGhost=true;note.accentuated=model.AccentuationType.Normal;
  beat.dynamics=model.DynamicValue.PP;beat.vibrato=model.VibratoType.Slight;beat.pickStroke=model.PickStroke.Down;beat.text='attack text';
  return note;
}
const sustainedProps=(note:model.Note)=>[note.dynamics,note.isPalmMute,note.isLetRing,note.vibrato,note.isGhost,note.beat.dynamics,note.beat.vibrato];
const expectedProps=[model.DynamicValue.PP,true,true,model.VibratoType.Slight,true,model.DynamicValue.PP,model.VibratoType.Slight];
it('a tail copied from inside a sustained note keeps its dynamics and sustained techniques but not the attack marks',()=>{
  const score=sustained(2,0,2);decorate(score);const copy=decode(makeMusicClip(score,range([0,960],[1,0]),'singleTrack')),tail=note0(copy);
  expect(sustainedProps(tail)).toEqual(expectedProps);expect(tail.accentuated).toBe(model.AccentuationType.None);expect(tail.beat.pickStroke).toBe(model.PickStroke.None);expect(tail.beat.text).toBeNull();
});
it('every piece of a head that needs two written values carries the sustained properties, and only the first the attack marks',()=>{
  const score=sustained(2,0,0);decorate(score);const copy=decode(makeMusicClip(score,range([0,0],[0,1200]),'singleTrack')),pieces=beatsOf(copy,0);
  expect(pieces).toHaveLength(2);for(const piece of pieces)expect(sustainedProps(piece.notes[0])).toEqual(expectedProps);
  expect(pieces[0].notes[0].accentuated).toBe(model.AccentuationType.Normal);expect(pieces[0].text).toBe('attack text');expect(pieces[1].notes[0].accentuated).toBe(model.AccentuationType.None);expect(pieces[1].text).toBeNull();expect(pieces[1].pickStroke).toBe(model.PickStroke.None);
});
it('a range wholly inside one whole note keeps the sustained properties and no attack marks',()=>{
  const score=sustained(1);decorate(score);const copy=decode(makeMusicClip(score,range([0,960],[0,2880]),'singleTrack')),middle=note0(copy);
  expect(sustainedProps(middle)).toEqual(expectedProps);expect(middle.accentuated).toBe(model.AccentuationType.None);expect(middle.beat.text).toBeNull();
});
it('text and a chord diagram stay on the first piece of a cut beat only',()=>{
  const score=sustained(2,0,0),staff=score.tracks[0].staves[0],chord=new model.Chord();chord.name='Am';staff.addChord('am',chord);
  const beat=beatsOf(score,0)[0];beat.text='head only';beat.chordId='am';
  const head=beatsOf(decode(makeMusicClip(score,range([0,0],[0,1200]),'singleTrack')),0);expect([head[0].text,head[0].chordId,head[1].text,head[1].chordId]).toEqual(['head only','am',null,null]);
  const tail=beatsOf(decode(makeMusicClip(score,range([0,480],[1,0]),'singleTrack')),0);expect([tail[0].text,tail[0].chordId]).toEqual([null,null]);
});
it('a two-voice bar cuts both voices and keeps each voice\'s properties',()=>{
  const score=sustained(2,0,2),voice=new model.Voice();
  for(let index=0;index<4;index++){const beat=new model.Beat();beat.duration=4;beat.isEmpty=false;const note=new model.Note();note.string=4;note.fret=7;note.dynamics=model.DynamicValue.MF;beat.addNote(note);voice.addBeat(beat);}
  score.tracks[0].staves[0].bars[0].addVoice(voice);for(const bar of score.tracks[0].staves[0].bars.slice(1)){const extra=new model.Voice();for(let index=0;index<4;index++){const beat=new model.Beat();beat.duration=4;beat.isEmpty=false;extra.addBeat(beat);}bar.addVoice(extra);}
  const prepared=scoreFromJson(json(score),new Settings());decorate(prepared);
  const selection={kind:'range' as const,range:{start:{bar:0,tick:480},end:{bar:1,tick:0},lanes:[{track:0,staff:0,voice:0},{track:0,staff:0,voice:1}]}};
  const copy=decode(makeMusicClip(prepared,selection,'singleTrack')),voices=copy.tracks[0].staves[0].bars[0].voices;
  expect(voices).toHaveLength(2);expect(voices[0].beats.reduce((sum,beat)=>sum+rhythmTicks(beat),0)).toBe(3360);expect(voices[1].beats.reduce((sum,beat)=>sum+rhythmTicks(beat),0)).toBe(3360);
  expect(sustainedProps(voices[0].beats[0].notes[0])).toEqual(expectedProps);expect(voices[1].beats[0].notes[0].dynamics).toBe(model.DynamicValue.MF);expect(voices[1].beats[0].notes[0].fret).toBe(7);
});
it('a cut that is not on a plain or dotted written boundary is refused, not written as tiny tied pieces',()=>{
  const score=sustained(2,1,0);
  expect(()=>makeMusicClip(score,range([0,0],[0,640]),'singleTrack')).toThrow(/no exact written length/);
  expect(()=>makeMusicClip(score,range([0,640],[1,0]),'singleTrack')).toThrow(/no exact written length/);
});
it('a long tail is written with single dots at most',()=>{
  const score=sustained(1),copy=decode(makeMusicClip(score,range([0,480],[1,0]),'singleTrack'));
  expect(shapes(copy,0)).toEqual([[2,1],[8,0]]);expect(total(copy,0)).toBe(3360);
});

it('a cut needing more than four tied notes on one side is refused',()=>{
  const score=music();score.masterBars[0].timeSignatureNumerator=6;const voice=score.tracks[0].staves[0].bars[0].voices[0],lead=voice.beats[0];lead.duration=1;lead.dots=1;voice.beats=[lead];
  const six=scoreFromJson(json(score),new Settings());
  expect(()=>makeMusicClip(six,range([0,0],[0,5190]),'singleTrack')).toThrow(/more than 4 tied notes/);
});
it('the tie leaving a cut note leaves from its final piece and reaches the next note',()=>{
  const score=sustained(2,0,1),first=note0(score,0,0),next=note0(score,0,1);first.tieDestination=next;next.tieOrigin=first;next.isTieDestination=true;next.fret=first.fret;next.string=first.string;
  const clip=makeMusicClip(score,range([0,480],[1,0]),'singleTrack'),copy=decode(clip),beats=beatsOf(copy,0);
  expect(clip.links.map(link=>link.kind)).toEqual(['tie']);expect(beats[0].notes[0].tieDestination).toBe(beats[1].notes[0]);expect(beats[1].notes[0].isTieDestination).toBe(true);
});
it('refuses beats whose written length, curve or note kind cannot be cut',()=>{
  const cut=(change:(score:model.Score)=>void)=>{const score=sustained(2,0,0);change(score);return ()=>makeMusicClip(score,range([0,0],[0,480]),'singleTrack');};
  expect(cut(score=>{beatsOf(score,0)[0].overrideDisplayDuration=1920;})).toThrow(/overridden written length/);
  expect(cut(score=>{const beat=beatsOf(score,0)[0];beat.whammyBarType=model.WhammyType.Dive;beat.addWhammyBarPoint(new model.BendPoint(0,0));beat.addWhammyBarPoint(new model.BendPoint(60,-4));})).toThrow(/whammy/);
  expect(cut(score=>{note0(score).trillValue=5;})).toThrow(/trilled/);
  expect(cut(score=>{note0(score).isDead=true;})).toThrow(/dead note/);
  expect(cut(score=>{score.masterBars[0].isFreeTime=true;})).toThrow(/free-time/);
});

it('every sustained note and beat field is carried to every piece, and a harmonic keeps the pitch tie-equal',()=>{
  const score=sustained(2,0,0),beat=beatsOf(score,0)[0],note=beat.notes[0];
  note.harmonicType=model.HarmonicType.Natural;note.harmonicValue=12;note.string=5;note.fret=12;note.durationPercent=.5;note.accidentalMode=model.NoteAccidentalMode.ForceSharp;
  beat.ottava=model.Ottavia._8va;beat.crescendo=model.CrescendoType.Crescendo;beat.slashed=true;beat.wahPedal=model.WahPedal.Open;beat.tremoloPicking=Object.assign(new model.TremoloPickingEffect(),{marks:1});
  const copy=decode(makeMusicClip(score,range([0,0],[0,1200]),'singleTrack')),second=beatsOf(copy,0)[1],tail=second.notes[0];
  expect([tail.harmonicType,tail.harmonicValue,tail.durationPercent,tail.accidentalMode,tail.realValue]).toEqual([model.HarmonicType.Natural,12,.5,model.NoteAccidentalMode.ForceSharp,beatsOf(copy,0)[0].notes[0].realValue]);
  expect([second.ottava,second.crescendo,second.slashed,second.wahPedal,second.tremoloPicking?.marks]).toEqual([model.Ottavia._8va,model.CrescendoType.Crescendo,true,model.WahPedal.Open,1]);
});
it('slur and hammer links leave from the final piece too',()=>{
  const score=sustained(2,0,1),first=note0(score,0,0),next=note0(score,0,1);next.string=first.string;next.fret=first.fret+2;
  first.slurDestination=next;next.slurOrigin=first;next.isSlurDestination=true;first.hammerPullDestination=next;next.hammerPullOrigin=first;first.isHammerPullOrigin=true;
  const clip=makeMusicClip(score,range([0,480],[1,0]),'singleTrack'),copy=decode(clip),beats=beatsOf(copy,0),tail=beats[0].notes[0],following=beats[1].notes[0];
  expect(beats).toHaveLength(2);expect(clip.links.map(link=>link.kind).sort()).toEqual(['hammerPull','slur']);expect(tail.slurDestination).toBe(following);expect(tail.hammerPullDestination).toBe(following);expect(tail.isHammerPullOrigin).toBe(true);
});
