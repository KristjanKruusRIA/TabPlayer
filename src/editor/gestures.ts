import { model } from '@coderline/alphatab';
import type { BeatTarget } from '../project';
import type { GestureCommand,GesturePatch } from './gestures-types';
import { beatAt,integer,locationAt } from './common';

const flags=['tap','slap','pop','deadSlapped','slashed','showTimer'] as const;
const enums={golpe:2,rasgueado:18,fade:3,vibrato:2,beamingMode:3} as const;
function exact(value:unknown,keys:readonly string[],required=keys):asserts value is Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key))||required.some(key=>!Object.hasOwn(value,key)))throw new Error('Invalid gesture fields.');
}
function selected(score:model.Score,target:BeatTarget) {
  exact(target,['track','staff','bar','voice','beat']);return beatAt(score,target);
}
function range(score:model.Score,from:BeatTarget,to:BeatTarget) {
  selected(score,from);selected(score,to);
  if(from.track!==to.track||from.staff!==to.staff||from.voice!==to.voice||from.bar>to.bar||(from.bar===to.bar&&from.beat>to.beat))throw new Error('Select a forward range in the same staff and voice.');
  const staff=locationAt(score,from).staff,beats:model.Beat[]=[];
  for(let bar=from.bar;bar<=to.bar;bar++){
    const voice=staff.bars[bar]?.voices[from.voice];if(!voice)throw new Error('Select an existing voice throughout the range.');
    beats.push(...voice.beats.slice(bar===from.bar?from.beat:0,bar===to.bar?to.beat+1:undefined));
  }
  return beats;
}
function applyPatch(beat:model.Beat,patch:GesturePatch) {
  exact(patch,[...flags,...Object.keys(enums),'barre','stem'],[]);if(!Object.keys(patch).length)throw new Error('Choose a beat gesture.');
  for(const key of flags)if(Object.hasOwn(patch,key)&&typeof patch[key]!=='boolean')throw new Error('Invalid gesture flag.');
  for(const key of Object.keys(enums) as (keyof typeof enums)[])if(Object.hasOwn(patch,key)&&!integer(patch[key]!,0,enums[key]))throw new Error(`Invalid ${key}.`);
  if(Object.hasOwn(patch,'barre')&&patch.barre!==null){exact(patch.barre,['fret','shape']);if(!integer(patch.barre.fret,1,127)||!integer(patch.barre.shape,1,2))throw new Error('Choose a valid barre fret and shape.');}
  if(Object.hasOwn(patch,'stem')&&!['auto','inverted','up','down'].includes(patch.stem!))throw new Error('Invalid stem direction.');
  const staff=beat.voice.bar.staff;
  if((staff.isPercussion||!staff.tuning.length)&&(patch.tap||patch.slap||patch.pop||patch.deadSlapped||patch.golpe||patch.rasgueado||patch.barre))throw new Error('This gesture requires a stringed guitar or bass staff.');
  if(patch.rasgueado&&new Set(beat.notes.filter(n=>n.isStringed).map(n=>n.string)).size<2)throw new Error('Rasgueado requires a chord on at least two strings.');
  for(const key of flags)if(Object.hasOwn(patch,key))Object.assign(beat,{[key]:patch[key]!});
  for(const key of Object.keys(enums) as (keyof typeof enums)[])if(Object.hasOwn(patch,key))Object.assign(beat,{[key]:patch[key]!});
  if(Object.hasOwn(patch,'barre')){beat.barreFret=patch.barre?.fret??0;beat.barreShape=patch.barre?.shape??0;}
  if(Object.hasOwn(patch,'showTimer'))beat.timer=null;
  if(patch.stem!==undefined){beat.invertBeamDirection=patch.stem==='inverted';beat.preferredBeamDirection=patch.stem==='up'?0:patch.stem==='down'?1:null;}
}
export function applyGestureEdit(score:model.Score,command:GestureCommand):boolean {
  switch(command.type){
    case 'setBeatGestures':exact(command,['type','target','patch']);applyPatch(selected(score,command.target),command.patch);return true;
    case 'setOttava':{
      exact(command,['type','from','to','ottava']);if(!integer(command.ottava,0,4))throw new Error('Invalid ottava.');const beats=range(score,command.from,command.to);
      for(const beat of beats)beat.ottava=command.ottava;return true;
    }
    case 'setCrescendo':{
      exact(command,['type','from','to','crescendo','targetDynamics']);
      if(!integer(command.crescendo,0,2)||(command.crescendo===0?command.targetDynamics!==null:!integer(command.targetDynamics!,0,7)))throw new Error('Choose a valid hairpin and target dynamic.');
      const beats=range(score,command.from,command.to),attacks=beats.filter(b=>!b.isEmpty&&!b.isRest&&!b.deadSlapped&&b.graceType===model.GraceType.None&&b.notes.some(note=>{
        // The public player retriggers these effects before suppressing tied/legato continuations.
        if(b.hasRasgueado||note.ornament!==model.NoteOrnament.None||(note.isTrill&&!b.voice.bar.staff.isPercussion))return true;
        if(b.isTremolo)return b.tremoloPicking!.marks>0;
        return !note.isTieDestination&&note.slideOrigin?.slideOutType!==model.SlideOutType.Legato;
      }));
      if(command.crescendo===0){for(const beat of beats)beat.crescendo=0;return true;}
      const start=attacks[0]?.dynamics,end=command.targetDynamics!;
      if(attacks.length<2||!integer(start,0,7)||(command.crescendo===1?end<=start:end>=start))throw new Error('A hairpin needs two attacks controlled by dynamics and a target dynamic in its direction.');
      const first=attacks[0].absoluteDisplayStart,last=attacks.at(-1)!.absoluteDisplayStart;
      if(!Number.isFinite(first)||!Number.isFinite(last)||last<=first)throw new Error('The hairpin needs two distinct attack onsets.');
      const values=attacks.map(beat=>Math.round(start+(end-start)*(beat.absoluteDisplayStart-first)/(last-first)));
      for(const beat of beats)beat.crescendo=command.crescendo;
      attacks.forEach((beat,index)=>{beat.dynamics=values[index];for(const note of beat.notes)note.dynamics=values[index];});return true;
    }
    case 'setFermata':{
      exact(command,['type','target','fermata']);const beat=selected(score,command.target);
      if(beat.graceType!==model.GraceType.None)throw new Error('Select a regular beat or rest for the global fermata.');
      if(command.fermata!==null){exact(command.fermata,['type','length']);if(!integer(command.fermata.type,0,2)||!Number.isFinite(command.fermata.length)||command.fermata.length<=0)throw new Error('Choose a valid fermata type and positive stored length.');}
      const offset=beat.playbackStart;if(!integer(offset))throw new Error('Invalid fermata position.');
      const master=beat.voice.bar.masterBar,aligned=score.tracks.flatMap(track=>track.staves.flatMap(staff=>staff.bars[master.index]?.voices.flatMap(voice=>voice.beats.filter(b=>b.playbackStart===offset||(offset===0&&b.index===0&&!master.fermata?.has(b.playbackStart))))??[]));
      const fermata=command.fermata===null?null:Object.assign(new model.Fermata(),command.fermata);
      if(fermata)master.addFermata(offset,fermata);else master.fermata?.delete(offset);
      for(const alignedBeat of aligned)alignedBeat.fermata=fermata;return true;
    }
    default:return false;
  }
}





