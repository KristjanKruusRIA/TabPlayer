import kitData from '../audio/drum-kits.json';
import { standardPercussionCatalog } from './percussion-catalog';

/**
 * The drum kits the bundled sound bank carries. A drum track chooses one with the `drumKit` field of its sound, which holds the program
 * that selects the kit in the bank (alphaTab forces a percussion track's own program to 0, so the choice cannot live there); a track
 * that stored none plays Standard. `changes` are the drum keys that sound different from Standard, checked against the
 * rendered sound by the Rust tests, so the interface never offers a kit that sounds the same.
 */
export interface DrumKit {program:number;label:string;changes:readonly number[]}
export const drumKits:readonly DrumKit[]=kitData.kits;
/** The kit a track's stored `drumKit` plays; a track that stored none, or a number that names no kit, plays Standard. */
export function drumKitFor(program?:number):DrumKit {return drumKits.find(kit=>kit.program===program)??drumKits[0];}

/** Articulations that play the same sounding drum key, so they differ on the page only (rim shot and snare hit, ride edge and middle, every choke). */
export interface SharedSound {key:number;labels:readonly string[]}
export function sharedSounds():SharedSound[] {
  const byKey=new Map<number,string[]>();
  for(const entry of standardPercussionCatalog){const labels=byKey.get(entry.outputMidiNumber)??[];if(!labels.includes(entry.label))labels.push(entry.label);byKey.set(entry.outputMidiNumber,labels);}
  return [...byKey].filter(([,labels])=>labels.length>1).sort(([a],[b])=>a-b).map(([key,labels])=>({key,labels}));
}
/** The standard articulations a kit sounds differently from Standard. */
export function kitDifferences(kit:DrumKit):string[] {
  return kit.changes.flatMap(key=>{const labels=standardPercussionCatalog.filter(entry=>entry.outputMidiNumber===key).map(entry=>entry.label);return labels.length?[labels[0]]:[];});
}
