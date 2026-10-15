import { expect,it } from 'vitest';
import { music } from './fixtures';
import { ClipboardStore } from './ClipboardStore';
import { makeMusicClip } from './clipboard-source';

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
