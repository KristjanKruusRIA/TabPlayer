import { model } from '@coderline/alphatab';
import type { BeatTarget } from '../project';
import type { NoteTarget, NoteTechniques, BeatTechniques, PitchCurve, LinkKind } from '../edit-types';
import { beatAt, noteAt, enumValue, integer, durationValues, tremoloMarks } from './common';

export function validateCurve(curve:PitchCurve,whammy=false) {
  enumValue(curve.type,whammy?model.WhammyType:model.BendType,'curve type');enumValue(curve.style,model.BendStyle,'curve style');
  if(curve.type===0||!Array.isArray(curve.points)||curve.points.length<2||curve.points[0].offset!==0||curve.points.at(-1)?.offset!==60)throw new Error('Pitch curves need endpoints at 0 and 60.');
  let previous=-1;for(const point of curve.points){if(!Number.isFinite(point.offset)||point.offset<0||point.offset>60||point.offset<=previous||!Number.isFinite(point.value)||(!whammy&&point.value<0))throw new Error('Use sorted finite curve points on the 0–60 axis.');previous=point.offset;}
}
function nextOnString(note:model.Note) {
  const staff=note.beat.voice.bar.staff,voice=note.beat.voice.index;
  for(let bar=note.beat.voice.bar.index;bar<staff.bars.length;bar++)for(let beat=bar===note.beat.voice.bar.index?note.beat.index+1:0;beat<staff.bars[bar].voices[voice].beats.length;beat++) {
    const candidate=staff.bars[bar].voices[voice].beats[beat].notes.find(n=>n.string===note.string&&!n.isDead);if(candidate)return candidate;
  }
  return null;
}
function breakOutgoing(note:model.Note,kind:LinkKind) {
  if(kind==='tie'){if(note.tieDestination){note.tieDestination.tieOrigin=null;note.tieDestination.isTieDestination=false;note.tieDestination.bendOrigin=null;note.tieDestination.isContinuedBend=false;}note.tieDestination=null;}
  if(kind==='slur'){if(note.slurDestination){note.slurDestination.slurOrigin=null;note.slurDestination.isSlurDestination=false;}note.slurDestination=null;}
  if(kind==='hammerPull'){if(note.hammerPullDestination)note.hammerPullDestination.hammerPullOrigin=null;note.hammerPullDestination=null;note.isHammerPullOrigin=false;}
}
export function applyNoteLink(score:model.Score,from:NoteTarget,to:NoteTarget|null,kind:LinkKind) {
  if(!['tie','hammerPull','slur'].includes(kind))throw new Error('Invalid note relationship.');
  const origin=noteAt(score,from);if(!to){breakOutgoing(origin,kind);return;}
  const destination=noteAt(score,to),a=from.target,b=to.target;
  if(a.track!==b.track||a.staff!==b.staff||a.voice!==b.voice||b.bar<a.bar||(b.bar===a.bar&&b.beat<=a.beat))throw new Error('Link notes forward in the same staff and voice.');
  if(kind!=='slur'&&(from.string!==to.string||nextOnString(origin)!==destination))throw new Error('Link to the next pitched note on the same string.');
  if(kind==='tie'&&origin.realValue!==destination.realValue)throw new Error('Tied notes must have the same pitch.');
  breakOutgoing(origin,kind);
  const previous=kind==='tie'?destination.tieOrigin:kind==='slur'?destination.slurOrigin:destination.hammerPullOrigin;if(previous)breakOutgoing(previous,kind);
  if(kind==='tie'){origin.tieDestination=destination;destination.tieOrigin=origin;destination.isTieDestination=true;}
  if(kind==='slur'){origin.slurDestination=destination;destination.slurOrigin=origin;destination.isSlurDestination=true;}
  if(kind==='hammerPull'){origin.isHammerPullOrigin=true;origin.hammerPullDestination=destination;destination.hammerPullOrigin=origin;}
}
export function applyNoteTechniques(score:model.Score,target:NoteTarget,patch:NoteTechniques) {
  const note=noteAt(score,target);
  const booleans={letRing:'isLetRing',palmMute:'isPalmMute',dead:'isDead',ghost:'isGhost',staccato:'isStaccato',leftHandTapped:'isLeftHandTapped'} as const;
  const enums={accent:['accentuated',model.AccentuationType],dynamics:['dynamics',model.DynamicValue],leftFinger:['leftHandFinger',model.Fingers],rightFinger:['rightHandFinger',model.Fingers],slideIn:['slideInType',model.SlideInType],slideOut:['slideOutType',model.SlideOutType],vibrato:['vibrato',model.VibratoType],ornament:['ornament',model.NoteOrnament]} as const;
  for(const key of Object.keys(patch))if(!(key in booleans)&&!(key in enums)&&!['bend','harmonic','trill'].includes(key))throw new Error('Unknown note technique.');
  for(const key of Object.keys(booleans) as (keyof typeof booleans)[])if(patch[key]!==undefined&&typeof patch[key]!=='boolean')throw new Error('Invalid note technique flag.');
  for(const key of Object.keys(enums) as (keyof typeof enums)[])if(patch[key]!==undefined)enumValue(patch[key]!,enums[key][1],key);
  const slide=patch.slideOut===model.SlideOutType.Shift||patch.slideOut===model.SlideOutType.Legato?nextOnString(note):null;
  if((patch.slideOut===1||patch.slideOut===2)&&!slide)throw new Error('A linked slide needs a next note on this string.');
  if(patch.bend)validateCurve(patch.bend);
  if(patch.harmonic){enumValue(patch.harmonic.type,model.HarmonicType,'harmonic');if(!Number.isFinite(patch.harmonic.value)||patch.harmonic.value<0)throw new Error('Invalid harmonic value.');const test=new model.Note();test.beat=note.beat;test.string=note.string;test.fret=note.fret;test.harmonicType=patch.harmonic.type;test.harmonicValue=patch.harmonic.value;if(!Number.isFinite(test.realValue)||test.realValue<0||test.realValue>127)throw new Error('Harmonic is outside the playable MIDI pitch range.');}
  if(patch.trill&&(!integer(patch.trill.pitch,0,127)||!durationValues.includes(patch.trill.speed as never)))throw new Error('Invalid trill pitch or speed.');
  for(const key of Object.keys(booleans) as (keyof typeof booleans)[])if(patch[key]!==undefined)note[booleans[key]]=patch[key]!;
  for(const key of Object.keys(enums) as (keyof typeof enums)[])if(patch[key]!==undefined)Object.assign(note,{[enums[key][0]]:patch[key]});
  if(patch.slideOut!==undefined){if(note.slideTarget)note.slideTarget.slideOrigin=null;note.slideTarget=slide;if(slide){if(slide.slideOrigin)slide.slideOrigin.slideTarget=null;slide.slideOrigin=note;}}
  if(patch.bend!==undefined){note.bendPoints=null;note.maxBendPoint=null;note.bendOrigin=null;note.isContinuedBend=false;note.bendType=patch.bend?.type??0;note.bendStyle=patch.bend?.style??0;for(const p of patch.bend?.points??[])note.addBendPoint(new model.BendPoint(p.offset,p.value));}
  if(patch.harmonic!==undefined){note.harmonicType=patch.harmonic?.type??0;note.harmonicValue=patch.harmonic?.value??0;}
  if(patch.trill!==undefined){note.trillValue=patch.trill?.pitch??-1;note.trillSpeed=patch.trill?.speed??model.Duration.Sixteenth;}
}
export function applyBeatTechniques(score:model.Score,target:BeatTarget,patch:BeatTechniques) {
  const beat=beatAt(score,target);for(const key of Object.keys(patch))if(!['pickStroke','brushType','brushDuration','whammy','tremolo'].includes(key))throw new Error('Unknown beat technique.');
  if(patch.pickStroke!==undefined)enumValue(patch.pickStroke,model.PickStroke,'pick stroke');if(patch.brushType!==undefined)enumValue(patch.brushType,model.BrushType,'brush type');
  if(patch.brushDuration!==undefined&&(!Number.isFinite(patch.brushDuration)||patch.brushDuration<0))throw new Error('Invalid brush duration.');
  if(patch.whammy)validateCurve(patch.whammy,true);
  if(patch.tremolo){enumValue(patch.tremolo.style,model.TremoloPickingStyle,'tremolo style');if(tremoloMarks(beat.duration,patch.tremolo.speed)===null)throw new Error('Choose a tremolo speed faster than the beat, within five tremolo marks.');}
  if(patch.pickStroke!==undefined)beat.pickStroke=patch.pickStroke;if(patch.brushType!==undefined){beat.brushType=patch.brushType;if(patch.brushType===0)beat.brushDuration=0;}if(patch.brushDuration!==undefined)beat.brushDuration=patch.brushDuration;
  if(patch.whammy!==undefined){beat.whammyBarPoints=null;beat.maxWhammyPoint=null;beat.minWhammyPoint=null;beat.isContinuedWhammy=false;beat.whammyBarType=patch.whammy?.type??0;beat.whammyStyle=patch.whammy?.style??0;for(const p of patch.whammy?.points??[])beat.addWhammyBarPoint(new model.BendPoint(p.offset,p.value));}
  if(patch.tremolo!==undefined){if(patch.tremolo){beat.tremoloPicking=new model.TremoloPickingEffect();beat.tremoloPicking.marks=tremoloMarks(beat.duration,patch.tremolo.speed)!;beat.tremoloPicking.style=patch.tremolo.style;}else beat.tremoloPicking=undefined;}
}
