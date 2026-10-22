import type { BeatTarget } from '../project';

export type GesturePatch = {
  tap?:boolean; slap?:boolean; pop?:boolean; deadSlapped?:boolean;
  golpe?:number; rasgueado?:number; fade?:number; vibrato?:number;
  slashed?:boolean; showTimer?:boolean;
  barre?:{fret:number;shape:number}|null;
  stem?:'auto'|'inverted'|'up'|'down';
  beamingMode?:number; wahPedal?:number;
};
export type GestureCommand =
  | {type:'setBeatGestures';target:BeatTarget;patch:GesturePatch}
  | {type:'setOttava';from:BeatTarget;to:BeatTarget;ottava:number}
  | {type:'setCrescendo';from:BeatTarget;to:BeatTarget;crescendo:number;targetDynamics:number|null}
  | {type:'setFermata';target:BeatTarget;fermata:{type:number;length:number}|null};
export type BarGestureCommand =
  | {type:'setBarGestures';track:number;staff:number;bar:number;clefOttava:number}
  | {type:'setMasterBarGestures';bar:number;commonTime:boolean;doubleBar:boolean;tripletFeel:number;beaming:{unit:number;groups:number[]}|null}
  | {type:'setSimile';track:number;staff:number;bar:number;kind:'none'|'single'|'double'};
