import { exporter,model,Settings } from '@coderline/alphatab';
import { unzipSync } from 'fflate';
import { scoreFromJson } from '../model-clone';
import { projectGpifTracks } from './xml';

const notesOf=(track:model.Track)=>track.staves.flatMap(staff=>staff.bars.flatMap(bar=>bar.voices.flatMap(voice=>voice.beats.flatMap(beat=>beat.notes))));
const articulations=(track:Element)=>[...track.querySelectorAll(':scope > InstrumentSet > Elements > Element > Articulations > Articulation')];

/** GPIF notes reference the flattened native table; the model also accepts standard IDs. */
export function writePercussionReferences(score:model.Score,doc:Document,settings:Settings):Map<number,number> {
  const tracks=[...doc.querySelectorAll('GPIF > Tracks > Track')],references=new Map<number,number>();
  let defaults:Element[]|undefined;
  for(const [index,track]of score.tracks.entries()){
    if(!track.isPercussion)continue;
    const notes=notesOf(track),customCount=track.percussionArticulations.length;
    if(customCount&&!notes.some(note=>note.percussionArticulation>=customCount))continue;
    let standardTrack=tracks[index];
    if(customCount){
      if(!defaults){
        const copy=scoreFromJson(model.JsonConverter.scoreToJson(score),settings);
        for(const candidate of copy.tracks)candidate.percussionArticulations=[];
        const bytes=unzipSync(new exporter.Gp7Exporter().export(copy,settings))['Content/score.gpif'];
        const xml=new TextDecoder().decode(bytes),standardDoc=new DOMParser().parseFromString(projectGpifTracks(xml)?.xml??xml,'application/xml');
        defaults=[...standardDoc.querySelectorAll('GPIF > Tracks > Track')];
      }
      standardTrack=defaults[index];
    }
    const table=articulations(standardTrack),indices=new Map<number,number>();
    table.forEach((articulation,i)=>{
      for(const id of (articulation.querySelector('InputMidiNumbers')?.textContent??'').trim().split(/\s+/).map(Number))indices.set(id,customCount+i);
    });
    if(customCount){
      const elements=tracks[index].querySelector(':scope > InstrumentSet > Elements')!;
      for(const element of standardTrack.querySelectorAll(':scope > InstrumentSet > Elements > Element'))elements.append(doc.importNode(element,true));
    }
    for(const note of notes){
      const id=note.percussionArticulation;if(id<customCount||id<0)continue;
      const nativeIndex=indices.get(id);if(nativeIndex===undefined)throw new Error('Unsupported percussion articulation for GP export.');
      references.set(note.id,nativeIndex);
    }
  }
  return references;
}
