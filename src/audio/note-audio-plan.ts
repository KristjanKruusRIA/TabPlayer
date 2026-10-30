import type { model } from '@coderline/alphatab';
import type { PlanNote } from './types';
import { getNoteAudio, hasPitchEvents } from '../editor/note-audio';

/** The raw attack the plan keeps for a note: its times and velocity feed the plan's MIDI events, so they are changed together. */
export interface RawAttack {track:number;trackAttack:number;start:number;end:number;velocity:number}
/** An attack of a note that has audio settings. */
export interface AudibleAttack {note:PlanNote;raw:RawAttack;source:model.Note}
/** What a note's settings did to one attack, for a MIDI export that generates its own attacks: `attack` counts a track's attacks from zero. */
export interface AudioAdjustment {track:number;attack:number;shift:number;length:number;velocity:number}

let sink:AudioAdjustment[]|undefined;
/** Runs a plan build and returns what the notes' audio settings did to each attack. */
export function collectNoteAudio<T>(run:()=>T):{result:T;adjustments:AudioAdjustment[]} {
  const previous=sink,adjustments:AudioAdjustment[]=[];sink=adjustments;
  try{return {result:run(),adjustments};}finally{sink=previous;}
}

/** Notes the attack to be changed, if its note has audio settings. */
export function collectAudible(into:AudibleAttack[],source:model.Note,note:PlanNote,raw:RawAttack):void {
  if(getNoteAudio(source))into.push({note,raw,source});
}

const groupOf=(note:PlanNote)=>note.id.slice(0,note.id.lastIndexOf('/'));
const laneOf=(note:PlanNote)=>`${note.source.target.track}/${note.source.target.staff}/${note.source.target.voice}`;
interface Room {first:number;last:number;lastLength:number;down:number;up:number}

/**
 * How far each note of a voice may move without passing its neighbours. A note's attacks (a trill's, a tremolo's) move together, so a
 * note is one group from its first attack to its last. A group may move at most half the gap, less a tick, toward the nearest group
 * before or after it, so two groups that both move toward each other still keep their order. No group starts before zero, and the last
 * group of a voice keeps its last attack at least half its own length before the end of the plan (`ceiling`), so it is still heard.
 */
function rooms(notes:PlanNote[],lanes:Set<string>,ceiling:number):Map<string,Room> {
  const result=new Map<string,Room>(),byLane=new Map<string,Room[]>();
  for(const note of notes) {
    const lane=laneOf(note);if(!lanes.has(lane))continue;
    const key=`${lane}|${groupOf(note)}`,room=result.get(key);
    const length=note.endTick-note.startTick;
    if(room){room.first=Math.min(room.first,note.startTick);if(note.startTick>room.last){room.last=note.startTick;room.lastLength=length;}else if(note.startTick===room.last)room.lastLength=Math.max(room.lastLength,length);}
    else{const created={first:note.startTick,last:note.startTick,lastLength:length,down:0,up:0};result.set(key,created);const list=byLane.get(lane)??[];list.push(created);byLane.set(lane,list);}
  }
  for(const list of byLane.values()) {
    list.sort((a,b)=>a.first-b.first);
    let reach=-Infinity;
    for(let start=0,end=0;start<list.length;start=end) {
      while(end<list.length&&list[end].first===list[start].first)end++;
      const next=end<list.length?list[end].first:Infinity;
      for(let index=start;index<end;index++) {
        const room=list[index];
        room.down=reach===-Infinity?room.first:Math.min(room.first,Math.max(0,Math.floor((room.first-reach-1)/2)));
        room.up=next===Infinity?Math.max(0,ceiling-room.last-Math.ceil(room.lastLength/2)):Math.max(0,Math.floor((next-room.last-1)/2));
      }
      for(let index=start;index<end;index++)reach=Math.max(reach,list[index].last);
    }
  }
  return result;
}

/**
 * Applies the notes' audio settings to their attacks, in place, after every other change to the plan. The start moves by the offset,
 * held inside the room the voice leaves it; the length is scaled and kept inside the plan (`ceiling`) and above one tick; the velocity
 * is added and kept from 1 to 127. A note with bend, whammy, slide or vibrato events keeps its start and length, because those
 * events are not attached to the note. A tied note's later notes make no attack of their own, so the whole tie moves and scales.
 */
export function applyNoteAudio(attacks:AudibleAttack[],notes:PlanNote[],ceiling:number):void {
  const space=rooms(notes,new Set(attacks.map(attack=>laneOf(attack.note))),ceiling);
  for(const {note,raw,source} of attacks) {
    const audio=getNoteAudio(source)!,room=space.get(`${laneOf(note)}|${groupOf(note)}`)!,fixed=hasPitchEvents(source);
    const shift=fixed?0:Math.max(-room.down,Math.min(room.up,audio.offset))||0;
    const from=note.startTick,length=note.endTick-from,start=from+shift;
    const scaled=fixed||audio.length===100?length:Math.max(1,Math.round(length*audio.length/100));
    const end=Math.max(start+1,Math.min(start+scaled,ceiling));
    const velocity=audio.velocity?Math.max(1,Math.min(127,Math.round(note.velocity+audio.velocity))):note.velocity;
    if(shift||end-start!==length||velocity!==note.velocity) {
      // The pitch curve keeps its shape over the new length.
      const factor=(end-start)/length;let previous=-Infinity;
      note.pitch=note.pitch.map(point=>({tick:Math.min(end,start+(point.tick-from)*factor),semitones:point.semitones})).filter(point=>point.tick>previous&&(previous=point.tick,true));
      note.startTick=raw.start=start;note.endTick=raw.end=end;note.velocity=raw.velocity=velocity;
    }
    sink?.push({track:raw.track,attack:raw.trackAttack,shift,length:end-start,velocity});
  }
}
