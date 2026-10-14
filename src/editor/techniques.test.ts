import { expect, it } from 'vitest';
import { model } from '@coderline/alphatab';
import { applyNoteTechniques, applyBeatTechniques, applyNoteLink } from './techniques';
import { detachNote } from './links';
import { music, noteAt, reopened, target } from './fixtures';

it.each([
  ['letRing','isLetRing'],['palmMute','isPalmMute'],['dead','isDead'],['ghost','isGhost'],['staccato','isStaccato'],['leftHandTapped','isLeftHandTapped'],
] as const)('technique_family_roundtrip %s', (field,property)=>{
  const score=music();applyNoteTechniques(score,{target,string:6},{[field]:true});expect(noteAt(reopened(score))[property]).toBe(true);
  applyNoteTechniques(score,{target,string:6},{[field]:false});expect(noteAt(reopened(score))[property]).toBe(false);
});
it.each([
  ['accent','accentuated',model.AccentuationType],['dynamics','dynamics',model.DynamicValue],['leftFinger','leftHandFinger',model.Fingers],['rightFinger','rightHandFinger',model.Fingers],['slideIn','slideInType',model.SlideInType],['slideOut','slideOutType',model.SlideOutType],['vibrato','vibrato',model.VibratoType],['ornament','ornament',model.NoteOrnament],
] as const)('technique_family_roundtrip all %s enums',(field,property,enumeration)=>{
  for(const value of Object.values(enumeration).filter(v=>typeof v==='number')) {const score=music();applyNoteTechniques(score,{target,string:6},{[field]:value});expect(noteAt(score)[property]).toBe(value);expect(()=>reopened(score)).not.toThrow();}
  expect(()=>applyNoteTechniques(music(),{target,string:6},{[field]:999})).toThrow();
});
it('independent_chord_bend_curves and removal',()=>{
  const score=music(),first=noteAt(score),second=new model.Note();second.string=5;second.fret=4;first.beat.addNote(second);
  for(const [string,value] of [[6,4],[5,2]])applyNoteTechniques(score,{target,string},{bend:{type:2,style:0,points:[{offset:0,value:0},{offset:60,value}]}});
  expect(first.bendPoints?.at(-1)?.value).toBe(4);expect(second.bendPoints?.at(-1)?.value).toBe(2);
  expect(noteAt(reopened(score)).bendPoints?.at(-1)?.value).toBe(4);
  applyNoteTechniques(score,{target,string:6},{bend:null});expect(first.bendPoints).toBeNull();expect(first.bendType).toBe(0);
  expect(()=>applyNoteTechniques(score,{target,string:6},{bend:{type:2,style:0,points:[{offset:20,value:0},{offset:60,value:4}]}})).toThrow();
});
it('harmonics trill whammy tremolo and brush families',()=>{
  const score=music();
  for(const type of Object.values(model.HarmonicType).filter(v=>typeof v==='number')) {applyNoteTechniques(score,{target,string:6},{harmonic:{type,value:12}});expect(noteAt(score).harmonicType).toBe(type);}
  applyNoteTechniques(score,{target,string:6},{trill:{pitch:70,speed:16}});expect(noteAt(score).trillValue).toBe(70);
  applyBeatTechniques(score,target,{pickStroke:2,brushType:3,brushDuration:60,tremolo:{speed:32,style:1},whammy:{type:1,style:0,points:[{offset:0,value:0},{offset:60,value:-4}]}});
  const beat=noteAt(reopened(score)).beat;expect(beat.pickStroke).toBe(2);expect(beat.brushType).toBe(3);expect(beat.whammyBarPoints?.at(-1)?.value).toBe(-4);expect(beat.tremoloPicking?.style).toBe(1);
  applyBeatTechniques(score,target,{tremolo:null,whammy:null});expect(noteAt(score).beat.tremoloPicking).toBeUndefined();expect(noteAt(score).beat.whammyBarPoints).toBeNull();
});
it.each(['tie','hammerPull','slur'] as const)('linked %s repairs both ends on detach',kind=>{
  const score=music();applyNoteLink(score,{target,string:6},{target:{...target,beat:1},string:6},kind);
  const first=noteAt(score),second=noteAt(score,0,1);expect(kind==='tie'?second.tieOrigin:kind==='slur'?second.slurOrigin:second.hammerPullOrigin).toBe(first);
  detachNote(first);expect(second.tieOrigin).toBeNull();expect(second.slurOrigin).toBeNull();expect(second.hammerPullOrigin).toBeNull();
});
it('break_tie_allows_independent_pitch and rejects invalid links',()=>{
  const score=music(),from={target,string:6},to={target:{...target,beat:1},string:6};
  applyNoteLink(score,from,to,'tie');applyNoteLink(score,from,null,'tie');noteAt(score).fret=7;expect(noteAt(score,0,1).fret).toBe(3);
  expect(()=>applyNoteLink(score,to,from,'slur')).toThrow();expect(()=>applyNoteLink(score,from,{...to,string:5},'hammerPull')).toThrow();
});
it('adding and breaking one tie preserves the other links in its chain',()=>{
  const score=music(),first={target,string:6},middle={target:{...target,beat:1},string:6},last={target:{...target,beat:2},string:6};
  applyNoteLink(score,first,middle,'tie');applyNoteLink(score,middle,last,'tie');expect(noteAt(score,0,1).tieOrigin).toBe(noteAt(score));
  applyNoteLink(score,middle,null,'tie');expect(noteAt(score,0,1).tieOrigin).toBe(noteAt(score));expect(noteAt(score,0,2).tieOrigin).toBeNull();
});
it.each(['bend','whammy'] as const)('all public %s curve types and styles and malformed points',family=>{
  for(const type of Object.values(family==='bend'?model.BendType:model.WhammyType).filter(v=>typeof v==='number'&&v!==0))for(const style of Object.values(model.BendStyle).filter(v=>typeof v==='number')) {
    const score=music(),curve={type,style,points:[{offset:0,value:0},{offset:60,value:4}]};
    if(family==='bend')applyNoteTechniques(score,{target,string:6},{bend:curve});else applyBeatTechniques(score,target,{whammy:curve});
    expect(()=>reopened(score)).not.toThrow();
  }
  for(const points of [[{offset:0,value:0},{offset:0,value:4},{offset:60,value:4}],[{offset:0,value:NaN},{offset:60,value:4}],[{offset:0,value:0},{offset:61,value:4}]])expect(()=>family==='bend'?applyNoteTechniques(music(),{target,string:6},{bend:{type:1,style:0,points}}):applyBeatTechniques(music(),target,{whammy:{type:1,style:0,points}})).toThrow();
});
it('all beat enums and malformed parameters preserve music',()=>{
  for(const [field,enumeration] of [['pickStroke',model.PickStroke],['brushType',model.BrushType]] as const)for(const value of Object.values(enumeration).filter(v=>typeof v==='number')){const score=music();applyBeatTechniques(score,target,{[field]:value});expect(noteAt(score).beat[field]).toBe(value);}
  for(const patch of [{brushDuration:-1},{pickStroke:999},{brushType:999},{tremolo:{speed:3,style:0}},{tremolo:{speed:16,style:999}}])expect(()=>applyBeatTechniques(music(),target,patch)).toThrow();
  for(const patch of [{letRing:'yes'},{harmonic:{type:1,value:NaN}},{trill:{pitch:128,speed:16}},{trill:{pitch:60,speed:3}}])expect(()=>applyNoteTechniques(music(),{target,string:6},patch as never)).toThrow();
});
it('tremolo speed is the selected duration across different beat rhythms',()=>{
  const score=music();noteAt(score).beat.duration=8;applyBeatTechniques(score,target,{tremolo:{speed:16,style:0}});
  expect(noteAt(score).beat.tremoloPicking?.getDurationAsTicks(8)).toBe(240);expect(noteAt(reopened(score)).beat.tremoloSpeed).toBe(16);
  expect(()=>applyBeatTechniques(music(),target,{tremolo:{speed:256,style:0}})).toThrow(/tremolo/i);
});
it('trill accepts every pinned public duration and clearing removes its pitch',()=>{
  const score=music();for(const speed of [-4,-2,1,2,4,8,16,32,64,128,256]){applyNoteTechniques(score,{target,string:6},{trill:{pitch:70,speed}});expect(noteAt(score).trillSpeed).toBe(speed);}
  applyNoteTechniques(score,{target,string:6},{trill:null});expect(noteAt(score).isTrill).toBe(false);
});
it('deleting a bent tie origin clears surviving bend continuation metadata',()=>{
  const score=music(),first=noteAt(score),second=noteAt(score,0,1);applyNoteLink(score,{target,string:6},{target:{...target,beat:1},string:6},'tie');second.bendOrigin=first;second.isContinuedBend=true;
  detachNote(first);expect(second.bendOrigin).toBeNull();expect(second.isContinuedBend).toBe(false);
});
