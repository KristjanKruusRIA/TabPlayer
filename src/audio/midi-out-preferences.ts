/** The MIDI output delay is the same for every track and score, so it is kept with the app, not in a project. */
const KEY='tabplayer.midiOutDelay';
export const MIDI_OUT_DELAY_MAX=500;
type Storage=Pick<globalThis.Storage,'getItem'|'setItem'>;
const local=():Storage|null=>{try{return globalThis.localStorage??null;}catch{return null;}};

export function readMidiOutDelay(storage:Storage|null=local()):number {
  try{
    const value=Number(storage?.getItem(KEY));
    return Number.isFinite(value)?Math.round(Math.min(MIDI_OUT_DELAY_MAX,Math.max(0,value))):0;
  }catch{return 0;}
}
export function saveMidiOutDelay(ms:number,storage:Storage|null=local()):void {
  try{storage?.setItem(KEY,String(ms));}catch{/* Not remembering the delay only costs setting it again. */}
}
