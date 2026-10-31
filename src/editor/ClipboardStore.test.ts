import { expect,it } from 'vitest';
import { music } from './fixtures';
import { ClipboardStore } from './ClipboardStore';
import { makeMusicClip } from './clipboard-source';
import { model } from '@coderline/alphatab';
import { setHarmonyChordSource } from '../harmony/chord-source';
import type { HarmonyChord } from './harmony-types';

it('store_clones_and_retains_across_document_change',()=>{
  const store=new ClipboardStore();expect(store.get()).toBeNull();
  const clip=makeMusicClip(music(),{kind:'bars',tracks:[0],firstBar:0,lastBar:0},'singleTrack');store.set(clip);
  const before=store.get();clip.links.push({from:0,to:1,kind:'tie',slideOutType:null});clip.scoreJson='changed';expect(store.get()).toEqual(before);
  const retrieved=store.get()!;retrieved.links.push({from:2,to:3,kind:'tie',slideOutType:null});expect(store.get()).toEqual(before);
  music();expect(store.get()).toEqual(before);
  expect(()=>store.set({...before!,version:2} as never)).toThrow();expect(store.get()).toEqual(before);
});
it('does not alias individual link records or accept invalid semantic replacement',()=>{
  const score=music(),a=score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0],b=score.tracks[0].staves[0].bars[0].voices[0].beats[1].notes[0];a.tieDestination=b;b.tieOrigin=a;b.isTieDestination=true;
  const clip=makeMusicClip(score,{kind:'bars',tracks:[0],firstBar:0,lastBar:0},'singleTrack'),store=new ClipboardStore();store.set(clip);const expected=store.get();clip.links[0].to=123456;store.get()!.links[0].from=999;
  expect(store.get()).toEqual(expected);expect(()=>store.set({...expected!,links:[{from:0,to:999999,kind:'tie',slideOutType:null}]})).toThrow();expect(store.get()).toEqual(expected);
});
it('store copies v2 records, theory, fingers and barres through get, set and invalid replacement',()=>{
  const score=music(),staff=score.tracks[0].staves[0],value:HarmonyChord={name:'C',nameMode:'theory',recipe:{root:{step:0,alteration:0},formula:'major',alterations:[],omissions:[],bass:null},firstFret:1,frets:[0,1,0,2,3,-1],fingers:[-2,1,-2,2,3,-2],barreFrets:[],showName:true,showDiagram:true,showFingering:true},chord=Object.assign(new model.Chord(),{name:value.name,strings:[...value.frets]});staff.addChord('rich',chord);staff.bars[0].voices[0].beats[0].chordId='rich';setHarmonyChordSource(chord,value);
  const clip=makeMusicClip(score,{kind:'bars',tracks:[0],firstBar:0,lastBar:0},'singleTrack');expect(clip.version).toBe(2);if(clip.version!==2)throw new Error('Expected rich clipboard');const store=new ClipboardStore();store.set(clip);const before=structuredClone(store.get());clip.harmony[0].chord.recipe!.root.step=1;expect(store.get()).toEqual(before);
  const fetched=store.get()!;if(fetched.version!==2)throw new Error('Expected rich clipboard');fetched.harmony[0].chord.fingers[0]=4;fetched.harmony[0].chord.barreFrets.push(10);fetched.harmony[0].chord.recipe!.omissions.push(3);expect(store.get()).toEqual(before);
  expect(()=>store.set(fetched)).toThrow();expect(store.get()).toEqual(before);
});
