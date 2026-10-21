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
    // alphaTab applies dynamics and open hairpins importer-wide, so the TAB copy's values
    // are artifacts only while staff 2 writes none of its own.
    const tabDynamics=children(part,'measure').flatMap(measure=>children(measure,'direction')).some(direction=>children(direction,'staff').some(node=>node.textContent?.trim()==='2')&&(direction.getElementsByTagName('dynamics').length>0||direction.getElementsByTagName('wedge').length>0));
    if(staves.length&&staves.every(value=>value==='2')&&alternate('2')&&!alternate('1')&&!tabDynamics)result.add(index);
  });
  return result;
}

const same=(left:Json,right:Json,ignored:Set<string>)=>{
  for(const key of new Set([...Object.keys(left),...Object.keys(right)]))if(!ignored.has(key)&&JSON.stringify(left[key]??null)!==JSON.stringify(right[key]??null))return false;
  return true;
};
// Note links point at each staff's own notes; they are compared through the pairing.
const linkKeys=['tieoriginnoteid','tiedestinationnoteid','sluroriginnoteid','slurdestinationnoteid','slideoriginnoteid','slidetargetnoteid'];
// A hammer-on needs a string, which only the TAB copy has: its flag is taken on the
// fold, and the replay links each origin again, which must reach the same partner.
const hammerKeys=['ishammerpullorigin','hammerpulloriginnoteid','hammerpulldestinationnoteid'];
// Dynamics are importer-global in alphaTab, so the TAB copy's value is an artifact
// (parts whose staff 2 writes dynamics or hairpins are never folded).
const ignoredNote=new Set(['id','string','fret','octave','tone','istiedestination','accidentalmode','dynamics',...linkKeys,...hammerKeys]);
// Stems and beams are staff layout; the notation staff's are kept. alphaTab's initial
// instrument automation sits on the notation copy; the TAB copy must carry none.
const ignoredBeat=new Set(['id','notes','automations','preferredbeamdirection','beamingmode','invertbeamdirection','dynamics','crescendo',...['text','chordid','lyrics']]);
// alphaTab attaches these to the next parsed beat only, usually the notation copy's.
// Kept when the TAB copy has none of its own; a TAB-only value refuses the fold.
const notationOnly=['text','chordid','lyrics'];
const unset=(value:unknown)=>value===undefined||value===null||value===0||value===''||(Array.isArray(value)&&!value.length);
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
        if(notationOnly.some(key=>!unset(twinJson[key])&&JSON.stringify(twinJson[key])!==JSON.stringify(beatJson[key]??null)))return null;
        const notes=[...beat.notes].sort((a,b)=>a.realValue-b.realValue),copies=[...twin.notes].sort((a,b)=>a.realValue-b.realValue);
        for(const [n,note] of notes.entries()){
          const partner=copies[n],noteJson=(beatJson.notes as Json[])[note.index],partnerJson=(twinJson.notes as Json[])[partner.index];
          if(!partner.isStringed||partner.realValue!==note.realValue||partner.isTieDestination!==note.isTieDestination||!same(noteJson,partnerJson,ignoredNote))return null;
          result.push([noteJson,partnerJson]);
        }
      }
    }
  }
  // Every link on a TAB note must point at the partner of its notation note's target.
  const partner=new Map(result.map(([note,copy])=>[copy.id,note.id]));
  for(const [note,copy] of result)for(const key of linkKeys){
    const target=copy[key],mapped=target===undefined||target===null?null:partner.get(target);
    if(mapped===undefined||mapped!==(note[key]??null))return null;
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
    // A part whose folded hammer-ons would relink elsewhere stays unfolded; the others fold.
    for(;;){
      const attempt=fold(score,parts,settings);if(!attempt)return score;
      if(!attempt.bad.size)return attempt.result;
      for(const index of attempt.bad)parts.delete(index);
    }
  } catch {
    return score; // unreadable sources keep the stock import
  }
}

function fold(score:model.Score,parts:Set<number>,settings:Settings):{result:model.Score;bad:Set<number>}|null {
  const value:unknown=model.JsonConverter.scoreToJson(score),json=(typeof value==='string'?JSON.parse(value):value) as Json,tracks=json.tracks as Json[];
  let folded=false;const links=new Map<unknown,unknown>();
  for(const index of parts){
    const track=score.tracks[index],trackJson=tracks[index];if(!track)continue;
    const matched=pairs(track,trackJson);if(!matched)continue;
    const [notation,tab]=trackJson.staves as Json[];
    const notationOf=new Map(matched.map(([note,partner])=>[partner.id,note.id]));
    for(const [note,partner] of matched){
      note.string=partner.string;note.fret=partner.fret;note.ishammerpullorigin=partner.ishammerpullorigin??false;
      delete note.hammerpulloriginnoteid;delete note.hammerpulldestinationnoteid;
      const target=partner.ishammerpullorigin?partner.hammerpulldestinationnoteid:undefined;
      links.set(note.id,target===undefined||target===null?null:notationOf.get(target)??'unpaired');
    }
    Object.assign(notation,{stringtuning:tab.stringtuning,capo:tab.capo,showtablature:true,showstandardnotation:true});
    trackJson.staves=[notation];folded=true;
  }
  if(!folded)return null;
  const result=scoreFromJson(JSON.stringify(json),settings),bad=new Set<number>();
  for(const track of result.tracks)for(const staff of track.staves)for(const bar of staff.bars)for(const voice of bar.voices)for(const beat of voice.beats)for(const note of beat.notes){
    if(links.has(note.id)&&(note.isHammerPullOrigin?note.hammerPullDestination?.id??null:null)!==links.get(note.id))bad.add(track.index);
  }
  return {result,bad};
}
