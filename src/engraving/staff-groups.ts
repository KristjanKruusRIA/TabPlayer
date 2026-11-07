import type { EngravingOverrides,StaffGap,StaffGroup,StaffGroupKind } from './types';

/** The factors Rust enforces too. A staff's gap is this factor of the standard gap (1 is the default). */
export const STAFF_GAP_RANGE={min:.25,max:4} as const;
export const MAX_STAFF_GROUPS=64,MAX_GROUP_TRACKS=64,MAX_STAFF_GAPS=256,MAX_TRACK_ID_BYTES=65_536;

const encoder=new TextEncoder();
const GROUP_KINDS:readonly string[]=['bracket','brace'];
const exact=(value:unknown,keys:string[]):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const near=(a:number,b:number)=>Math.abs(a-b)<=1e-9;
const scaleOk=(scale:unknown):scale is number=>typeof scale==='number'&&Number.isFinite(scale)&&scale>=STAFF_GAP_RANGE.min&&scale<=STAFF_GAP_RANGE.max;

/** A track identity a group or gap may name: nonempty text of at most 65,536 UTF-8 bytes. It is never trimmed. */
export function validStaffTrackId(id:unknown):id is string {
  return typeof id==='string'&&id.length>0&&encoder.encode(id).length<=MAX_TRACK_ID_BYTES;
}

// An explicit empty list is valid here; Rust drops it on write, and the TS helpers (withStaffGroups) never produce one.
export function validateStaffGroups(value:unknown):asserts value is StaffGroup[] {
  if(!Array.isArray(value)||value.length>MAX_STAFF_GROUPS)throw new Error('Invalid staff groups.');
  const seen=new Set<string>();
  for(const group of value) {
    if(!exact(group,['trackIds','kind']))throw new Error('Invalid staff group fields.');
    if(typeof group.kind!=='string'||!GROUP_KINDS.includes(group.kind))throw new Error('A staff group is a bracket or a brace.');
    const ids=group.trackIds;
    if(!Array.isArray(ids)||ids.length<2||ids.length>MAX_GROUP_TRACKS)throw new Error('A staff group holds from 2 to 64 tracks.');
    for(const id of ids) {
      if(!validStaffTrackId(id))throw new Error('A staff group names tracks by nonempty identities of at most 65536 bytes.');
      if(seen.has(id))throw new Error('A track belongs to at most one staff group.');
      seen.add(id);
    }
  }
}

export function validateStaffGaps(value:unknown):asserts value is StaffGap[] {
  if(!Array.isArray(value)||value.length>MAX_STAFF_GAPS)throw new Error('Invalid staff gaps.');
  const seen=new Set<string>();
  for(const entry of value) {
    if(!exact(entry,['trackId','scale']))throw new Error('Invalid staff gap fields.');
    if(!validStaffTrackId(entry.trackId))throw new Error('Staff gaps name tracks by nonempty identities of at most 65536 bytes.');
    if(seen.has(entry.trackId))throw new Error('Staff gaps must list each track once.');
    seen.add(entry.trackId);
    if(!scaleOk(entry.scale))throw new Error('Staff gaps must be between 25% and 400% of the standard gap.');
  }
}

/** `engraving` carrying `groups`, leaving the field out while none exists so documents saved before staff groups stay identical. */
export function withStaffGroups(engraving:EngravingOverrides,groups:readonly StaffGroup[]):EngravingOverrides {
  const {staffGroups:_dropped,...rest}=structuredClone(engraving);void _dropped;
  return groups.length?{...rest,staffGroups:groups.map(group=>({...group,trackIds:[...group.trackIds]}))}:rest;
}
/** `engraving` carrying `gaps`, leaving the field out while none is set. */
export function withStaffGaps(engraving:EngravingOverrides,gaps:readonly StaffGap[]):EngravingOverrides {
  const {staffGaps:_dropped,...rest}=structuredClone(engraving);void _dropped;
  return gaps.length?{...rest,staffGaps:gaps.map(entry=>({...entry}))}:rest;
}

export type GroupState='drawn'|'tooFewTracks'|'notContiguous'|'notShown';
export interface ResolvedGroup {index:number;kind:StaffGroupKind;tracks:number[]}

/** Document track indices of a group's members that are live, ascending. */
const liveIndices=(group:StaffGroup,trackIds:readonly string[])=>group.trackIds.map(id=>trackIds.indexOf(id)).filter(index=>index>=0).sort((a,b)=>a-b);
const contiguous=(indices:readonly number[])=>indices.length>0&&indices[indices.length-1]-indices[0]+1===indices.length;

/** Why each group is or is not drawn. `rendered` (document track indices actually shown) is optional. */
export function groupStates(groups:readonly StaffGroup[]|undefined,trackIds:readonly string[],rendered?:readonly number[]):GroupState[] {
  const shown=rendered&&new Set(rendered);
  return (groups??[]).map(group=>{
    const live=liveIndices(group,trackIds);
    if(live.length<2)return 'tooFewTracks';
    if(!contiguous(live))return 'notContiguous';
    if(shown&&live.filter(index=>shown.has(index)).length<2)return 'notShown';
    return 'drawn';
  });
}
/** The groups that are drawn, with their rendered member tracks. */
export function drawnGroups(groups:readonly StaffGroup[]|undefined,trackIds:readonly string[],rendered:readonly number[]):ResolvedGroup[] {
  const shown=new Set(rendered),states=groupStates(groups,trackIds,rendered),drawn:ResolvedGroup[]=[];
  (groups??[]).forEach((group,index)=>{
    if(states[index]==='drawn')drawn.push({index,kind:group.kind,tracks:liveIndices(group,trackIds).filter(track=>shown.has(track))});
  });
  return drawn;
}

export type GroupingProblem='tooFew'|'notContiguous'|'alreadyGrouped'|'tooMany';
/** Why `members` cannot become a new group, or null when they can. */
// A chosen id that names no current track counts as missing, so it reports 'tooFew'; the UI only ever passes current tracks.
export function groupingProblem(engraving:EngravingOverrides,trackIds:readonly string[],members:readonly string[]):GroupingProblem|null {
  const distinct=[...new Set(members)],live=distinct.map(id=>trackIds.indexOf(id)).filter(index=>index>=0).sort((a,b)=>a-b);
  if(live.length<2||live.length!==distinct.length)return 'tooFew';
  if(!contiguous(live))return 'notContiguous';
  const taken=new Set((engraving.staffGroups??[]).flatMap(group=>group.trackIds));
  if(distinct.some(id=>taken.has(id)))return 'alreadyGrouped';
  if((engraving.staffGroups?.length??0)>=MAX_STAFF_GROUPS||live.length>MAX_GROUP_TRACKS)return 'tooMany';
  return null;
}
/** `engraving` with a new group of `members`, written in current track order. Throws when `groupingProblem` names a problem. */
export function addStaffGroup(engraving:EngravingOverrides,trackIds:readonly string[],members:readonly string[],kind:StaffGroupKind):EngravingOverrides {
  if(!GROUP_KINDS.includes(kind))throw new Error('A staff group is a bracket or a brace.');
  const problem=groupingProblem(engraving,trackIds,members);
  if(problem)throw new Error(`These tracks cannot be grouped: ${problem}.`);
  const ordered=[...new Set(members)].sort((a,b)=>trackIds.indexOf(a)-trackIds.indexOf(b));
  return withStaffGroups(engraving,[...(engraving.staffGroups??[]),{trackIds:ordered,kind}]);
}
const groupAt=(engraving:EngravingOverrides,index:number)=>{
  const group=engraving.staffGroups?.[index];
  if(!group)throw new Error('No such staff group.');
  return group;
};
export function setStaffGroupKind(engraving:EngravingOverrides,index:number,kind:StaffGroupKind):EngravingOverrides {
  if(!GROUP_KINDS.includes(kind))throw new Error('A staff group is a bracket or a brace.');
  if(groupAt(engraving,index).kind===kind)return engraving;
  return withStaffGroups(engraving,engraving.staffGroups!.map((group,at)=>at===index?{...group,kind}:group));
}
export function removeStaffGroup(engraving:EngravingOverrides,index:number):EngravingOverrides {
  groupAt(engraving,index);
  return withStaffGroups(engraving,engraving.staffGroups!.filter((_,at)=>at!==index));
}
export const removeAllStaffGroups=(engraving:EngravingOverrides):EngravingOverrides=>engraving.staffGroups?.length?withStaffGroups(engraving,[]):engraving;

/** The gap factor of `trackId`'s staff (1 when none is set). */
export const staffGapOf=(engraving:Pick<EngravingOverrides,'staffGaps'>,trackId:string):number=>engraving.staffGaps?.find(entry=>entry.trackId===trackId)?.scale??1;
export function setStaffGap(engraving:EngravingOverrides,trackId:string,scale:number):EngravingOverrides {
  if(!validStaffTrackId(trackId))throw new Error('Staff gaps name tracks by nonempty identities of at most 65536 bytes.');
  if(!scaleOk(scale))throw new Error('Staff gaps must be between 25% and 400% of the standard gap.');
  if(near(scale,1))return resetStaffGap(engraving,trackId);
  const current=engraving.staffGaps??[],at=current.findIndex(entry=>entry.trackId===trackId);
  if(at>=0){
    if(near(current[at].scale,scale))return engraving;
    return withStaffGaps(engraving,current.map((entry,index)=>index===at?{trackId,scale}:entry));
  }
  if(current.length>=MAX_STAFF_GAPS)throw new Error('At most 256 staff gaps can be set.');
  return withStaffGaps(engraving,[...current,{trackId,scale}]);
}
export function resetStaffGap(engraving:EngravingOverrides,trackId:string):EngravingOverrides {
  if(!engraving.staffGaps?.some(entry=>entry.trackId===trackId))return engraving;
  return withStaffGaps(engraving,engraving.staffGaps.filter(entry=>entry.trackId!==trackId));
}
export const resetAllStaffGaps=(engraving:EngravingOverrides):EngravingOverrides=>engraving.staffGaps?.length?withStaffGaps(engraving,[]):engraving;
export const hasStaffGaps=(engraving:Pick<EngravingOverrides,'staffGaps'>)=>!!engraving.staffGaps?.length;

/** Document track index to gap factor. Entries naming a track that no longer exists lie dormant and are skipped; the first entry for a track wins. */
export function resolveStaffGaps(gaps:readonly StaffGap[]|undefined,trackIds:readonly string[]):Map<number,number> {
  const resolved=new Map<number,number>();
  for(const {trackId,scale} of gaps??[]){const index=trackIds.indexOf(trackId);if(index>=0&&!resolved.has(index))resolved.set(index,scale);}
  return resolved;
}

/** `engraving` after a duplicated track: the copy joins its source's group right after the source (unless the group is full) and takes the source's gap (unless 256 are set). */
export function copyTrackStaffLayout(engraving:EngravingOverrides,source:string,copy:string):EngravingOverrides {
  let next=engraving;
  const groups=engraving.staffGroups,joins=(group:StaffGroup)=>group.trackIds.includes(source)&&!group.trackIds.includes(copy)&&group.trackIds.length<MAX_GROUP_TRACKS;
  if(groups?.some(joins))
    next=withStaffGroups(next,groups.map(group=>{
      if(!joins(group))return group;
      const ids=[...group.trackIds];ids.splice(ids.indexOf(source)+1,0,copy);return {...group,trackIds:ids};
    }));
  const gaps=engraving.staffGaps,gap=gaps?.find(entry=>entry.trackId===source);
  if(gaps&&gap&&!gaps.some(entry=>entry.trackId===copy)&&gaps.length<MAX_STAFF_GAPS)next=withStaffGaps(next,[...gaps,{trackId:copy,scale:gap.scale}]);
  return next;
}

/** The track-name choices GP8 calls "long name first, short after". */
export const LONG_FIRST_SHORT_AFTER={singleNames:'allSystems',multiNames:'allSystems',firstNames:'full',otherNames:'short'} as const;
export const isLongFirstShortAfter=(engraving:EngravingOverrides):boolean=>(Object.keys(LONG_FIRST_SHORT_AFTER) as Array<keyof typeof LONG_FIRST_SHORT_AFTER>).every(key=>engraving.stylesheet[key]===LONG_FIRST_SHORT_AFTER[key]);
export function withLongFirstShortAfter(engraving:EngravingOverrides):EngravingOverrides {
  return isLongFirstShortAfter(engraving)?engraving:{...structuredClone(engraving),stylesheet:{...structuredClone(engraving.stylesheet),...LONG_FIRST_SHORT_AFTER}};
}
