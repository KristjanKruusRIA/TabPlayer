import { model,type Settings } from '@coderline/alphatab';
import { readMusicXmlSource } from './musicxml-tempo-offsets';

// alphaTab 1.8.4 reads only tempo from a direction's <sound>, so direction-level
// MIDI volume and pan are lost. This restores them as TabPlayer track-mix
// points (0–16 scale, fractional) at the direction's musical position, reading
// the original source. Any doubt leaves the stock import untouched.
const ticksPerQuarter=960;
const positiveInteger=(value:string|null|undefined)=>{const text=(value??'').trim();return /^\d+$/.test(text)&&Number(text)>0?Number(text):null;};
const decimal=(value:string|null|undefined)=>{const text=(value??'').trim();return /^-?(\d+(\.\d+)?|\.\d+)$/.test(text)?Number(text):null;};
const children=(node:Element,name?:string)=>[...node.children].filter(child=>!name||child.localName===name);
const child=(node:Element,name:string)=>children(node,name)[0];

type Point={part:number;bar:number;type:model.AutomationType;value:number;tick:number};
type Mix={type:model.AutomationType;value:number}[];

// The sound's volume/pan points; undefined when it carries none, null when it
// carries some outside the domain.
// instruments is the part's single instrument id (empty when undeclared), or null
// when the part declares several instruments.
function soundMix(sound:Element,instruments:Set<string>|null):Mix|null|undefined {
  const midi=children(sound,'midi-instrument'),attribute=sound.getAttribute('pan');
  if(attribute===null&&!midi.some(item=>child(item,'volume')||child(item,'pan')))return undefined;
  // A change meant for one repeat pass or one of several instruments is not guessed.
  if(!instruments||midi.length>1||sound.hasAttribute('time-only'))return null;
  const instrument=midi[0],id=instrument?.getAttribute('id');
  if(id!==null&&id!==undefined&&!instruments.has(id))return null;
  const volumes=instrument?children(instrument,'volume'):[],pans=instrument?children(instrument,'pan'):[];
  if(volumes.length>1||pans.length>1)return null;
  const result:Mix=[];
  if(volumes.length){const value=decimal(volumes[0].textContent);if(value===null||value<0||value>100)return null;result.push({type:model.AutomationType.Volume,value:value*16/100});}
  // The midi-instrument <pan> takes priority over the deprecated attribute.
  const panText=pans.length?pans[0].textContent:attribute;
  if(panText!==null){const value=decimal(panText);if(value===null||value<-90||value>90)return null;result.push({type:model.AutomationType.Balance,value:(value+90)*16/180});}
  return result;
}

function plan(doc:Document,score:model.Score):Point[]|null {
  const root=doc.documentElement;
  if(doc.querySelector('parsererror')||root.localName!=='score-partwise')return null;
  // Prefixed or namespaced elements are read differently by alphaTab's parser.
  if([root,...root.getElementsByTagName('*')].some(node=>node.prefix!==null||node.namespaceURI!==null))return null;
  const partList=child(root,'part-list'),scoreParts=partList?children(partList,'score-part'):[],parts=children(root,'part');
  if(!parts.length||parts.length!==scoreParts.length||parts.length!==score.tracks.length)return null;
  const ids=parts.map(part=>part.getAttribute('id'));
  if(new Set(ids).size!==ids.length||parts.some((part,index)=>ids[index]!==scoreParts[index].getAttribute('id')))return null;
  const points:Point[]=[];let found=false;
  for(const [index,part] of parts.entries()){
    const declared=children(scoreParts[index],'score-instrument'),midi=children(scoreParts[index],'midi-instrument');
    // A midi-instrument id names its score-instrument; without one, the part-list midi-instrument.
    const instruments=declared.length>1||midi.length>1?null:new Set((declared.length?declared:midi).flatMap(node=>node.getAttribute('id')??[]));
    const measures=children(part);
    if(measures.length!==score.masterBars.length||measures.some(measure=>measure.localName!=='measure'))return null;
    let divisions:number|null=null;
    for(const [bar,measure] of measures.entries()){
      const length=score.masterBars[bar].calculateDuration();let cursor=0,end=0,started=false;
      const ticks=(node:Element)=>{
        const duration=positiveInteger(child(node,'duration')?.textContent);if(duration===null||divisions===null)return null;
        const value=duration*ticksPerQuarter/divisions;return Number.isInteger(value)?value:null;
      };
      for(const item of children(measure)){
        if(item.localName==='attributes'){
          for(const node of children(item,'divisions')){divisions=positiveInteger(node.textContent);if(divisions===null)return null;}
        } else if(item.localName==='note'){
          // alphaTab drops cue notes and gives chord rests their own beat.
          if(child(item,'cue')||child(item,'chord')&&(child(item,'rest')||!started))return null;
          started=true;
          if(child(item,'chord')||child(item,'grace'))continue;
          const value=ticks(item);if(value===null)return null;cursor+=value;
        } else if(item.localName==='forward'||item.localName==='backup'){
          // alphaTab ignores a backup before the measure's first note.
          const value=ticks(item);if(value===null||!started&&item.localName==='backup')return null;
          cursor+=item.localName==='forward'?value:-value;if(cursor<0)return null;
        } else if(item.localName==='direction'){
          const sounds=children(item,'sound');
          for(const sound of sounds){
            const mix=soundMix(sound,instruments);if(mix===undefined)continue;
            // Offsets, unknown instruments and out-of-range values are not guessed.
            if(mix===null||sounds.length>1||child(item,'offset')||child(sound,'offset')||cursor>=length||score.masterBars[bar].isAnacrusis)return null;
            for(const value of mix)points.push({part:index,bar,tick:cursor,...value});
            found=true;
          }
        }
        end=Math.max(end,cursor);
      }
      if(end!==length)return null; // incomplete or overfull bars
    }
  }
  return found?points:null;
}

// Part-level <volume>/<pan> is common, so only directions carrying them justify a parse.
function hasDirectionMix(xml:string){
  for(const match of xml.matchAll(/<direction[\s>][\s\S]*?<\/direction\s*>/g))if(/<(volume|pan)[\s>]|\span\s*=/.test(match[0]))return true;
  return false;
}

// Every model voice must fill its master bar. Otherwise alphaTab placed the music
// differently from the source cursor (dropped or added time) and positions differ.
function completeBars(score:model.Score){
  return score.tracks.every(track=>track.staves.every(staff=>staff.bars.every(bar=>bar.voices.every(voice=>{
    if(voice.isEmpty||!voice.beats.length)return true;
    const last=voice.beats[voice.beats.length-1];
    return last.playbackStart+last.playbackDuration===score.masterBars[bar.index].calculateDuration();
  }))));
}

export function applyMusicXmlDirectionMix(score:model.Score,bytes:Uint8Array,settings:Settings):model.Score {
  try {
    const source=readMusicXmlSource(bytes,settings);
    if(!source||!hasDirectionMix(source.xml))return score;
    const points=plan(new DOMParser().parseFromString(source.xml,'application/xml'),score);if(!points||!completeBars(score))return score;
    const owners=points.map(point=>score.tracks[point.part].staves[0]?.bars[point.bar]?.voices[0]?.beats[0]);
    if(owners.some(owner=>!owner))return score;
    // Every point has an owner before any automation is added.
    points.forEach((point,index)=>owners[index]!.automations.push(Object.assign(new model.Automation(),{type:point.type,value:point.value,ratioPosition:point.tick/score.masterBars[point.bar].calculateDuration(),isLinear:false,isVisible:true,text:''})));
  } catch {
    // Unreadable sources keep the stock import.
  }
  return score;
}
