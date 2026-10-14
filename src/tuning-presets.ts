import { parseTuning } from './tuning';

export interface TuningPreset { id:string;name:string;instrument:'guitar'|'bass';strings:number;tuning:readonly number[] }
const preset=(instrument:TuningPreset['instrument'],strings:number,id:string,name:string,notes:string):TuningPreset=>({id:`${instrument}-${strings}-${id}`,name,instrument,strings,tuning:parseTuning(notes)});
export const tuningPresets:readonly TuningPreset[]=[
  preset('guitar',6,'standard-e','Standard E','E4 B3 G3 D3 A2 E2'),
  preset('guitar',6,'half-step-down','Half step down (E♭)','D#4 A#3 F#3 C#3 G#2 D#2'),
  preset('guitar',6,'d-standard','D standard','D4 A3 F3 C3 G2 D2'),
  preset('guitar',6,'drop-d','Drop D','E4 B3 G3 D3 A2 D2'),
  preset('guitar',6,'drop-csharp','Drop C#','D#4 A#3 F#3 C#3 G#2 C#2'),
  preset('guitar',6,'drop-c','Drop C','D4 A3 F3 C3 G2 C2'),
  preset('guitar',6,'dadgad','DADGAD','D4 A3 G3 D3 A2 D2'),
  preset('guitar',6,'open-d','Open D','D4 A3 F#3 D3 A2 D2'),
  preset('guitar',6,'open-g','Open G','D4 B3 G3 D3 G2 D2'),
  preset('guitar',7,'standard-b','Standard B','E4 B3 G3 D3 A2 E2 B1'),
  preset('guitar',7,'drop-a','Drop A','E4 B3 G3 D3 A2 E2 A1'),
  preset('guitar',7,'a-standard','A standard','D4 A3 F3 C3 G2 D2 A1'),
  preset('guitar',7,'drop-g','Drop G','D4 A3 F3 C3 G2 D2 G1'),
  preset('guitar',8,'standard-fsharp','Standard F#','E4 B3 G3 D3 A2 E2 B1 F#1'),
  preset('guitar',8,'drop-e','Drop E','E4 B3 G3 D3 A2 E2 B1 E1'),
  preset('guitar',8,'e-standard','E standard','D4 A3 F3 C3 G2 D2 A1 E1'),
  preset('guitar',9,'standard-csharp','Standard C#','E4 B3 G3 D3 A2 E2 B1 F#1 C#1'),
  preset('guitar',9,'drop-b','Drop B','E4 B3 G3 D3 A2 E2 B1 F#1 B0'),
  preset('bass',4,'standard-e','Standard E','G2 D2 A1 E1'),
  preset('bass',4,'drop-d','Drop D','G2 D2 A1 D1'),
  preset('bass',4,'d-standard','D standard','F2 C2 G1 D1'),
  preset('bass',5,'standard-b','Standard B','G2 D2 A1 E1 B0'),
  preset('bass',5,'drop-a','Drop A','G2 D2 A1 E1 A0'),
  preset('bass',6,'standard-b','Standard B','C3 G2 D2 A1 E1 B0'),
  preset('bass',6,'drop-a','Drop A','C3 G2 D2 A1 E1 A0'),
];
export function findTuningPreset(notes:string):TuningPreset|undefined {
  try{const tuning=parseTuning(notes);return tuningPresets.find(p=>p.tuning.length===tuning.length&&p.tuning.every((pitch,index)=>pitch===tuning[index]));}catch{return undefined;}
}
