import { model,type Settings } from '@coderline/alphatab';
import { scoreFromJson } from '../model-clone';
import { readMusicXmlSource } from './musicxml-tempo-offsets';

// MusicXML writes a notation + TAB guitar as two staves, the second marked
// <staff-type>alternate</staff-type>: the same music, not played. alphaTab 1.8.4
// ignores that marker and imports two sounding staves. When the TAB staff is an
// exact copy of the notation staff, fold it back into alphaTab's own form: one
// stringed staff shown as both. Any difference keeps the stock two-staff import.
type Json=Record<string,unknown>;
const children=(node:Element,name?:string)=>[...node.children].filter(child=>!name||child.localName===name);

// Part indexes whose second (and last) staff is marked alternate.
function alternateParts(xml:string):Set<number> {
  const doc=new DOMParser().parseFromString(xml,'application/xml'),root=doc.documentElement,result=new Set<number>();
  if(doc.querySelector('parsererror')||root.localName!=='score-partwise')return result;
  children(root,'part').forEach((part,index)=>{
    const attributes=children(part,'measure').flatMap(measure=>children(measure,'attributes'));
    const staves=attributes.flatMap(item=>children(item,'staves')).map(node=>node.textContent?.trim());
    const details=attributes.flatMap(item=>children(item,'staff-details'));
    const alternate=(number:string)=>details.some(node=>(node.getAttribute('number')??'1')===number&&children(node,'staff-type').some(type=>type.textContent?.trim()==='alternate'));
    if(staves.length&&staves.every(value=>value==='2')&&alternate('2')&&!alternate('1'))result.add(index);
  });
  return result;
}

const same=(left:Json,right:Json,ignored:Set<string>)=>{
  for(const key of new Set([...Object.keys(left),...Object.keys(right)]))if(!ignored.has(key)&&JSON.stringify(left[key]??null)!==JSON.stringify(right[key]??null))return false;
  return true;
};
const ignoredNote=new Set(['id','string','fret','octave','tone','istiedestination','tiedestinationnoteid','tieoriginnoteid','accidentalmode']);
// alphaTab's initial instrument automation sits on the notation copy; the TAB copy must carry none.
const ignoredBeat=new Set(['id','notes','automations']);
const ignoredBar=new Set(['id','voices','clef','clefottava','keysignature','keysignaturetype','displayscale','displaywidth']);
const filled=(bar:model.Bar)=>bar.voices.filter(voice=>!voice.isEmpty);

// Pairs every staff-1 note with its staff-2 copy, or null when the staves differ.
function pairs(track:model.Track,json:Json):[Json,Json][]|null {
  const [notation,tab]=track.staves;
  if(track.staves.length!==2||notation.stringTuning.tunings.length||!tab.stringTuning.tunings.length||notation.bars.length!==tab.bars.length)return null;
  const [notationJson,tabJson]=json.staves as Json[],result:[Json,Json][]=[];
  for(const [index,bar] of notation.bars.entries()){
    const other=tab.bars[index],barJson=(notationJson.bars as Json[])[index],otherJson=(tabJson.bars as Json[])[index];
    if(!same(barJson,otherJson,ignoredBar))return null;
    const left=filled(bar),right=filled(other);if(left.length!==right.length)return null;
    for(const [at,voice] of left.entries()){
      const copy=right[at];if(voice.beats.length!==copy.beats.length)return null;
      const voiceJson=(barJson.voices as Json[])[voice.index],copyJson=(otherJson.voices as Json[])[copy.index];
      for(const [position,beat] of voice.beats.entries()){
        const twin=copy.beats[position],beatJson=(voiceJson.beats as Json[])[beat.index],twinJson=(copyJson.beats as Json[])[twin.index];
        if(!same(beatJson,twinJson,ignoredBeat)||twin.automations.length||beat.displayStart!==twin.displayStart||beat.notes.length!==twin.notes.length)return null;
        const notes=[...beat.notes].sort((a,b)=>a.realValue-b.realValue),copies=[...twin.notes].sort((a,b)=>a.realValue-b.realValue);
        for(const [n,note] of notes.entries()){
          const partner=copies[n],noteJson=(beatJson.notes as Json[])[note.index],partnerJson=(twinJson.notes as Json[])[partner.index];
          if(!partner.isStringed||partner.realValue!==note.realValue||partner.isTieDestination!==note.isTieDestination||!same(noteJson,partnerJson,ignoredNote))return null;
          result.push([noteJson,partnerJson]);
        }
      }
    }
  }
  return result;
}

export function applyMusicXmlAlternateStaves(score:model.Score,bytes:Uint8Array,settings:Settings):model.Score {
  // Cheap structural gate before any source parse or serialization.
  if(!score.tracks.some(track=>track.staves.length===2&&!track.staves[0].stringTuning.tunings.length&&track.staves[1].stringTuning.tunings.length>0))return score;
  try {
    const source=readMusicXmlSource(bytes,settings);
    if(!source||!source.xml.includes('alternate'))return score;
    const parts=alternateParts(source.xml);if(!parts.size||parts.size>score.tracks.length)return score;
    const value:unknown=model.JsonConverter.scoreToJson(score),json=(typeof value==='string'?JSON.parse(value):value) as Json,tracks=json.tracks as Json[];
    let folded=false;
    for(const index of parts){
      const track=score.tracks[index],trackJson=tracks[index];if(!track)continue;
      const matched=pairs(track,trackJson);if(!matched)continue;
      const [notation,tab]=trackJson.staves as Json[];
      for(const [note,partner] of matched){note.string=partner.string;note.fret=partner.fret;}
      Object.assign(notation,{stringtuning:tab.stringtuning,capo:tab.capo,showtablature:true,showstandardnotation:true});
      trackJson.staves=[notation];folded=true;
    }
    return folded?scoreFromJson(JSON.stringify(json),settings):score;
  } catch {
    return score; // unreadable sources keep the stock import
  }
}
