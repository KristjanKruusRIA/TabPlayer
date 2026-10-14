const names=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const pitches:Record<string,number>={C:0,D:2,E:4,F:5,G:7,A:9,B:11};
export const formatPitch=(pitch:number)=>`${names[pitch%12]}${Math.floor(pitch/12)-1}`;
export const formatTuning=(tuning:readonly number[])=>tuning.map(formatPitch).join(' ');
export function parseTuning(text:string):number[] {
  if(!text.trim())throw new Error('Enter tuning notes with octaves, for example E4 B3 G3 D3 A2 E2.');
  return text.trim().split(/[\s,]+/).map(note=>{
    const match=/^([A-G])([#b♯♭]?)(-?\d+)$/i.exec(note);
    if(!match)throw new Error(`Invalid tuning note “${note}”. Use a note name with an octave, such as E4, C#4 or Db4.`);
    const accidental=match[2],pitch=(Number(match[3])+1)*12+pitches[match[1].toUpperCase()]+(accidental==='#'||accidental==='♯'?1:accidental.toLowerCase()==='b'||accidental==='♭'?-1:0);
    if(!Number.isInteger(pitch)||pitch<0||pitch>127)throw new Error(`Tuning note “${note}” is outside the supported range C-1 to G9.`);
    return pitch;
  });
}
