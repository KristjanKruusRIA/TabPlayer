import type { EffectBlock } from '../edit-types';

/** How a block is drawn: its own enamel, its own face, and what the chain shows when the full name will not fit. */
export type BlockKind='pedal'|'amp'|'cabinet'|'mic'|'eq'|'wah';
export interface BlockLook {kind:BlockKind;color:string;short:string;/** A small drawing on the pedal's name plate, as an SVG path in a 20 by 8 box. */glyph:string}
const wave='M0 4Q2.5 -1 5 4T10 4T15 4T20 4',spring='M0 4L2 1L4 7L6 1L8 7L10 1L12 7L14 1L16 7L18 4L20 4',bars='M2 1V7M7 2V6M12 0V8M17 3V5',saw='M0 7L5 1V7L10 1V7L15 1V7L20 1',
  arrows='M0 4H8M5 1L8 4L5 7M12 4H20M17 1L20 4L17 7',bell='M0 6C5 6 6 1 10 1S15 6 20 6',steps='M0 7H5V4H10V1H15V4H20',sweep='M0 7C6 7 8 1 20 1',ring='M2 4A3 3 0 1 0 8 4A3 3 0 1 0 2 4M12 4A3 3 0 1 0 18 4A3 3 0 1 0 12 4',updown='M5 7V1M2 4L5 1L8 4M15 1V7M12 4L15 7L18 4',
  gateGlyph='M0 7H6V1H14V7H20',dots='M3 4H4M8 4H9M13 4H14M18 4H19',mic='M10 0V8',slope='M0 7L20 1',two='M0 4H4M6 4H10M12 4H16',spin='M2 6C2 1 8 1 8 4S4 7 4 4M12 6C12 1 18 1 18 4S14 7 14 4';
export const blockLook:Record<EffectBlock,BlockLook>={
  microphone:{kind:'mic',color:'#6B5240',short:'Mic',glyph:mic},
  gate:{kind:'pedal',color:'#56656E',short:'Gate',glyph:gateGlyph},
  compressor:{kind:'pedal',color:'#3F6A96',short:'Comp',glyph:slope},
  wah:{kind:'wah',color:'#9A5530',short:'Wah',glyph:sweep},
  octaver:{kind:'pedal',color:'#7A52A6',short:'Oct',glyph:updown},
  pitch:{kind:'pedal',color:'#A64A7C',short:'Pitch',glyph:steps},
  drive:{kind:'pedal',color:'#3E7A3A',short:'Drive',glyph:saw},
  amp:{kind:'amp',color:'#8A6A35',short:'Amp',glyph:dots},
  cabinet:{kind:'cabinet',color:'#5A4836',short:'Cab',glyph:ring},
  eq:{kind:'eq',color:'#76735F',short:'EQ',glyph:bell},
  graphicEq:{kind:'eq',color:'#4F6667',short:'GEQ',glyph:bars},
  vibrato:{kind:'pedal',color:'#2F7D78',short:'Vib',glyph:wave},
  phaser:{kind:'pedal',color:'#C0702E',short:'Phase',glyph:spin},
  flanger:{kind:'pedal',color:'#2E7399',short:'Flang',glyph:two},
  chorus:{kind:'pedal',color:'#3568B8',short:'Chor',glyph:wave},
  tremolo:{kind:'pedal',color:'#9C3F3F',short:'Trem',glyph:bars},
  delay:{kind:'pedal',color:'#2C8580',short:'Delay',glyph:arrows},
  reverb:{kind:'pedal',color:'#614B7E',short:'Verb',glyph:spring},
};
/** Where a face puts its knobs, by how many it has, in the face's 100 by 120 units. The chain draws them as dots; the stage lays real knobs there. */
export const knobSpots:Record<number,readonly (readonly [number,number])[]>={
  0:[],1:[[50,42]],2:[[30,42],[70,42]],3:[[27,32],[73,32],[50,60]],4:[[30,32],[70,32],[30,60],[70,60]],5:[[24,30],[50,30],[76,30],[37,60],[63,60]],
};
/** What identifies a block on one of the two pedalboards. */
export interface BlockRef {block:EffectBlock;second:boolean}
export const sameRef=(a:BlockRef,b:BlockRef)=>a.block===b.block&&a.second===b.second;
/** What each amp model looks like: its plate, its covering and the ink on the plate. Choosing a model visibly changes the head. */
export interface AmpLook {plate:string;plateEdge:string;ink:string;tolex:string;piping:string;grille:string;name:string}
export const ampLooks:Record<string,AmpLook>={
  clean:{plate:'#D8CDB0',plateEdge:'#9C917A',ink:'#2A2418',tolex:'#17181A',piping:'#C9C2AE',grille:'#3B3A33',name:'Clean'},
  crunch:{plate:'#C29A5B',plateEdge:'#7F6232',ink:'#231A0E',tolex:'#1B1410',piping:'#D1AE6E',grille:'#3A2E20',name:'Crunch'},
  lead:{plate:'#B9803F',plateEdge:'#6E4720',ink:'#1E1208',tolex:'#2A1A10',piping:'#C99A5A',grille:'#41301F',name:'Lead'},
  metal:{plate:'#A6A9AE',plateEdge:'#5C5F65',ink:'#121315',tolex:'#0E0E10',piping:'#8E9096',grille:'#262629',name:'Metal'},
  bass:{plate:'#BFA46A',plateEdge:'#7A6638',ink:'#201A0C',tolex:'#1D1B16',piping:'#C9B07A',grille:'#34312A',name:'Bass'},
  bassDrive:{plate:'#B65C42',plateEdge:'#6E2F1F',ink:'#1F0C07',tolex:'#1A1210',piping:'#C98F6E',grille:'#3A2620',name:'Bass drive'},
};
