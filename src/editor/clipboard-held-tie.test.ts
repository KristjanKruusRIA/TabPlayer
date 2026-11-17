import { expect,it } from 'vitest';
import { model,Settings } from '@coderline/alphatab';
import { scoreFromJson } from '../model-clone';
import { validateMusicClipEnvelope } from '../parity-commands';
import { music } from './fixtures';
import { applyRangeEdit } from './range-edits';
import { makeMusicClip,readMusicClip,scoreFromMusicClip } from './clipboard-source';
import { preparePasteMusic } from './clipboard-paste';
import { captureNoteLinks,restoreNoteLinks } from './links';
import { rhythmTicks } from './common';
import type { ClipboardCommand,MusicClip } from './clipboard-types';
import type { MusicSelection } from './range-types';

const fresh=(score:model.Score)=>{const copy=scoreFromJson(model.JsonConverter.scoreToJson(score),new Settings());restoreNoteLinks(copy,captureNoteLinks(score));return copy;};
const range=(start:[number,number],end:[number,number]):MusicSelection=>({kind:'range',range:{start:{bar:start[0],tick:start[1]},end:{bar:end[0],tick:end[1]},lanes:[{track:0,staff:0,voice:0}]}});
const beatsOf=(score:model.Score,bar=0)=>score.tracks[0].staves[0].bars[bar].voices[0].beats;
const note=(string:number,fret:number)=>{const value=new model.Note();value.string=string;value.fret=fret;return value;};
/** Bar 0 is two half notes (string 5 fret 2, string 4 fret 7); the rest of the score is as in the fixture. */
function twoHalves() {
  const score=music(),voice=score.tracks[0].staves[0].bars[0].voices[0],halves:model.Beat[]=[];
  for(const [string,fret] of [[5,2],[4,7]]){const beat=new model.Beat();beat.duration=2;beat.isEmpty=false;beat.addNote(note(string,fret));halves.push(beat);}
  voice.beats=halves;return fresh(score);
}
const command=(clip:MusicClip,beat:number,bar=0):ClipboardCommand=>({type:'pasteMusic',clip,options:{target:{track:0,staff:0,bar,voice:0,beat},destinations:[{sourceTrack:0,track:0,staffMap:[0]}],count:1,placement:'currentBar',filters:{diagrams:true,texts:true,timers:true,trackAutomations:true,masterAutomations:false,sections:false}}});
const startIndex=(score:model.Score,tick:number,bar=0)=>{let at=0;return beatsOf(score,bar).findIndex(beat=>{const found=at===tick;at+=rhythmTicks(beat);return found;});};
/** Cut the range, return the clip and the cut score. */
function cutOut(selection:MusicSelection,score=twoHalves()) {
  const clip=makeMusicClip(score,selection,'singleTrack',{cut:true});
  expect(applyRangeEdit(score,{type:'cutSelection',selection})).toBe(true);return {clip,score};
}
const ties=(score:model.Score,bar=0)=>beatsOf(score,bar).map(beat=>beat.notes.map(item=>[item.isTieDestination,!!item.tieDestination]));

it('a clip cut out of the middle of a held note says that it continues one and is continued',()=>{
  const {clip}=cutOut(range([0,480],[0,1440]));
  expect(clip.held).toEqual({continues:expect.any(Array),continued:expect.any(Array)});expect(clip.held!.continues).toHaveLength(1);expect(clip.held!.continued).toHaveLength(1);
  expect(readMusicClip(clip).held).toEqual(clip.held);expect(() => validateMusicClipEnvelope(clip)).not.toThrow();
});
it('pasting the cut material back at the cut start restores both ties instead of striking the note again',()=>{
  const {clip,score}=cutOut(range([0,480],[0,1440]));
  const restored=preparePasteMusic(score,command(clip,startIndex(score,480))).score;
  const [head,middle,tail]=beatsOf(restored).slice(0,3).map(beat=>beat.notes[0]);
  expect(middle.tieOrigin).toBe(head);expect(head.tieDestination).toBe(middle);expect(middle.isTieDestination).toBe(true);
  expect(tail.tieOrigin).toBe(middle);expect(middle.tieDestination).toBe(tail);expect(tail.isTieDestination).toBe(true);
  expect(beatsOf(restored).reduce((sum,beat)=>sum+rhythmTicks(beat),0)).toBe(3840);
  // The untouched second half stays a plain attack.
  expect(ties(restored).at(-1)).toEqual([[false,false]]);
});
it('a clip without the marker pastes exactly as an old clip did: the note is struck again at both edges',()=>{
  const {clip,score}=cutOut(range([0,480],[0,1440]));
  const {held:_held,...old}=clip;void _held;
  const restored=preparePasteMusic(score,command(old as MusicClip,startIndex(score,480))).score;
  expect(ties(restored).slice(0,3)).toEqual([[[false,false]],[[false,false]],[[false,false]]]);
});
it('the ties are made only when the neighbouring beat holds the same pitch on the same string',()=>{
  const {clip,score}=cutOut(range([0,480],[0,1440])),index=startIndex(score,480);
  beatsOf(score)[0].notes[0].fret=9;beatsOf(score)[index+1].notes[0].string=3;
  const restored=preparePasteMusic(score,command(clip,index)).score;
  expect(ties(restored).slice(0,3)).toEqual([[[false,false]],[[false,false]],[[false,false]]]);
});
it('a paste at the start of a bar ties to the beat that ends the bar before, and a following beat of another pitch stays a plain attack',()=>{
  const {clip,score}=cutOut(range([0,480],[0,1440]));
  const before=beatsOf(score).at(-1)!.notes[0];before.string=5;before.fret=2;
  const restored=preparePasteMusic(score,command(clip,0,1)).score,pasted=beatsOf(restored,1)[0].notes[0];
  expect(pasted.tieOrigin).toBe(beatsOf(restored,0).at(-1)!.notes[0]);expect(pasted.isTieDestination).toBe(true);
  expect(pasted.tieDestination).toBeNull();
});
it('a plain copy that cuts no tie carries no marker and a note that is a tie destination at the clip start does',()=>{
  const score=twoHalves();expect(Object.hasOwn(makeMusicClip(score,range([0,0],[1,0]),'singleTrack'),'held')).toBe(false);
  const tied=music(),voice=tied.tracks[0].staves[0].bars[0].voices[0],[a,b]=voice.beats.map(beat=>beat.notes[0]);b.string=a.string;b.fret=a.fret;a.tieDestination=b;b.tieOrigin=a;b.isTieDestination=true;
  const clip=makeMusicClip(fresh(tied),range([0,960],[0,1920]),'singleTrack');expect(clip.held).toEqual({continues:[expect.any(Number)],continued:[]});
});
it('the marker is checked on read: ids must be notes of the clip, distinct, and match the links',()=>{
  const {clip}=cutOut(range([0,480],[0,1440]));
  const bad=(held:unknown)=>()=>readMusicClip({...clip,held} as MusicClip);
  expect(bad({continues:[999999],continued:[]})).toThrow();
  expect(bad({continues:[clip.held!.continues[0],clip.held!.continues[0]],continued:[]})).toThrow();
  expect(bad({continues:clip.held!.continues,continued:clip.held!.continued,extra:1})).toThrow();
  expect(bad({continues:clip.held!.continues})).toThrow();
  expect(bad(null)).toThrow();
});
it('a marker on a note that is not at the clip edge is refused on read, so a stored log cannot tie an attack in the middle',()=>{
  const clip=makeMusicClip(twoHalves(),range([0,0],[0,3840]),'singleTrack'),beats=beatsOf(scoreFromMusicClip(clip));
  const first=beats[0].notes[0].id,last=beats[1].notes[0].id;
  const bad=(held:unknown)=>()=>readMusicClip({...clip,held} as MusicClip);
  expect(bad({continues:[last],continued:[]})).toThrow();
  expect(bad({continues:[],continued:[first]})).toThrow();
  // The notes at the edges are accepted.
  expect(readMusicClip({...clip,held:{continues:[first],continued:[last]}} as MusicClip).held).toEqual({continues:[first],continued:[last]});
});
