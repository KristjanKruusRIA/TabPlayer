import { model } from '@coderline/alphatab';
import type { EditCommand,SequenceStep } from '../edit-types';
import { describeSelection,previewEdit } from '../engine';
import { getMessage,getResolvedLanguage,type MessageKey } from '../i18n';
import { entryNotes,maxEntryFret } from '../instruments/entry';
import { MAX_SEQUENCE_COMMANDS } from '../parity-commands';
import type { BeatTarget,Project } from '../project';
import { formatPitch } from '../tuning';
import { droneString,fretExists,getBanjoDrone } from './banjo-drone';
import { autoDurationEdit,type EntryDuration,type InputPreferences } from './input-preferences';
import type { StringMapping } from './midi-capture-preferences';
import { oneEdit } from './notation-entry';
import { openStringKey } from './partial-capo';
import { advanceAfter,barHasRoomAfter,type EntryPlan,type EntryRefusal } from './score-entry';

export type { StringMapping } from './midi-capture-preferences';
/** One note of a captured chord, as the device sent it. */
export interface CapturedNote {key:number;velocity:number;channel:number}
export interface Placement {string:number;fret:number}
export interface CaptureRequest {
  project:Project;score:model.Score;target:BeatTarget;notes:readonly CapturedNote[];
  preferences:InputPreferences;entry:EntryDuration|null;
  /** The fret the fretting hand was last at, or null before the first chord. */
  hand:number|null;
  /** The player's channel-to-string mapping; absent or `off` places notes by the fingering rule alone, as before MIDI guitars. */
  mapping?:StringMapping;
}

/**
 * The string a MIDI channel (0 to 15) stands for on a track with `stringCount` strings, or null when the mapping is off, the
 * channel has no string on this track, or it is channel 10 (index 9), which MIDI keeps for drums. Strings are the track's own
 * numbers: string 1 is the last tuning entry, the bottom line of the tab (the lowest string of an ordinary guitar or bass; on a
 * banjo with a drone it is the short drone string).
 *
 * A MIDI guitar has six strings. `highestFirst` maps channel c to string count-c, so the top string is channel 0 on any
 * track. `lowestFirst` maps channel c to string c+1, shifted up by the strings a track has beyond six, so a 6-string
 * guitar's low string stays on the sixth string from the top (string 2 on a 7-string track, 3 on an 8-string one). Channels
 * past the six, or past the strings of a shorter track, are unmapped.
 */
export function channelString(channel:number,stringCount:number,mapping:StringMapping):number|null {
  if(mapping==='off'||!Number.isInteger(channel)||channel<0||channel>15||channel===9)return null;
  if(!Number.isInteger(stringCount)||stringCount<1)return null;
  if(mapping==='highestFirst')return channel<stringCount?stringCount-channel:null;
  const string=channel+1+Math.max(0,stringCount-6);
  return string<=stringCount?string:null;
}

/** The fret a pitch takes on a string, or null when the string cannot play it (below the open string or capo, past `maxEntryFret`, or a fret the banjo drone string lacks). */
function fretOn(staff:model.Staff,string:number,key:number):number|null {
  const plain=key-openStringKey(staff,string),fret=string===droneString&&plain>0?plain+getBanjoDrone(staff):plain;
  return fret>=0&&fret<=maxEntryFret&&fretExists(staff,string,fret)?fret:null;
}
export const NODE_LIMIT=200_000;
let lastNodes=0;
/** How many nodes the most recent `planChordFingering` search visited (the work done, which a test can bound without a clock). */
export const lastFingeringSearchNodes=()=>lastNodes;
/** One string for each pitch, if there is any way to do it (augmenting paths), so a chord that can be played is never refused for want of search. */
function anyAssignment(options:readonly (readonly Placement[])[]):Placement[]|null {
  const owner=new Map<number,number>();
  const chosen:Placement[]=[];
  const place=(note:number,seen:Set<number>):boolean=>{
    for(const option of options[note]){
      if(seen.has(option.string))continue;
      seen.add(option.string);
      const holder=owner.get(option.string);
      if(holder===undefined||place(holder,seen)){owner.set(option.string,note);chosen[note]=option;return true;}
    }
    return false;
  };
  for(let note=0;note<options.length;note++)if(!place(note,new Set()))return null;
  // The paths may have moved earlier notes to other strings; read the final strings back.
  const final:Placement[]=new Array(options.length);
  for(const [string,note] of owner)final[note]=options[note].find(option=>option.string===string)!;
  return final;
}
/**
 * Places a chord on a fretted staff: one string for each pitch, strings in `occupied` left alone, as near as possible to the
 * hand (to the lowest frets without one) with the smallest stretch, and with higher pitches on higher strings where it costs
 * nothing. A pitch pinned to a string goes there when that string can play it and anywhere otherwise. Null only when no
 * assignment exists. A feasible chord always gets a placement: the bounded search (at most 200,000 nodes, each costing a few
 * operations) improves on a first valid assignment and never replaces it with nothing.
 */
export function planChordFingering(staff:model.Staff,notes:readonly {key:number;string:number|null}[],occupied:ReadonlySet<number>,hand:number|null):Placement[]|null {
  lastNodes=0;
  const strings=staff.tuning.length;
  if(staff.isPercussion||!strings||!notes.length||notes.length>strings)return null;
  // Lowest pitch first, so that the string order check below reads naturally.
  const order=notes.map((note,index)=>({...note,index})).sort((a,b)=>a.key-b.key||a.index-b.index);
  const options=order.map(note=>{
    const all:Placement[]=[];
    for(let string=1;string<=strings;string++){
      if(occupied.has(string))continue;
      const fret=fretOn(staff,string,note.key);
      if(fret!==null)all.push({string,fret});
    }
    const pinned=note.string===null?[]:all.filter(option=>option.string===note.string);
    return pinned.length?pinned:all;
  });
  if(options.some(list=>!list.length))return null;
  const first=anyAssignment(options);
  if(!first)return null;
  // The cost of a partial or whole assignment, kept up to date as notes are added (no rescans): stretch between fretted notes,
  // distance from the hand, and a penalty for each pair with a higher pitch on a lower string.
  interface Running {low:number;high:number;sum:number;inversions:number}
  const price=(running:Running)=>8*(running.high>=running.low?running.high-running.low:0)+running.sum+6*running.inversions;
  const add=(running:Running,chosen:readonly Placement[],place:Placement):Running=>{
    let {low,high,sum,inversions}=running;
    if(place.fret>0){low=Math.min(low,place.fret);high=Math.max(high,place.fret);}
    sum+=place.fret===0?1:hand===null?place.fret:Math.abs(place.fret-hand);
    for(const earlier of chosen)if(earlier.string>place.string)inversions++;
    return {low,high,sum,inversions};
  };
  const empty:Running={low:Infinity,high:-Infinity,sum:0,inversions:0};
  const total=(chosen:readonly Placement[])=>{let running=empty;chosen.forEach((place,index)=>{running=add(running,chosen.slice(0,index),place);});return price(running);};
  let best:Placement[]|null=null,bestCost=Infinity,nodes=0;
  const search=(depth:number,chosen:Placement[],used:number,running:Running)=>{
    if(nodes++>NODE_LIMIT)return;
    const sofar=price(running);
    if(sofar>=bestCost)return;
    if(depth===options.length){best=[...chosen];bestCost=sofar;return;}
    for(const option of options[depth]){
      const bit=1<<(option.string-1);
      if(used&bit)continue;
      chosen.push(option);search(depth+1,chosen,used|bit,add(running,chosen.slice(0,-1),option));chosen.pop();
    }
  };
  search(0,[],0,empty);
  lastNodes=nodes;
  // The search visits strings in ascending order and keeps the first of equal costs, so ties go to the lower string; the first valid assignment is the answer only if the search found nothing at least as good.
  if(!best||bestCost>total(first))best=first;
  // Back to the order the notes were given in.
  const result:Placement[]=new Array(notes.length);
  (best as Placement[]).forEach((place,position)=>{result[order[position].index]=place;});
  return result;
}

const text=(key:MessageKey,params?:Record<string,string|number>)=>getMessage(getResolvedLanguage(),key,params);
const names=(keys:readonly number[])=>[...new Set(keys)].map(formatPitch).join(' ');

interface MappedNote {key:number;string:number|null}
/**
 * Pins each note of a chord to the string its channel stands for (a MIDI guitar sends each string on its own channel). With a
 * mapping on, a note is identified by its string and its pitch: the same pitch on two strings is two notes. Nothing is moved
 * or dropped quietly. The whole chord is refused, naming note and string, when a channel sent two different notes, when a
 * note's string already holds another note on the beat, or when its string cannot play the pitch (below the open string or
 * capo, past the last fret, a fret the banjo drone lacks): such a note is never re-fingered. Only a note on a channel that has
 * no string here (or channel 10) falls back to the fingering rule, with a notice, and is counted in `moved`; a copy of a pitch
 * on such a channel is reported and counted in `skipped`.
 */
function pinChord(staff:model.Staff,sent:readonly CapturedNote[],present:readonly {key:number;string:number}[],mapping:StringMapping):{notes:MappedNote[];notices:string[];moved:number;skipped:number}|EntryRefusal {
  const count=staff.tuning.length;
  const onString=(key:number,string:number)=>text('score_entry.capture_note_string',{note:formatPitch(key),string});
  const pairs=new Map<string,CapturedNote>();
  for(const note of sent)if(Number.isInteger(note.key)&&note.key>=0&&note.key<=127&&Number.isInteger(note.channel))pairs.set(`${note.channel}:${note.key}`,note);
  const label=names([...new Set([...pairs.values()].map(note=>note.key))].sort((a,b)=>a-b));
  // A channel carries one string, so two different notes on a mapped channel cannot both be that string's.
  const byChannel=new Map<number,number[]>();
  for(const {channel,key} of pairs.values())byChannel.set(channel,[...(byChannel.get(channel)??[]),key]);
  for(const [channel,keys] of byChannel){
    const string=channelString(channel,count,mapping);
    if(string!==null&&keys.length>1)return {refused:'channel_shared',name:text('score_entry.capture_notes_string',{notes:names(keys),string})};
  }
  const pinned:MappedNote[]=[],loose:CapturedNote[]=[];
  for(const note of pairs.values()){
    const string=channelString(note.channel,count,mapping);
    if(string===null){loose.push(note);continue;}
    const holder=present.find(held=>held.string===string);
    if(holder){
      if(holder.key===note.key)continue;
      return {refused:'string_taken',name:onString(note.key,string)};
    }
    if(fretOn(staff,string,note.key)===null)return {refused:'unreachable',name:onString(note.key,string)};
    pinned.push({key:note.key,string});
  }
  const seen=new Set<number>([...present.map(held=>held.key),...[...pairs.values()].filter(note=>channelString(note.channel,count,mapping)!==null).map(note=>note.key)]);
  const free:MappedNote[]=[],notices:string[]=[];
  let skipped=0;
  for(const note of loose){
    if(seen.has(note.key)){
      skipped++;
      notices.push(text('score_entry.capture_duplicate',{note:formatPitch(note.key),channel:note.channel+1}));
      continue;
    }
    if(!Array.from({length:count},(_,index)=>fretOn(staff,index+1,note.key)).some(fret=>fret!==null))return {refused:'unreachable',name:formatPitch(note.key)};
    seen.add(note.key);free.push({key:note.key,string:null});
    notices.push(text('score_entry.capture_channel_fallback',{note:formatPitch(note.key),channel:note.channel+1}));
  }
  if(!pinned.length&&!free.length)return {refused:'present',name:label};
  return {notes:[...pinned,...free],notices,moved:free.length,skipped};
}

/**
 * Plans writing a captured chord on the selected beat as one edit, the way the note-entry keyboard writes: the entry duration
 * first (auto-duration counts as on), each pitch not already on the beat, and the move to the next beat (which, at the last
 * beat of a bar with room, adds a beat). A pitch the beat has is skipped, never removed. A chord with a pitch the staff cannot
 * play is refused whole, naming the pitch; nothing is clamped. A percussion staff is refused.
 *
 * A sequence holds eight steps, and no pitch is ever given up for them: the pitches come first, then moving on to a new beat,
 * then the entry duration. When they do not all fit, the duration (or, with eight pitches, the added beat) is left out and the
 * notice says so.
 */
export function planMidiCapture(request:CaptureRequest):EntryPlan|EntryRefusal {
  const {project,score,target,preferences,entry,hand}=request;
  const {staff,beat}=describeSelection(score,target);
  const keys=[...new Set(request.notes.map(note=>note.key))].filter(key=>Number.isInteger(key)&&key>=0&&key<=127).sort((a,b)=>a-b);
  const label=names(keys);
  if(!beat||!keys.length)return {refused:'cannot_enter',name:label};
  if(staff.isPercussion)return {refused:'percussion',name:label};
  const present=entryNotes(staff,beat);
  const fretted=staff.tuning.length>0;
  const mapping=request.mapping??'off';
  const notices:string[]=[];
  let fresh:number[],pinnedNotes:MappedNote[],moved=0,skipped=0;
  if(fretted&&mapping!=='off'){
    const pinned=pinChord(staff,request.notes,present,mapping);
    if('refused' in pinned)return pinned;
    pinnedNotes=pinned.notes;fresh=pinned.notes.map(note=>note.key);notices.push(...pinned.notices);moved=pinned.moved;skipped=pinned.skipped;
    if(fresh.length>MAX_SEQUENCE_COMMANDS)return {refused:'refused',name:label};
  }else{
    fresh=keys.filter(key=>!present.some(note=>staff.tuning.length?note.key===key:note.written===key+staff.transpositionPitch));
    if(!fresh.length)return {refused:'present',name:label};
    // The device sends at most eight; a longer list is refused rather than trimmed.
    if(fresh.length>MAX_SEQUENCE_COMMANDS)return {refused:'refused',name:label};
    if(fretted){
      for(const key of fresh){
        if(!Array.from({length:staff.tuning.length},(_,index)=>fretOn(staff,index+1,key)).some(fret=>fret!==null))return {refused:'unreachable',name:formatPitch(key)};
      }
    }
    pinnedNotes=fresh.map(key=>({key,string:null}));
  }
  const placements=fretted?planChordFingering(staff,pinnedNotes,new Set(present.map(note=>note.string)),hand):null;
  if(fretted&&!placements)return {refused:'no_string',name:label};
  const noteSteps:SequenceStep[]=fretted
    ?placements!.map(({string,fret})=>({type:'setNote',target,string,fret}) as SequenceStep)
    :fresh.map(key=>({type:'addPitchedNote',target,pitch:key+staff.transpositionPitch}) as SequenceStep);
  const lead=autoDurationEdit({...preferences,autoDuration:true},target,beat,entry) as SequenceStep|null;
  let useLead=lead!==null,leadSkipped=false;
  if(lead&&noteSteps.length+1>MAX_SEQUENCE_COMMANDS){useLead=false;leadSkipped=true;notices.push(text('score_entry.capture_duration_skipped'));}
  let steps:SequenceStep[]=useLead?[lead!,...noteSteps]:noteSteps;
  let written=tryPreview(project,oneEdit(steps));
  if(!written&&useLead){
    useLead=false;leadSkipped=true;steps=noteSteps;written=tryPreview(project,oneEdit(steps));
    notices.push(text('score_entry.capture_duration_unfit'));
  }
  if(!written)return {refused:'refused',name:label};
  const own:EntryDuration|null=isPlain(beat)?{duration:beat.duration,dots:beat.dots}:entry;
  // The rhythm a new beat takes, and the entry duration later chords use: the player's own, even where this chord could not apply it.
  const rhythm:EntryDuration|null=useLead&&lead?.type==='setDuration'?{duration:lead.duration,dots:lead.dots}:own;
  const advanced=advanceAfter(project,written.score,target,steps,rhythm);
  const wantedBeat=rhythm!==null&&barHasRoomAfter(written.score,target);
  // The duration is never given up for the beat that follows; a beat that cannot be added is told, with its true reason.
  if(wantedBeat&&advanced.steps.length===steps.length)notices.push(text(steps.length>=MAX_SEQUENCE_COMMANDS?'score_entry.capture_no_beat':'score_entry.capture_no_beat_fit'));
  const sameTarget=advanced.next.track===target.track&&advanced.next.staff===target.staff&&advanced.next.bar===target.bar&&advanced.next.voice===target.voice&&advanced.next.beat===target.beat;
  if(sameTarget)notices.push(text('score_entry.capture_end'));
  const frets=placements?.filter(placement=>placement.fret>0).map(placement=>placement.fret)??[];
  const plan:EntryPlan={
    command:oneEdit(advanced.steps),follow:{},next:advanced.next,name:names(fresh),removes:false,
    notice:notices.length?notices.join(' '):null,entry:leadSkipped?entry:rhythm,
  };
  if(moved)plan.moved=moved;
  if(skipped)plan.skipped=skipped;
  if(sameTarget)plan.end=true;
  if(frets.length)plan.hand=Math.round(frets.reduce((sum,fret)=>sum+fret,0)/frets.length);
  return plan;
}

const tryPreview=(project:Project,command:EditCommand)=>{try{return previewEdit(project,command);}catch{return null;}};
const isPlain=(beat:model.Beat)=>beat.graceType===model.GraceType.None&&(beat.tupletNumerator<=0||beat.tupletNumerator===1&&beat.tupletDenominator===1);
