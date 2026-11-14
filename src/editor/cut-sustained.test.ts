import { expect,it,vi } from 'vitest';
import { model,Settings } from '@coderline/alphatab';
import { DocumentController } from '../controller';
import { buildDocument,validateProject } from '../engine';
import { blankProject,type EditCommand,type Project,type ProjectSnapshot } from '../project';
import type { NativeBridge } from '../bridge';
import type { DocumentSnapshot } from '../workspace/types';
import { scoreFromJson } from '../model-clone';
import { en,et,de } from '../i18n';
import { music } from './fixtures';
import { applyRangeEdit } from './range-edits';
import { makeMusicClip } from './clipboard-source';
import { preparePasteMusic } from './clipboard-paste';
import { rhythmTicks } from './common';
import { captureNoteLinks,restoreNoteLinks } from './links';
import type { ClipboardCommand } from './clipboard-types';
import { acceptsOnlyWholeBeats,eraseCommandFor } from './range-cut';
import type { MusicSelection } from './range-types';

/** The score as JSON without the runtime counters that number every object (they differ between two builds of one document). */
const json=(score:model.Score)=>{let value:unknown=JSON.parse(JSON.stringify(model.JsonConverter.scoreToJson(score)));if(typeof value==='string')value=JSON.parse(value);return JSON.stringify(value,(key,member)=>key==='id'?undefined:member);};
const fresh=(score:model.Score)=>{const copy=scoreFromJson(model.JsonConverter.scoreToJson(score),new Settings());restoreNoteLinks(copy,captureNoteLinks(score));return copy;};
const lane=(voice=0)=>({track:0,staff:0,voice});
const range=(start:[number,number],end:[number,number],voices=[0]):Extract<MusicSelection,{kind:'range'}>=>({kind:'range',range:{start:{bar:start[0],tick:start[1]},end:{bar:end[0],tick:end[1]},lanes:voices.map(lane)}});
const beatsOf=(score:model.Score,bar=0,voice=0)=>score.tracks[0].staves[0].bars[bar].voices[voice].beats;
const shapes=(score:model.Score,bar=0,voice=0)=>beatsOf(score,bar,voice).map(beat=>[beat.duration,beat.dots,beat.notes.length]);
const total=(score:model.Score,bar=0,voice=0)=>beatsOf(score,bar,voice).reduce((sum,beat)=>sum+rhythmTicks(beat),0);
/** Bar 0 becomes [lead, then `quarters` quarter notes]; the lead is a sustained beat of the given written length. */
function sustained(duration:number,dots=0,quarters=0) {
  const score=music(),voice=score.tracks[0].staves[0].bars[0].voices[0],lead=voice.beats[0];
  lead.duration=duration;lead.dots=dots;voice.beats=[lead];
  for(let index=0;index<quarters;index++){const beat=new model.Beat();beat.duration=4;beat.isEmpty=false;const note=new model.Note();note.string=5;note.fret=2;beat.addNote(note);voice.addBeat(beat);}
  return fresh(score);
}
const cut=(score:model.Score,selection:MusicSelection)=>applyRangeEdit(score,{type:'cutSelection',selection});
/** What sounds, per lane: [start, end, string, fret] with touching equal notes merged, so a note restruck at a cut edge reads as the original. */
function sounding(score:model.Score,bar=0,voice=0) {
  const spans:Array<[number,number,number,number]>=[];let tick=0;
  for(const beat of beatsOf(score,bar,voice)){const length=rhythmTicks(beat);
    for(const note of beat.notes){const last=spans.find(span=>span[1]===tick&&span[2]===note.string&&span[3]===note.fret);if(last)last[1]=tick+length;else spans.push([tick,tick+length,note.string,note.fret]);}
    tick+=length;}
  return spans;
}

// Apply: what the edit does to the music.
it('cuts the middle of a whole note: a shorter note before, a rest for the removed time, a plain attack after',()=>{
  const score=sustained(1),head=beatsOf(score)[0].notes[0];
  expect(cut(score,range([0,960],[0,2880]))).toBe(true);
  expect(shapes(score)).toEqual([[4,0,1],[2,0,0],[4,0,1]]);expect(total(score)).toBe(3840);
  const [first,middle,tail]=beatsOf(score);
  expect(first.notes[0]).toBe(head);expect(head.tieDestination).toBeNull();expect(middle.isEmpty).toBe(false);
  expect(tail.notes[0].tieOrigin).toBeNull();expect(tail.notes[0].isTieDestination).toBe(false);expect([tail.notes[0].string,tail.notes[0].fret]).toEqual([head.string,head.fret]);
  expect(beatsOf(score).map((beat,index)=>beat.index===index)).toEqual([true,true,true]);
});
it('a start edge inside one beat and an end edge inside the next remove exactly the selected time',()=>{
  const score=sustained(2,0,0);const voice=score.tracks[0].staves[0].bars[0].voices[0],second=new model.Beat();second.duration=2;second.isEmpty=false;const note=new model.Note();note.string=4;note.fret=7;second.addNote(note);voice.addBeat(second);
  const original=fresh(score),before=sounding(original);
  cut(score,range([0,480],[0,2400]));
  expect(sounding(score)).toEqual([[0,480,before[0][2],before[0][3]],[2400,3840,4,7]]);
  expect(total(score)).toBe(3840);
});
it('the clipboard content of a cut is exactly what Copy of the same range gives',()=>{
  const score=sustained(2,0,2),selection=range([0,480],[1,0]);
  expect(json(scoreFromJsonOf(makeMusicClip(score,selection,'singleTrack',{cut:true})))).toBe(json(scoreFromJsonOf(makeMusicClip(score,selection,'singleTrack'))));
  expect(makeMusicClip(score,selection,'singleTrack',{cut:true}).links).toEqual(makeMusicClip(score,selection,'singleTrack').links);
});
function scoreFromJsonOf(clip:{scoreJson:unknown}){return scoreFromJson(clip.scoreJson as never,new Settings());}
it('a tie into the removed part and a tie out of it are severed like an erase does, the note before keeps its length',()=>{
  const score=sustained(2,0,1);const [first,next]=beatsOf(score).map(beat=>beat.notes[0]);first.tieDestination=next;next.tieOrigin=first;next.isTieDestination=true;next.string=first.string;next.fret=first.fret;
  cut(score,range([0,480],[1,0]));
  expect(first.tieDestination).toBeNull();expect(next.tieOrigin).toBeNull();expect(total(score)).toBe(2880);
  expect(shapes(score).map(shape=>shape[2])).toEqual([1,0,0]);
});
it('a tied chain across the barline keeps its head tie when the cut starts later in the next bar',()=>{
  const score=sustained(1);const next=score.tracks[0].staves[0].bars[1].voices[0];const lead=next.beats[0];lead.duration=1;next.beats=[lead];
  const a=beatsOf(score,0)[0].notes[0],b=lead.notes[0];a.string=b.string;a.fret=b.fret;a.tieDestination=b;b.tieOrigin=a;b.isTieDestination=true;
  cut(score,range([1,960],[1,2880]));
  expect(a.tieDestination).toBe(b);expect(b.isTieDestination).toBe(true);expect(shapes(score,1)).toEqual([[4,0,1],[2,0,0],[4,0,1]]);
  expect(beatsOf(score,1)[2].notes[0].isTieDestination).toBe(false);
});
it('a tuplet beat is cut into the same tuplet and the group keeps its length',()=>{
  const score=sustained(8,0,0),lead=beatsOf(score)[0];lead.tupletNumerator=3;lead.tupletDenominator=2;const reopened=fresh(score);
  cut(reopened,range([0,0],[0,160]));
  const pieces=beatsOf(reopened);expect(pieces.map(piece=>[piece.duration,piece.tupletNumerator,piece.tupletDenominator,piece.notes.length])).toEqual([[16,3,2,0],[16,3,2,1]]);expect(total(reopened)).toBe(320);
  expect(()=>cut(fresh(score),range([0,0],[0,1]))).toThrow(/exact written length/);
});
it('a cut on a triplet position inside a plain note is refused with its reason',()=>{
  const score=sustained(2,0,0);expect(()=>cut(score,range([0,0],[0,640]))).toThrow(/exact written length/);
});
it('a dotted half cut off its first eighth is written in plain values and the total stays',()=>{
  const score=sustained(2,1,0);cut(score,range([0,0],[0,480]));
  expect(shapes(score)).toEqual([[8,0,0],[2,0,1],[8,0,1]].slice(0,3));expect(total(score)).toBe(2880);
});
const whole=(score:model.Score)=>json(score);
it('a refused cut leaves the whole score exactly as it was, even when its first edge could have been cut',()=>{
  const score=sustained(2,1,0),before=whole(score);
  expect(()=>cut(score,range([0,480],[0,1000]))).toThrow(/no exact written length/);expect(whole(score)).toBe(before);
  const bent=sustained(2,0,0),note=beatsOf(bent)[0].notes[0];note.bendType=model.BendType.Bend;note.addBendPoint(new model.BendPoint(0,0));note.addBendPoint(new model.BendPoint(60,4));
  const bentBefore=whole(bent);expect(()=>cut(bent,range([0,0],[0,480]))).toThrow(/bent note/);expect(whole(bent)).toBe(bentBefore);
});
it('grace notes before a cut attack go with it and the tail stays',()=>{
  const score=sustained(1),voice=score.tracks[0].staves[0].bars[0].voices[0],grace=new model.Beat();grace.graceType=model.GraceType.BeforeBeat;grace.duration=16;grace.isEmpty=false;const note=new model.Note();note.string=3;note.fret=5;grace.addNote(note);voice.beats.unshift(grace);
  const ready=fresh(score);cut(ready,range([0,0],[0,1920]));
  const notes=beatsOf(ready).map(beat=>beat.notes.length);expect(notes).toEqual([0,0,1]);expect(total(ready)).toBe(3840);
});
it('a two-voice bar splits only the first lane; the others are erased by attack, as an erase does',()=>{
  const score=sustained(1),second=new model.Voice(),beat=new model.Beat();beat.duration=1;beat.isEmpty=false;const note=new model.Note();note.string=2;note.fret=9;beat.addNote(note);second.addBeat(beat);
  score.tracks[0].staves[0].bars[0].addVoice(second);for(const bar of score.tracks[0].staves[0].bars.slice(1)){const extra=new model.Voice(),rest=new model.Beat();rest.duration=1;rest.isEmpty=false;extra.addBeat(rest);bar.addVoice(extra);}
  const ready=fresh(score);cut(ready,range([0,960],[0,1920],[0]));
  expect(shapes(ready,0,0)).toEqual([[4,0,1],[4,0,0],[2,0,1]]);expect(shapes(ready,0,1)).toEqual([[1,0,1]]);
  const both=fresh(score);cut(both,range([0,960],[0,1920],[0,1]));expect(shapes(both,0,0)).toEqual([[4,0,1],[4,0,0],[2,0,1]]);expect(shapes(both,0,1)).toEqual([[1,0,1]]);
});
it('beat text, dynamics and a lyric stay on the shortened first piece, and the tail keeps only what sounds',()=>{
  const score=sustained(1),beat=beatsOf(score)[0];beat.text='head';beat.dynamics=model.DynamicValue.PP;beat.lyrics=['la'];beat.notes[0].accentuated=model.AccentuationType.Normal;beat.notes[0].dynamics=model.DynamicValue.PP;
  const ready=fresh(score);cut(ready,range([0,960],[0,1920]));const [first,,tail]=beatsOf(ready);
  expect([first.text,first.lyrics?.[0],first.dynamics,first.notes[0].accentuated]).toEqual(['head','la',model.DynamicValue.PP,model.AccentuationType.Normal]);
  expect([tail.text,tail.dynamics,tail.notes[0].dynamics,tail.notes[0].accentuated]).toEqual([null,model.DynamicValue.PP,model.DynamicValue.PP,model.AccentuationType.None]);
});
it('a fermata inside the removed time stays in the document and travels in the clip, moved to where it falls in the phrase',()=>{
  const score=sustained(1);score.masterBars[0].fermata=new Map([[1500,Object.assign(new model.Fermata(),{type:model.FermataType.Medium,length:1})]]);
  const ready=fresh(score);ready.masterBars[0].fermata=new Map(score.masterBars[0].fermata);
  const clip=scoreFromJsonOf(makeMusicClip(ready,range([0,960],[0,1920]),'singleTrack',{cut:true}));
  expect([...clip.masterBars[0].fermata!.keys()]).toEqual([540]);
  cut(ready,range([0,960],[0,1920]));expect([...ready.masterBars[0].fermata!.keys()]).toEqual([1500]);
});
it('only a range can be cut at a sub-beat edge',()=>{
  const score=sustained(1);expect(()=>cut(score,{kind:'bars',tracks:[0],firstBar:0,lastBar:0})).toThrow(/range/);
});
it('a cut whose straddled beats hold no notes changes nothing a player can hear',()=>{
  const score=sustained(1);beatsOf(score)[0].notes.length=0;const ready=fresh(score),before=json(ready);cut(ready,range([0,960],[0,1920]));
  expect(shapes(ready)).toEqual([[1,0,0]]);expect(json(ready)).toBe(before);
});
it('cut then paste of the clip at the cut start restores what sounds',()=>{
  const score=sustained(2,0,0),voice=score.tracks[0].staves[0].bars[0].voices[0],second=new model.Beat();second.duration=2;second.isEmpty=false;const note=new model.Note();note.string=4;note.fret=7;second.addNote(note);voice.addBeat(second);
  const original=fresh(score),selection=range([0,480],[0,2400]),clip=makeMusicClip(original,selection,'singleTrack',{cut:true});
  cut(score,selection);const startIndex=beatsOf(score).findIndex((_,index)=>beatsOf(score).slice(0,index).reduce((sum,beat)=>sum+rhythmTicks(beat),0)===480);
  const command:ClipboardCommand={type:'pasteMusic',clip,options:{target:{track:0,staff:0,bar:0,voice:0,beat:startIndex},destinations:[{sourceTrack:0,track:0,staffMap:[0]}],count:1,placement:'currentBar',filters:{diagrams:true,texts:true,timers:true,trackAutomations:true,masterAutomations:false,sections:false}}};
  const restored=preparePasteMusic(score,command).score;
  expect(sounding(restored)).toEqual(sounding(original));expect(total(restored)).toBe(3840);
});

// Gesture and replay: what is recorded, what an old log still does, undo.
function makeBridge(project:Project) {
  let current:ProjectSnapshot={project,canUndo:project.edits.length>0,canRedo:false,dirty:false,path:null},undone:EditCommand[]=[],revision=0;
  const snapshot=():DocumentSnapshot=>({documentId:'document-a',revision,snapshot:{...structuredClone(current),redoEdit:structuredClone(undone.at(-1)??null)}});
  const bridge:NativeBridge={
    documentId:'document-a',snapshot:vi.fn(async()=>snapshot()),cancelAsset:vi.fn(async()=>true),
    readBackingAsset:async()=>{throw new Error('none');},
    applyEdit:vi.fn(async command=>{undone=[];current={...current,project:{...current.project,edits:[...current.project.edits,command]},canUndo:true,canRedo:false,dirty:true};revision++;return snapshot();}),
    undo:async()=>{const edits=current.project.edits.slice();undone.push(edits.pop()!);current={...current,project:{...current.project,edits},canUndo:edits.length>0,canRedo:true,dirty:edits.length>0};revision++;return snapshot();},
    redo:async()=>{const edits=[...current.project.edits,undone.pop()!];current={...current,project:{...current.project,edits},canUndo:true,canRedo:undone.length>0,dirty:true};revision++;return snapshot();},
    setLock:vi.fn() as never,saveProject:vi.fn(async()=>null),exportGp:async()=>false,askUnsaved:async()=>'discard',confirmExport:async()=>true,
  };
  return bridge;
}
const target0={track:0,staff:0,bar:0,voice:0,beat:0};
/** Bar 0 is one whole note, bar 1 a half note then a rest: both sustained. */
const alone=(bar:number):EditCommand[]=>[3,2,1].map(beat=>({type:'deleteBeat' as const,target:{...target0,bar,beat}}));
const wholeNote=():Project=>({...blankProject(),edits:[...alone(0),...alone(1),{type:'setDuration',target:target0,duration:1,dots:0},{type:'setNote',target:target0,string:3,fret:5},{type:'setDuration',target:{...target0,bar:1},duration:2,dots:0},{type:'setNote',target:{...target0,bar:1},string:2,fret:3}]});
const notesOf=(score:model.Score)=>score.tracks[0].staves[0].bars.slice(0,2).map(bar=>bar.voices[0].beats.map(beat=>[beat.duration,beat.dots,beat.notes.length]));
it('an old log holding eraseSelection over a range that cuts a beat replays exactly as it always did',()=>{
  const erase=(start:number,end:number):EditCommand=>({type:'eraseSelection',selection:range([0,start],[0,end])});
  const keeps=buildDocument({...wholeNote(),edits:[...wholeNote().edits,erase(960,2880)]}).score;
  expect(notesOf(keeps)[0]).toEqual([[1,0,1]]);
  const erased=buildDocument({...wholeNote(),edits:[...wholeNote().edits,erase(0,1920)]}).score;
  expect(notesOf(erased)[0]).toEqual([[1,0,0]]);
});
it('a cut inside a sustained beat records one cutSelection, replays to the same document, and one undo restores everything',async()=>{
  const bridge=makeBridge(wholeNote()),controller=await DocumentController.create(bridge),original=json(controller.getState().score);
  const selection=range([0,960],[1,960]);
  const clip=await controller.cutMusic(selection,'singleTrack');
  expect(bridge.applyEdit).toHaveBeenCalledTimes(1);expect(vi.mocked(bridge.applyEdit).mock.calls[0][0]).toMatchObject({type:'cutSelection'});
  const state=controller.getState(),replayed=buildDocument(JSON.parse(JSON.stringify(state.snapshot.project)));
  expect(json(replayed.score)).toBe(json(state.score));expect(notesOf(state.score)[0]).toEqual([[4,0,1],[2,1,0]]);
  expect(clip.kind).toBe('phrase');
  await controller.undo();expect(json(controller.getState().score)).toBe(original);expect(controller.getState().snapshot.project.edits).toHaveLength(wholeNote().edits.length);
  await controller.redo();expect(json(controller.getState().score)).toBe(json(state.score));
});
it('a cut on beat boundaries is still recorded as eraseSelection so older builds read it',async()=>{
  const bridge=makeBridge(wholeNote()),controller=await DocumentController.create(bridge);
  await controller.cutMusic(range([0,0],[1,0]),'singleTrack');
  expect(vi.mocked(bridge.applyEdit).mock.calls[0][0].type).toBe('eraseSelection');
});
it('a cut whose edges only fall inside rests is recorded as eraseSelection too',async()=>{
  const bridge=makeBridge({...blankProject(),edits:[{type:'setNote',target:target0,string:3,fret:5}]});
  const controller=await DocumentController.create(bridge);
  await controller.cutMusic(range([0,1440],[0,2400]),'singleTrack');
  expect(vi.mocked(bridge.applyEdit).mock.calls[0][0].type).toBe('eraseSelection');
});
it('a refused cut names its reason in the interface language and records nothing',async()=>{
  const project=wholeNote(),bridge=makeBridge(project),controller=await DocumentController.create(bridge);
  await expect(controller.cutMusic(range([0,0],[0,640]),'singleTrack')).rejects.toThrow(/no exact written length|exact written/);
  expect(bridge.applyEdit).not.toHaveBeenCalled();
});
it('the refusal texts exist in English, Estonian and German',()=>{
  for(const key of ['editor.cut_refusal_range','editor.cut_refusal_length','editor.cut_refusal_pieces','editor.cut_refusal_bend','editor.cut_refusal_trill','editor.cut_refusal_dead','editor.cut_refusal_whammy','editor.cut_refusal_override','editor.cut_refusal_free_time'] as const)
    for(const catalog of [en,et,de])expect(typeof (catalog as Record<string,string>)[key]).toBe('string');
});

// Which gestures record the splitting cut, and what older gestures still do.
const voiceTarget=(voice:number,beat=0,bar=0)=>({track:0,staff:0,bar,voice,beat});
const oneWholeNote=(voice:number):EditCommand[]=>[...voice===0?[3,2,1].map(beat=>({type:'deleteBeat' as const,target:voiceTarget(voice,beat)})):[],{type:'setDuration',target:voiceTarget(voice),duration:1,dots:0},{type:'setNote',target:voiceTarget(voice),string:5,fret:3+voice}];
/** Voice 1 holds one whole note; voice 0 plays quarter notes on beats 2 and 3. */
const guitarAndBass=():Project=>({...blankProject(),edits:[{type:'addVoice',track:0,staff:0},...oneWholeNote(1),{type:'setNote',target:voiceTarget(0,1),string:3,fret:5},{type:'setNote',target:voiceTarget(0,2),string:3,fret:7}]});
const twoLanes=(start:number,end:number,order=[0,1]):Extract<MusicSelection,{kind:'range'}>=>({kind:'range',range:{start:{bar:0,tick:start},end:{bar:0,tick:end},lanes:order.map(lane)}});
it('a range whose edges are on attack boundaries of its anchor lane stays a plain erase, whatever another lane holds',async()=>{
  const bridge=makeBridge(guitarAndBass()),controller=await DocumentController.create(bridge),selection=twoLanes(960,2880);
  expect(eraseCommandFor(controller.getState().score,selection,lane(0))).toEqual({type:'eraseSelection',selection});
  await controller.edit(eraseCommandFor(controller.getState().score,selection,lane(0)));
  expect(vi.mocked(bridge.applyEdit).mock.calls[0][0].type).toBe('eraseSelection');
  const score=controller.getState().score;expect(shapes(score,0,1)).toEqual([[1,0,1]]);expect(shapes(score,0,0).map(shape=>shape[2])).toEqual([0,0,0,0]);
});
it('Cut of that range is refused as it always was, naming the other voices, and records nothing',async()=>{
  const bridge=makeBridge(guitarAndBass()),controller=await DocumentController.create(bridge);
  await expect(controller.cutMusic(twoLanes(960,2880),'singleTrack',lane(0))).rejects.toThrow(/other voices and tracks/);expect(bridge.applyEdit).not.toHaveBeenCalled();
});
it('a mid-note edge in the anchor lane records the splitting cut with that lane first; another lane is erased by attack, not split',async()=>{
  const project:Project={...blankProject(),edits:[{type:'addVoice',track:0,staff:0},...oneWholeNote(0),...oneWholeNote(1)]},bridge=makeBridge(project),controller=await DocumentController.create(bridge);
  const selection=twoLanes(0,1920,[1,0]),command=eraseCommandFor(controller.getState().score,selection,lane(0));
  expect(command.type).toBe('cutSelection');expect((command.selection as Extract<MusicSelection,{kind:'range'}>).range.lanes.map(l=>l.voice)).toEqual([0,1]);
  await controller.edit(command);const score=controller.getState().score;
  expect(shapes(score,0,0)).toEqual([[2,0,0],[2,0,1]]);expect(shapes(score,0,1)).toEqual([[1,0,0]]);
});
it('Delete and Erase on a range ending inside a note cut it, and one undo restores the document',async()=>{
  const bridge=makeBridge(wholeNote()),controller=await DocumentController.create(bridge),original=json(controller.getState().score);
  await controller.edit(eraseCommandFor(controller.getState().score,range([0,0],[0,1920]),lane(0)));
  expect(vi.mocked(bridge.applyEdit).mock.calls[0][0].type).toBe('cutSelection');expect(shapes(controller.getState().score)).toEqual([[2,0,0],[2,0,1]]);
  await controller.undo();expect(json(controller.getState().score)).toBe(original);
});
it('edits that take whole notes are refused for a range ending inside a note of its anchor lane, and only there',()=>{
  const score=sustained(1),mid=range([0,0],[0,1920]),transpose={type:'transposeSelection',selection:mid,semitones:1};
  expect(acceptsOnlyWholeBeats(score,transpose,lane(0))).toBe(true);
  expect(acceptsOnlyWholeBeats(score,{type:'setSelectionTies',selection:range([0,0],[0,3840])},lane(0))).toBe(false);
  expect(acceptsOnlyWholeBeats(score,{type:'eraseSelection',selection:mid},lane(0))).toBe(false);
  expect(acceptsOnlyWholeBeats(score,{type:'transposeSelection',selection:{kind:'bars',tracks:[0],firstBar:0,lastBar:0}},lane(0))).toBe(false);
});

// Replay: later edits, hostile logs.
const cutLog=(selection:MusicSelection):EditCommand=>({type:'cutSelection',selection});
it('edits after a cutSelection in a log see the same beats a rebuild would, and replay the same each time',()=>{
  const project:Project={...wholeNote(),edits:[...wholeNote().edits,cutLog(range([0,960],[0,2880])),{type:'setNote',target:{...target0,beat:1},string:2,fret:4},{type:'deleteBeat',target:{...target0,beat:2}},{type:'insertBeat',target:{...target0,beat:2},duration:4,dots:0}]};
  const built=buildDocument(project).score,again=buildDocument(JSON.parse(JSON.stringify(project))).score,beats=built.tracks[0].staves[0].bars[0].voices[0].beats;
  expect(beats.map(beat=>[beat.duration,beat.notes.length,beat.index])).toEqual([[4,1,0],[2,1,1],[4,0,2]]);
  expect(beats.every((beat,index)=>beat.index===index&&(index===beats.length-1||beat.nextBeat===beats[index+1]))).toBe(true);
  expect(json(again)).toBe(json(built));
});
it('a hostile cutSelection in a log fails the replay cleanly and leaves later builds alone',()=>{
  const before=json(buildDocument(wholeNote()).score);
  const hostile=[cutLog({kind:'bars',tracks:[0],firstBar:0,lastBar:0}),cutLog({kind:'notes',notes:[{target:target0,noteIndex:0}]}),cutLog(range([0,0],[0,640])),cutLog(range([0,0],[0,99999])),cutLog(range([0,960],[0,960])),cutLog(range([9,0],[9,480]))];
  for(const edit of hostile){const project:Project={...wholeNote(),edits:[...wholeNote().edits,edit]};expect(()=>buildDocument(project)).toThrow();}
  expect(json(buildDocument(wholeNote()).score)).toBe(before);
  for(const edit of hostile.slice(0,2))expect(()=>validateProject({...wholeNote(),edits:[...wholeNote().edits,edit]})).toThrow();
});

// Lyrics: the syllable stays with the part that keeps the attack and later syllables do not move.
const withLyrics=():Project=>({...wholeNote(),edits:[...wholeNote().edits,{type:'setTrackLyrics',track:0,visible:true,lines:[{startBar:0,text:'one two three'}]}]});
const syllables=(score:model.Score)=>score.tracks[0].staves[0].bars.slice(0,2).flatMap(bar=>bar.voices[0].beats.filter(beat=>beat.notes.length).map(beat=>beat.lyrics?.[0]??''));
it('a cut that takes the attack hands its syllable to the surviving tail and moves no later syllable',()=>{
  expect(syllables(buildDocument(withLyrics()).score)).toEqual(['one','two']);
  const cutAttack:Project={...withLyrics(),edits:[...withLyrics().edits,cutLog(range([0,0],[0,1920]))]};
  expect(syllables(buildDocument(cutAttack).score)).toEqual(['one','two']);
});
it('a cut that would add a second note-bearing beat after a surviving attack is refused while lyrics are placed note by note',()=>{
  const middle:Project={...withLyrics(),edits:[...withLyrics().edits,cutLog(range([0,960],[0,2880]))]};
  expect(()=>buildDocument(middle)).toThrow(/syllables/);
  const none:Project={...wholeNote(),edits:[...wholeNote().edits,cutLog(range([0,960],[0,2880]))]};expect(()=>buildDocument(none)).not.toThrow();
});
it('a cut that leaves a multi-piece tail is refused while lyrics are placed note by note, and the score is unchanged',()=>{
  // The first three eighths go; the 5-eighth remainder is written as a half and an eighth: one syllable-bearing beat would become two.
  const score=buildDocument(withLyrics()).score,before=json(score);
  expect(()=>cut(score,range([0,0],[0,1440]))).toThrow(/syllables/);expect(json(score)).toBe(before);
  const log:Project={...withLyrics(),edits:[...withLyrics().edits,cutLog(range([0,0],[0,1440]))]};
  expect(()=>buildDocument(log)).toThrow(/syllables/);
  expect(()=>buildDocument({...wholeNote(),edits:[...wholeNote().edits,cutLog(range([0,0],[0,1440]))]})).not.toThrow();
});
it('a tail that stays one beat is allowed with lyrics, and no later syllable moves', ()=>{
  for(const end of [960,1920]){
    const cutOne:Project={...withLyrics(),edits:[...withLyrics().edits,cutLog(range([0,0],[0,end]))]};
    expect(syllables(buildDocument(cutOne).score)).toEqual(['one','two']);
  }
});

// Lyric lines start at their own bar: the count has to hold from each line's start, not over the track.
const bar1Whole:EditCommand[]=[3,2,1].map(beat=>({type:'deleteBeat' as const,target:voiceTarget(0,beat,1)}));
const lineProject=(lines:Array<{startBar:number;text:string}>):Project=>({...blankProject(),edits:[{type:'setNote',target:target0,string:3,fret:5},...bar1Whole,{type:'setDuration',target:voiceTarget(0,0,1),duration:1,dots:0},{type:'setNote',target:voiceTarget(0,0,1),string:2,fret:3},{type:'setNote',target:voiceTarget(0,0,2),string:2,fret:4},{type:'setTrackLyrics',track:0,visible:true,lines}]});
/** From the quarter note in bar 1 to three eighths into the whole note that opens bar 2. */
const acrossBarline=(project:Project):Project=>({...project,edits:[...project.edits,cutLog(range([0,0],[1,1440]))]});
const bySyllable=(score:model.Score)=>score.tracks[0].staves[0].bars.slice(0,3).flatMap(bar=>bar.voices[0].beats.filter(beat=>beat.notes.length).map(beat=>beat.lyrics?.[0]??''));
it('a line that starts in the second bar is refused when that bar gains a syllable beat although the track total is unchanged',()=>{
  const project=lineProject([{startBar:1,text:'one two three'}]);expect(bySyllable(buildDocument(project).score)).toEqual(['','one','two']);
  const score=buildDocument(project).score,before=json(score);
  expect(()=>cut(score,range([0,0],[1,1440]))).toThrow(/syllables/);expect(json(score)).toBe(before);
  expect(()=>buildDocument(acrossBarline(project))).toThrow(/syllables/);
});
it('the same cut is allowed when the line starts in the first bar, and later syllables stay where they are',()=>{
  const project=lineProject([{startBar:0,text:'one two three'}]);expect(bySyllable(buildDocument(project).score)).toEqual(['one','two','three']);
  expect(bySyllable(buildDocument(acrossBarline(project)).score).slice(-1)).toEqual(['three']);
});
it('with two lines only one of which would shift, the cut is refused; a line without text is ignored',()=>{
  expect(()=>buildDocument(acrossBarline(lineProject([{startBar:0,text:'one two three'},{startBar:1,text:'a b c'}])))).toThrow(/syllables/);
  expect(()=>buildDocument(acrossBarline(lineProject([{startBar:1,text:''},{startBar:0,text:'one two three'}])))).not.toThrow();
});
