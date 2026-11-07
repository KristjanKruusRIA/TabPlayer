import { expect,it } from 'vitest';
import { buildDocument,previewEdit,trackIdentity } from '../engine';
import type { BuiltDocument } from '../engine';
import { blankProject } from '../project';
import { defaultEngraving,validateEngraving } from './projection';
import { engravingRenderKey } from './system-gaps';
import {
  addStaffGroup,copyTrackStaffLayout,drawnGroups,groupStates,groupingProblem,isLongFirstShortAfter,removeAllStaffGroups,removeStaffGroup,resetAllStaffGaps,resetStaffGap,
  resolveStaffGaps,setStaffGap,setStaffGroupKind,staffGapOf,validateStaffGaps,validateStaffGroups,withLongFirstShortAfter,withStaffGaps,withStaffGroups,
} from './staff-groups';

const ids=['base/0','base/1','base/2','base/3'],big='x'.repeat(65_537),multi='é'.repeat(32_769); // 65,538 bytes, 32,769 UTF-16 units
const identitiesOf=(doc:BuiltDocument)=>doc.score.tracks.map(trackIdentity);
const fourTracks=()=>{
  let project=blankProject();
  for(const name of ['B','C','D'])project=previewEdit(project,{type:'addPitchedTrack',name,program:0}).project;
  return project;
};
const grouped=(project:ReturnType<typeof blankProject>,members:number[])=>{
  const doc=buildDocument(project),all=identitiesOf(doc);
  const engraving=addStaffGroup(doc.settings.engraving,all,members.map(index=>all[index]),'bracket');
  return {project:previewEdit(project,{type:'setEngraving',engraving}).project,doc};
};

it('validates groups: shape, kinds, 2..64 ids, 64 groups, id bytes, flat',()=>{
  expect(()=>validateStaffGroups([{trackIds:['base/0','base/1'],kind:'brace'}])).not.toThrow();
  expect(()=>validateStaffGroups([{trackIds:[' ','b'],kind:'bracket'}])).not.toThrow(); // no trimming
  for(const bad of [[{trackIds:['base/0'],kind:'bracket'}],[{trackIds:['a','a'],kind:'bracket'}],[{trackIds:['a','b'],kind:'curly'}],
    [{trackIds:['a','b'],kind:'bracket'},{trackIds:['b','c'],kind:'brace'}],[{trackIds:['','b'],kind:'bracket'}],
    [{trackIds:['a','b'],kind:'bracket',extra:1}],Array.from({length:65},(_,i)=>({trackIds:[`x${i}`,`y${i}`],kind:'bracket'})),
    [{trackIds:Array.from({length:65},(_,i)=>`t${i}`),kind:'bracket'}],[{trackIds:[big,'b'],kind:'bracket'}],[{trackIds:[multi,'b'],kind:'bracket'}]])
    expect(()=>validateStaffGroups(bad)).toThrow();
});
it('validates gaps: ids like group ids, distinct, 0.25..4, at most 256',()=>{
  expect(()=>validateStaffGaps([{trackId:'base/0',scale:.25},{trackId:'base/1',scale:4}])).not.toThrow();
  for(const bad of [[{trackId:'a',scale:.24}],[{trackId:'a',scale:4.01}],[{trackId:'a',scale:NaN}],[{trackId:'a',scale:1},{trackId:'a',scale:2}],
    [{trackId:'',scale:2}],[{trackId:big,scale:2}],[{trackId:multi,scale:2}],[{trackId:'a',scale:2,x:1}],Array.from({length:257},(_,i)=>({trackId:`t${i}`,scale:2}))])
    expect(()=>validateStaffGaps(bad)).toThrow();
});
it('validateEngraving accepts both keys only when present and an old engraving without them',()=>{
  expect(()=>validateEngraving(defaultEngraving())).not.toThrow();
  expect(()=>validateEngraving({...defaultEngraving(),staffGroups:[{trackIds:['a','b'],kind:'brace'}],staffGaps:[{trackId:'a',scale:2}]})).not.toThrow();
  expect(()=>validateEngraving({...defaultEngraving(),staffGroups:'x'})).toThrow();
  expect(()=>validateEngraving({...defaultEngraving(),staffGaps:[{trackId:'',scale:2}]})).toThrow();
});
it('resolves states and drawn groups over the rendered subset',()=>{
  const groups=[{trackIds:['base/2','base/1'],kind:'bracket' as const},{trackIds:['base/0','base/3'],kind:'brace' as const},{trackIds:['gone','base/3'],kind:'brace' as const}];
  expect(groupStates(groups.slice(0,2),ids)).toEqual(['drawn','notContiguous']);
  expect(drawnGroups(groups.slice(0,1),ids,[0,1,2,3])).toEqual([{index:0,kind:'bracket',tracks:[1,2]}]);
  expect(drawnGroups(groups.slice(0,1),ids,[1])).toEqual([]);
  expect(groupStates(groups.slice(0,1),ids,[1])).toEqual(['notShown']);
  expect(groupStates([groups[2]],ids)).toEqual(['tooFewTracks']);
});
it('keeps a group drawable through duplicate and reports move and remove states',()=>{
  const {project}=grouped(fourTracks(),[0,1,2]);
  const dup=buildDocument(previewEdit(project,{type:'duplicateTrack',track:1}).project);
  expect(dup.settings.engraving.staffGroups![0].trackIds).toHaveLength(4);
  expect(groupStates(dup.settings.engraving.staffGroups,identitiesOf(dup))).toEqual(['drawn']);
  const pair=grouped(fourTracks(),[0,1]).project,moved=previewEdit(pair,{type:'moveTrack',track:0,to:3}).project;
  expect(groupStates(buildDocument(moved).settings.engraving.staffGroups,identitiesOf(buildDocument(moved)))).toEqual(['notContiguous']);
  const replayed=buildDocument({...moved,edits:moved.edits.slice(0,-1)}); // the log without the move
  expect(groupStates(replayed.settings.engraving.staffGroups,identitiesOf(replayed))).toEqual(['drawn']);
  const removed=buildDocument(previewEdit(pair,{type:'removeTrack',track:1}).project);
  expect(groupStates(removed.settings.engraving.staffGroups,identitiesOf(removed))).toEqual(['tooFewTracks']);
  expect(removed.settings.engraving.staffGroups).toEqual(buildDocument(pair).settings.engraving.staffGroups);
});
it('a copy does not join a group already holding 64 ids',()=>{
  const full=withStaffGroups(defaultEngraving(),[{trackIds:Array.from({length:64},(_,i)=>`t${i}`),kind:'bracket'}]);
  expect(copyTrackStaffLayout(full,'t5','copy').staffGroups![0].trackIds).toHaveLength(64);
  expect(copyTrackStaffLayout(withStaffGroups(defaultEngraving(),[{trackIds:['a','b','c'],kind:'brace'}]),'b','copy').staffGroups![0].trackIds).toEqual(['a','b','copy','c']);
});
it('copies the source gap to a duplicate and leaves other tracks alone',()=>{
  const e=withStaffGaps(defaultEngraving(),[{trackId:'base/1',scale:2},{trackId:'base/2',scale:.5}]);
  expect(copyTrackStaffLayout(e,'base/1','added/5/x').staffGaps).toEqual([{trackId:'base/1',scale:2},{trackId:'base/2',scale:.5},{trackId:'added/5/x',scale:2}]);
  expect(copyTrackStaffLayout(e,'base/0','added/5/x')).toBe(e);
});
it('add, kind, remove and gap helpers return the same object when nothing changes',()=>{
  const e=defaultEngraving();
  expect(groupingProblem(e,ids,['base/0'])).toBe('tooFew');
  expect(groupingProblem(e,ids,['base/0','base/2'])).toBe('notContiguous');
  const grouped=addStaffGroup(e,ids,['base/2','base/1'],'bracket');
  expect(grouped.staffGroups).toEqual([{trackIds:['base/1','base/2'],kind:'bracket'}]);
  expect(groupingProblem(grouped,ids,['base/2','base/3'])).toBe('alreadyGrouped');
  expect(setStaffGroupKind(grouped,0,'bracket')).toBe(grouped);
  expect(setStaffGroupKind(grouped,0,'brace').staffGroups![0].kind).toBe('brace');
  expect(removeStaffGroup(grouped,0).staffGroups).toBeUndefined();
  expect(removeAllStaffGroups(e)).toBe(e);
  expect(setStaffGap(e,'base/0',1)).toBe(e);
  const gapped=setStaffGap(e,'base/0',2);expect(staffGapOf(gapped,'base/0')).toBe(2);expect(setStaffGap(gapped,'base/0',2)).toBe(gapped);
  expect(resetStaffGap(e,'base/0')).toBe(e);expect(resetAllStaffGaps(gapped).staffGaps).toBeUndefined();
  const named=withLongFirstShortAfter(e);expect(isLongFirstShortAfter(named)).toBe(true);expect(withLongFirstShortAfter(named)).toBe(named);
  expect(named.stylesheet.firstNameDirection).toBe(e.stylesheet.firstNameDirection);
});
it('resolves staff gaps by live track index and skips dormant ids',()=>{
  expect([...resolveStaffGaps([{trackId:'base/2',scale:2},{trackId:'gone',scale:3}],ids)]).toEqual([[2,2]]);
});
it('engravingRenderKey ignores staff gaps but not staff groups',()=>{
  const e=defaultEngraving();
  expect(engravingRenderKey(withStaffGaps(e,[{trackId:'a',scale:2}]))).toBe(engravingRenderKey(e));
  expect(engravingRenderKey(withStaffGroups(e,[{trackIds:['a','b'],kind:'brace'}]))).not.toBe(engravingRenderKey(e));
});
it('a copy gets no gap entry when 256 gaps exist',()=>{
  const full=withStaffGaps(defaultEngraving(),Array.from({length:256},(_,i)=>({trackId:`t${i}`,scale:2})));
  expect(copyTrackStaffLayout(full,'t5','copy')).toBe(full);
});
