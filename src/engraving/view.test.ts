import { expect, it } from 'vitest';
import { resolveVisibleTracks, type TrackView } from './view';

it('selected_all_and_custom_follow_live_source_order',()=>{
  const ids=['base/0','added/3','base/1'];
  expect(resolveVisibleTracks(ids,1,{kind:'selected'})).toEqual([1]);
  expect(resolveVisibleTracks(ids,1,{kind:'all'})).toEqual([0,1,2]);
  expect(resolveVisibleTracks(ids,1,{kind:'custom',trackIds:['base/1','base/0']})).toEqual([0,2]);
});

it('custom membership survives index shifts and ignores newly added tracks',()=>{
  const view:TrackView={kind:'custom',trackIds:['base/1','base/0']};
  expect(resolveVisibleTracks(['base/0','base/1'],0,view)).toEqual([0,1]);
  expect(resolveVisibleTracks(['added/3','base/1'],0,view)).toEqual([1]);
  expect(resolveVisibleTracks(['base/1','added/3'],1,view)).toEqual([0]);
});

it('removed or empty custom membership falls back to the active track',()=>{
  expect(resolveVisibleTracks(['base/0','added/3'],1,{kind:'custom',trackIds:['base/1']})).toEqual([1]);
  expect(resolveVisibleTracks(['base/0','added/3'],0,{kind:'custom',trackIds:[]})).toEqual([0]);
  expect(resolveVisibleTracks([],0,{kind:'selected'})).toEqual([]);
  expect(resolveVisibleTracks([],0,{kind:'all'})).toEqual([]);
  expect(resolveVisibleTracks([],0,{kind:'custom',trackIds:['base/0']})).toEqual([]);
});

it('selecting a hidden track preserves custom membership and all inputs',()=>{
  const ids=Object.freeze(['base/0','added/3','base/1']),view:TrackView={kind:'custom',trackIds:['base/1','base/0']};
  Object.freeze(view.trackIds);Object.freeze(view);
  const visible=resolveVisibleTracks(ids,1,view);
  expect(visible).toEqual([0,2]);visible.reverse();
  expect(resolveVisibleTracks(ids,0,view)).toEqual([0,2]);
  expect(ids).toEqual(['base/0','added/3','base/1']);
  expect(view).toEqual({kind:'custom',trackIds:['base/1','base/0']});
});
