import { type model,type Settings } from '@coderline/alphatab';
import { readMusicXmlSource } from './musicxml-tempo-offsets';

// alphaTab 1.8.4 reads a direction's <words> as the text of the next beat it creates,
// even when the same direction sets the tempo, so tempo text comes back as beat text.
// Where a direction carries both, its words become that tempo's text and leave the beat
// they reached. The walk below repeats alphaTab's rules; when the beat texts it predicts
// differ from the import, or a match is in doubt, the stock import stays.
const children=(node:Element,name?:string)=>[...node.children].filter(child=>!name||child.localName===name);
const child=(node:Element,name:string)=>children(node,name)[0];
const decimal=(value:string|null|undefined)=>{const text=(value??'').trim();return /^(\d+(\.\d+)?|\.\d+)$/.test(text)?Number(text):null;};
type Place={part:number;measure:number};
// Pending words: their direction's place, the tempo it sets (null: none or in doubt)
// and where alphaTab's next beat took them.
type Words=Place&{text:string;tempo:number|null;reached:Place|null};

// The tempo a direction sets: its one <sound tempo>, agreeing plain quarter metronome marks.
function tempoOf(direction:Element,types:Element[]):number|null {
  const sounds=children(direction,'sound').filter(node=>node.hasAttribute('tempo'));
  if(sounds.length>1)return null; // alphaTab reads the last one
  const values:(number|null)[]=sounds.map(sound=>{const value=decimal(sound.getAttribute('tempo'));return value!==null&&value>0?value:null;});
  for(const mark of types.filter(type=>type.localName==='metronome')){
    const plain=children(mark).every(item=>['beat-unit','per-minute'].includes(item.localName))&&child(mark,'beat-unit')?.textContent?.trim()==='quarter';
    values.push(plain?decimal(child(mark,'per-minute')?.textContent):null);
  }
  if(!values.length||values.some(value=>value===null||value!==values[0]))return null;
  return values[0];
}

// Every words direction across the parts, in alphaTab's parse order; null when the
// source holds a form this walk does not follow.
function walk(parts:Element[]):Words[]|null {
  const result:Words[]=[];let pending:Words|null=null;
  for(const [part,element] of parts.entries())for(const [measure,bar] of children(element,'measure').entries()){
    let started=false; // alphaTab's last beat resets with each measure
    for(const item of children(bar)){
      if(item.localName==='note'){
        if(child(item,'cue'))continue;
        // A chord note joins the last beat, unless it is a rest or the measure's first.
        if(child(item,'chord')&&started&&!child(item,'rest'))continue;
        started=true;
        if(pending){pending.reached={part,measure};pending=null;}
      } else if(item.localName==='direction'){
        // alphaTab reads only the last child of each direction-type.
        const holders=children(item,'direction-type');
        if(holders.some(holder=>[...holder.childNodes].some(node=>node.nodeType===3&&node.textContent!.trim())))return null;
        const types=holders.map(holder=>holder.lastElementChild).filter((type):type is Element=>!!type);
        let text='';
        for(const type of types){
          if(type.localName==='words')text=(type.textContent??'').trim();
          else if(type.localName==='dashes')text='';
        }
        if(!text)continue;
        pending={part,measure,text,tempo:tempoOf(item,types),reached:null};
        result.push(pending);
      }
    }
  }
  return result;
}

export function applyMusicXmlTempoWords(score:model.Score,bytes:Uint8Array,settings:Settings):model.Score {
  const changes:(()=>void)[]=[];
  try {
    const source=readMusicXmlSource(bytes,settings);
    if(!source||!source.xml.includes('<words')||!/tempo=|<metronome/.test(source.xml))return score;
    // alphaTab's parser reads CDATA as an element and expands only the predefined and
    // decimal entities, so the DOM could see other words or tempos there.
    if(source.xml.includes('<![CDATA[')||/&(?!(amp|lt|gt|quot|apos|#\d+);)/.test(source.xml))return score;
    const doc=new DOMParser().parseFromString(source.xml,'application/xml'),root=doc.documentElement;
    if(doc.querySelector('parsererror')||root.localName!=='score-partwise')return score;
    if([root,...root.getElementsByTagName('*')].some(node=>node.prefix!==null||node.namespaceURI!==null))return score;
    // alphaTab creates tracks in part-list order, so parts are matched by their id.
    // alphaTab skips a part that comes before the part-list.
    const list=child(root,'part-list');if(!list||children(root).indexOf(list)>children(root).findIndex(node=>node.localName==='part'))return score;
    const ids=children(list,'score-part').map(part=>part.getAttribute('id')),parts=children(root,'part');
    const tracks=parts.map(part=>ids.indexOf(part.getAttribute('id')));
    // The DOM turns whitespace in an attribute into spaces where alphaTab keeps it.
    if(ids.length!==score.tracks.length||parts.length!==ids.length||[...ids,...parts.map(part=>part.getAttribute('id'))].some(id=>!id||/\s/.test(id))||new Set(ids).size!==ids.length||tracks.some(index=>index<0))return score;
    const found=walk(parts);if(!found)return score;
    // The walk must predict every beat text of the import, bar by bar.
    for(const [part,index] of tracks.entries()){
      const expected=found.filter(words=>words.reached?.part===part).map(words=>`${words.reached!.measure}\n${words.text}`).sort();
      const actual=score.tracks[index].staves.flatMap(staff=>staff.bars.flatMap(bar=>bar.voices.flatMap(voice=>voice.beats.filter(beat=>beat.text).map(beat=>`${bar.index}\n${beat.text}`)))).sort();
      if(expected.length!==actual.length||expected.some((key,at)=>key!==actual[at]))return score;
    }
    const texts=new Map<model.Automation,string>(),cleared=new Set<model.Beat>();
    for(const words of found){
      if(words.tempo===null)continue;
      // The first tempo of a bar may also leave a hidden initial copy at its start.
      const matches=score.masterBars[words.measure]?.tempoAutomations.filter(automation=>automation.isVisible&&automation.value===words.tempo)??[];
      if(matches.length!==1)continue;
      const automation=matches[0];
      if((automation.text&&automation.text!==words.text)||(texts.has(automation)&&texts.get(automation)!==words.text))continue;
      let holder:model.Beat|null=null;
      if(words.reached){
        const {part,measure}=words.reached;
        const holders=score.tracks[tracks[part]].staves.flatMap(staff=>staff.bars[measure]?.voices.flatMap(voice=>voice.beats.filter(beat=>beat.text===words.text))??[]);
        if(holders.length!==1||cleared.has(holders[0]))continue;
        holder=holders[0];cleared.add(holder);
      }
      texts.set(automation,words.text);
      const beat=holder,text=words.text;
      changes.push(()=>{automation.text=text;if(beat)beat.text=null;});
    }
  } catch {
    return score; // unreadable sources keep the stock import
  }
  // Every direction is matched before anything changes.
  for(const change of changes)change();
  return score;
}
