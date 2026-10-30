import type { model } from '@coderline/alphatab';
import { getPartialCapo, setPartialCapo, stringCapo, validatePartialCapo, type PartialCapo } from '../editor/partial-capo';

/**
 * A GP staff keeps its partial capo as two properties: `PartialCapoFret`, and `PartialCapoStringFlags`, one 0 or 1
 * per string in the order of the staff's `Pitches`, lowest string first, which is the order notes number strings in.
 * alphaTab reads neither and always writes an empty one, so both are handled here.
 */
const fretProperty='PartialCapoFret',flagsProperty='PartialCapoStringFlags';
function orderedTracks(doc:Document):(Element|undefined)[] {
  const tracks=new Map([...doc.querySelectorAll('GPIF > Tracks > Track')].map(track=>[track.getAttribute('id'),track]));
  return (doc.querySelector('GPIF > MasterTrack > Tracks')?.textContent??'').trim().split(/\s+/).filter(Boolean).map(id=>tracks.get(id));
}
const property=(staff:Element,name:string)=>[...staff.querySelectorAll(':scope > Properties > Property')].find(item=>item.getAttribute('name')===name);

/** Reads the partial capo of every staff. A malformed one is skipped with a warning and never refuses the file. */
export function readGpifPartialCapo(score:model.Score,doc:Document):void {
  orderedTracks(doc).forEach((node,index)=>{
    const track=score.tracks[index];if(!node||!track)return;
    const staves=[...node.querySelectorAll(':scope > Staves > Staff')];
    track.staves.forEach((staff,staffIndex)=>{
      const element=staves[staffIndex];if(!element)return;
      const fretText=property(element,fretProperty)?.querySelector(':scope > Fret')?.textContent?.trim(),flags=property(element,flagsProperty)?.querySelector(':scope > Bitset')?.textContent?.trim();
      if(!fretText||!flags||!flags.includes('1'))return;
      try{
        const value:PartialCapo={fret:/^\d+$/.test(fretText)?Number(fretText):NaN,strings:[...flags].flatMap((flag,at)=>flag==='1'?[at+1]:[])};
        if(!/^[01]+$/.test(flags)||flags.length!==staff.tuning.length)throw new Error('The string flags do not match the staff.');
        if(value.fret===0)return;
        validatePartialCapo(value,staff.tuning.length);
        setPartialCapo(staff,value);
        // alphaTab fixed these trill pitches while the staff still had only its whole-neck capo; their fret offset is what the file holds.
        for(const bar of staff.bars)for(const voice of bar.voices)for(const beat of voice.beats)for(const note of beat.notes){
          if(note.trillValue>=0&&note.string>0)note.trillValue+=stringCapo(staff,note.string)-staff.capo;
        }
        // alphaTab ranked each beat's notes by pitch while loading, before the partial capo was known.
        for(const bar of staff.bars)for(const voice of bar.voices)for(const beat of voice.beats){
          const visible=beat.notes.filter(note=>note.isVisible),lookup=(beat as unknown as {noteValueLookup:Map<number,model.Note>}).noteValueLookup;
          if(visible.length){beat.minNote=visible.reduce((low,note)=>note.realValue<low.realValue?note:low);beat.maxNote=visible.reduce((high,note)=>note.realValue>high.realValue?note:high);}
          lookup.clear();for(const note of beat.notes)lookup.set(note.realValue,note);
        }
      }catch(cause){setPartialCapo(staff,null);console.warn(`Skipped a malformed partial capo in the GP file: ${cause instanceof Error?cause.message:String(cause)}`);}
    });
  });
}

/** Whether any staff of the score has a partial capo for the writer to add. */
export const hasPartialCapo=(score:model.Score)=>score.tracks.some(track=>track.staves.some(staff=>!!getPartialCapo(staff)));

/** Fills in the two properties alphaTab writes empty. */
export function writeGpifPartialCapo(score:model.Score,doc:Document):void {
  orderedTracks(doc).forEach((node,index)=>{
    const track=score.tracks[index];if(!node||!track)return;
    const staves=[...node.querySelectorAll(':scope > Staves > Staff')];
    track.staves.forEach((staff,staffIndex)=>{
      const value=getPartialCapo(staff),element=staves[staffIndex];if(!value||!element)return;
      const fret=property(element,fretProperty)?.querySelector(':scope > Fret'),flags=property(element,flagsProperty)?.querySelector(':scope > Bitset');
      if(!fret||!flags)return;
      fret.textContent=String(value.fret);flags.textContent=Array.from({length:staff.tuning.length},(_,at)=>value.strings.includes(at+1)?'1':'0').join('');
    });
  });
}
