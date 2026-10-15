import type { model } from '@coderline/alphatab';

export type MeasureCommand =
  | {type:'insertMeasures';beforeBar:number;count:number}
  | {type:'removeMeasures';firstBar:number;lastBar:number};
export interface BarIndexMap {oldToNew:Array<number|null>;inserted:number[]}
export interface MeasureTransformPanelProps {
  score:model.Score;bar:number;busy:boolean;
  onEdit:(command:MeasureCommand)=>void;
}
