import type { EffectBlock } from '../edit-types';

/** How a block is drawn in the chain. */
export type BlockKind='pedal'|'amp'|'cabinet'|'mic'|'eq';
export interface BlockLook {kind:BlockKind;color:string;/** What the chain shows when the full name will not fit. */short:string}
// Colours group the blocks by what they do: dynamics, filters and pitch, drive, tone shaping, modulation, time and space.
const dynamics='#3D5C7A',filters='#7A5A3D',drive='#3F6B3A',tone='#55524C',modulation='#5A4670',space='#3D6A6A',cab='#4A3F33',amp='#8A6A35';
export const blockLook:Record<EffectBlock,BlockLook>={
  microphone:{kind:'mic',color:cab,short:'Mic'},gate:{kind:'pedal',color:dynamics,short:'Gate'},compressor:{kind:'pedal',color:dynamics,short:'Comp'},
  wah:{kind:'pedal',color:filters,short:'Wah'},octaver:{kind:'pedal',color:filters,short:'Oct'},pitch:{kind:'pedal',color:filters,short:'Pitch'},
  drive:{kind:'pedal',color:drive,short:'Drive'},amp:{kind:'amp',color:amp,short:'Amp'},cabinet:{kind:'cabinet',color:cab,short:'Cab'},
  eq:{kind:'eq',color:tone,short:'EQ'},graphicEq:{kind:'eq',color:tone,short:'GEQ'},
  vibrato:{kind:'pedal',color:modulation,short:'Vib'},phaser:{kind:'pedal',color:modulation,short:'Phase'},flanger:{kind:'pedal',color:modulation,short:'Flang'},chorus:{kind:'pedal',color:modulation,short:'Chor'},tremolo:{kind:'pedal',color:modulation,short:'Trem'},
  delay:{kind:'pedal',color:space,short:'Delay'},reverb:{kind:'pedal',color:space,short:'Verb'},
};
/** What identifies a block on one of the two pedalboards. */
export interface BlockRef {block:EffectBlock;second:boolean}
export const sameRef=(a:BlockRef,b:BlockRef)=>a.block===b.block&&a.second===b.second;
