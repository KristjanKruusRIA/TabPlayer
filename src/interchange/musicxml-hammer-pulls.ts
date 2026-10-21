import { model,type Settings } from '@coderline/alphatab';
import { scoreFromJson } from '../model-clone';
import { readMusicXmlSource } from './musicxml-tempo-offsets';

// alphaTab 1.8.4 adds a MusicXML note to its beat before reading its <string>, so the
// beat's string lookup misses it and Note.finish clears every hammer-on and pull-off
// it read (a type="stop" one included). This flags the notes whose source starts one,
// then replays the score so alphaTab links each origin to its destination itself.
// Every link must be a span the source starts and stops; any doubt leaves the stock import.
const children=(node:Element,name?:string)=>[...node.children].filter(child=>!name||child.localName===name);
const child=(node:Element,name:string)=>children(node,name)[0];
const integer=(value:string|null|undefined)=>{const text=(value??'').trim();return /^\d+$/.test(text)?Number(text):null;};
// A source note and, when it starts a span, the note whose matching stop ends it.
type Source={start:boolean;end:Source|null};
// A measure's stringed notes, keyed by staff/voice/string/fret, in document order.
type Run=Source[];
type Measure=Map<string,Run>;
const key=(staff:number,voice:number,string:number,fret:number)=>`${staff}/${voice}/${string}/${fret}`;

// The note's one string/fret placement; alphaTab keeps the last value it reads,
// so repeated values are refused, not guessed.
function placement(note:Element):{string:number;fret:number}|null|undefined {
  const strings=note.getElementsByTagName('string'),frets=note.getElementsByTagName('fret');
  if(!strings.length&&!frets.length)return null;
  if(strings.length!==1||frets.length!==1)return undefined;
  const string=integer(strings[0].textContent),fret=integer(frets[0].textContent);
  return string!==null&&string>0&&fret!==null?{string,fret}:undefined;
}
// The note's hammer-on and pull-off span numbers of one type (1 when unnumbered).
const spans=(note:Element,type:string)=>children(note,'notations').flatMap(item=>children(item,'technical')).flatMap(item=>children(item))
  .filter(item=>(item.localName==='hammer-on'||item.localName==='pull-off')&&item.getAttribute('type')===type).map(item=>item.getAttribute('number')??'1');
// A <staff> or <voice> number, 1 when absent; undefined when alphaTab would misread it.
const lane=(note:Element,name:string)=>{const node=child(note,name);if(!node)return 1;const value=integer(node.textContent);return value&&value>0?value:undefined;};

function measures(part:Element):Measure[]|null {
  // Spans pair by number across the whole part, as MusicXML defines them.
  const result:Measure[]=[],open=new Map<string,Source>();
  for(const measure of children(part,'measure')){
    const found:Measure=new Map();let last:[number,number]|null=null;
    for(const note of children(measure,'note')){
      // alphaTab skips cue notes entirely.
      if(child(note,'cue'))continue;
      // A chord note joins the previous beat, whatever staff or voice it names.
      const chord=!!child(note,'chord')&&!child(note,'rest');
      if(chord&&!last)return null;
      const staff=lane(note,'staff'),voice=lane(note,'voice');if(staff===undefined||voice===undefined)return null;
      const at:[number,number]=chord&&last?last:[staff,voice],[s,v]=at;last=at;
      if(child(note,'rest'))continue;
      const where=placement(note);if(where===undefined)return null;
      const starts=spans(note,'start'),record:Source={start:starts.length>0,end:null};
      for(const number of spans(note,'stop')){const begun=open.get(number);if(begun){begun.end=record;open.delete(number);}}
      for(const number of starts)open.set(number,record);
      if(!where)continue;
      const id=key(s,v,where.string,where.fret),run=found.get(id)??[];found.set(id,run);run.push(record);
    }
    result.push(found);
  }
  return result;
}

// The source of a loaded note, when its run holds exactly the loaded notes.
function locate(note:model.Note,sources:Map<model.Track,Measure[]>):Source|null {
  const voice=note.beat.voice,bar=voice.bar,staff=bar.staff,strings=staff.tuning.length;
  const measure=sources.get(staff.track)?.[bar.index];if(!measure||!strings||staff.bars.length!==sources.get(staff.track)!.length)return null;
  const run=measure.get(key(staff.index+1,voice.index+1,strings-note.string+1,note.fret));if(!run)return null;
  const notes=voice.beats.flatMap(beat=>beat.notes).filter(other=>other.string===note.string&&other.fret===note.fret);
  return notes.length===run.length?run[notes.indexOf(note)]:null;
}

function sourcesOf(score:model.Score,bytes:Uint8Array,settings:Settings):Map<model.Track,Measure[]>|null {
  const source=readMusicXmlSource(bytes,settings);
  if(!source||!/<(hammer-on|pull-off)\b/.test(source.xml))return null;
  const doc=new DOMParser().parseFromString(source.xml,'application/xml'),root=doc.documentElement;
  if(doc.querySelector('parsererror')||root.localName!=='score-partwise')return null;
  // alphaTab creates tracks in part-list order, so parts are matched by their id.
  const list=child(root,'part-list');if(!list)return null;
  const ids=children(list,'score-part').map(part=>part.getAttribute('id')),parts=children(root,'part');
  if(ids.length!==score.tracks.length||parts.length!==ids.length||new Set(ids).size!==ids.length)return null;
  const result=new Map<model.Track,Measure[]>();
  for(const part of parts){
    const track=score.tracks[ids.indexOf(part.getAttribute('id'))],found=measures(part);if(!track||!found)return null;
    result.set(track,found);
  }
  return result;
}

export function applyMusicXmlHammerPulls(score:model.Score,bytes:Uint8Array,settings:Settings):model.Score {
  let sources:Map<model.Track,Measure[]>|null;
  try {
    sources=sourcesOf(score,bytes,settings);
  } catch {
    return score; // unreadable sources keep the stock import
  }
  if(!sources)return score;
  const origins:model.Note[]=[];
  try {
    return restore(score,sources,origins,settings);
  } catch {
    for(const note of origins)note.isHammerPullOrigin=false;
    return score;
  }
}

function restore(score:model.Score,sources:Map<model.Track,Measure[]>,origins:model.Note[],settings:Settings):model.Score {
  // Every started note must be found before any note changes.
  for(const [track,found] of sources)for(const [index,measure] of found.entries())for(const [id,run] of measure){
    if(!run.some(item=>item.start))continue;
    const [staffNumber,voiceNumber,string,fret]=id.split('/').map(Number),staff=track.staves[staffNumber-1];
    if(!staff||staff.bars.length!==found.length)return score;
    // A staff without strings cannot hold an origin.
    if(!staff.tuning.length)continue;
    const voice=staff.bars[index].voices[voiceNumber-1];if(!voice)return score;
    const notes=voice.beats.flatMap(beat=>beat.notes).filter(note=>note.string===staff.tuning.length-string+1&&note.fret===fret);
    if(notes.length!==run.length)return score;
    run.forEach((item,at)=>{if(item.start)origins.push(notes[at]);});
  }
  const notes=new Map(score.tracks.flatMap(track=>track.staves.flatMap(staff=>staff.bars.flatMap(bar=>bar.voices.flatMap(voice=>voice.beats.flatMap(beat=>beat.notes))))).map(note=>[note.id,note]));
  // An origin alphaTab links elsewhere stays unflagged; each one dropped has its own
  // destination search, so the others replay the same.
  for(let kept=new Set(origins);kept.size;){
    for(const note of kept)note.isHammerPullOrigin=true;
    const replayed=scoreFromJson(model.JsonConverter.scoreToJson(score),settings);
    for(const note of kept)note.isHammerPullOrigin=false;
    // The replay keeps note ids, so each link is checked on the stock score: alphaTab's
    // destination must be the note whose stop the source pairs with the origin's start.
    const wrong=new Set<model.Note>();
    for(const track of replayed.tracks)for(const staff of track.staves)for(const bar of staff.bars)for(const voice of bar.voices)for(const beat of voice.beats)for(const note of beat.notes){
      if(!note.isHammerPullOrigin||!note.hammerPullDestination)continue;
      const origin=notes.get(note.id),destination=notes.get(note.hammerPullDestination.id);
      if(!origin||!kept.has(origin))return score;
      const begun=locate(origin,sources),ended=destination&&locate(destination,sources);
      if(!begun||!ended||begun.end!==ended)wrong.add(origin);
    }
    if(!wrong.size)return replayed;
    kept=new Set([...kept].filter(note=>!wrong.has(note)));
  }
  return score;
}
