import { model,type Settings } from '@coderline/alphatab';
import { readMusicXmlSource } from './musicxml-tempo-offsets';

// alphaTab 1.8.4 reads only tempo from a direction's <sound>, so direction-level
// MIDI volume and pan are lost, and it truncates measure-level ones to whole
// sixteenths. This places both as exact TabPlayer track-mix points (0–16 scale,
// fractional) at the sound's musical position, reading the original source.
// Any doubt leaves the stock import untouched.
const ticksPerQuarter=960;
const positiveInteger=(value:string|null|undefined)=>{const text=(value??'').trim();return /^\d+$/.test(text)&&Number(text)>0?Number(text):null;};
const decimal=(value:string|null|undefined)=>{const text=(value??'').trim();return /^-?(\d+(\.\d+)?|\.\d+)$/.test(text)?Number(text):null;};
const children=(node:Element,name?:string)=>[...node.children].filter(child=>!name||child.localName===name);
const child=(node:Element,name:string)=>children(node,name)[0];

type Point={part:number;bar:number;type:model.AutomationType;value:number;tick:number;measure:boolean};
// Per part, bar and zero-based staff: the sorted end ticks of the source voices.
type Layout=Map<string,number[]>;
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

// A direction <offset> (divisions) moves its sound only with sound="yes";
// otherwise the sound takes effect at the current location.
function directionTick(direction:Element,cursor:number,divisions:number|null):number|null {
  const offsets=children(direction,'offset');if(!offsets.length)return cursor;
  const flag=offsets[0].getAttribute('sound'),value=decimal(offsets[0].textContent);
  if(offsets.length>1||value===null||(flag!==null&&flag!=='yes'&&flag!=='no'))return null;
  if(flag!=='yes')return cursor;
  return divisions===null?null:cursor+value*ticksPerQuarter/divisions;
}

// The mix types a sound names, whether or not its values are usable.
function soundTypes(sound:Element){
  const midi=children(sound,'midi-instrument'),types:model.AutomationType[]=[];
  if(midi.some(item=>child(item,'volume')))types.push(model.AutomationType.Volume);
  if(sound.hasAttribute('pan')||midi.some(item=>child(item,'pan')))types.push(model.AutomationType.Balance);
  return types;
}

// alphaTab's own points for a measure-level sound: one per volume, pan element and pan attribute.
function stockCount(sound:Element){
  const midi=children(sound,'midi-instrument');
  return (sound.hasAttribute('pan')?1:0)+midi.reduce((count,item)=>count+children(item,'volume').length+children(item,'pan').length,0);
}

function plan(doc:Document,score:model.Score):{points:Point[];layout:Layout;stock:number[];measureOk:boolean;measureTypes:Set<string>}|null {
  const root=doc.documentElement;
  if(doc.querySelector('parsererror')||root.localName!=='score-partwise')return null;
  // Prefixed or namespaced elements are read differently by alphaTab's parser.
  if([root,...root.getElementsByTagName('*')].some(node=>node.prefix!==null||node.namespaceURI!==null))return null;
  const partList=child(root,'part-list'),scoreParts=partList?children(partList,'score-part'):[],parts=children(root,'part');
  if(!parts.length||parts.length!==scoreParts.length||parts.length!==score.tracks.length)return null;
  const ids=parts.map(part=>part.getAttribute('id'));
  if(new Set(ids).size!==ids.length||parts.some((part,index)=>ids[index]!==scoreParts[index].getAttribute('id')))return null;
  const points:Point[]=[],layout:Layout=new Map(),stock=parts.map(()=>0),measureTypes=new Set<string>();let found=false,measureOk=true;
  for(const [index,part] of parts.entries()){
    const declared=children(scoreParts[index],'score-instrument'),midi=children(scoreParts[index],'midi-instrument');
    // A midi-instrument id names its score-instrument; without one, the part-list midi-instrument.
    const instruments=declared.length>1||midi.length>1?null:new Set((declared.length?declared:midi).flatMap(node=>node.getAttribute('id')??[]));
    const measures=children(part);
    if(measures.length!==score.masterBars.length||measures.some(measure=>measure.localName!=='measure'))return null;
    let divisions:number|null=null;
    for(const [bar,measure] of measures.entries()){
      const length=score.masterBars[bar].calculateDuration(),voices=new Map<string,number>();let cursor=0,end=0,started=false;
      const ticks=(node:Element)=>{
        // alphaTab keeps the last or sums repeated durations, so only one is read.
        const durations=children(node,'duration');if(durations.length!==1||children(node,'voice').length>1||children(node,'staff').length>1)return null;
        const duration=positiveInteger(durations[0].textContent);if(duration===null||divisions===null)return null;
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
          const staff=positiveInteger(child(item,'staff')?.textContent??'1'),voice=child(item,'voice')?.textContent?.trim()||'1';if(staff===null)return null;
          voices.set(`${staff-1}/${voice}`,cursor);
        } else if(item.localName==='forward'||item.localName==='backup'){
          // alphaTab ignores a backup before the measure's first note.
          const value=ticks(item);if(value===null||!started&&item.localName==='backup')return null;
          cursor+=item.localName==='forward'?value:-value;if(cursor<0)return null;
        } else if(item.localName==='sound'){
          const mix=soundMix(item,instruments);if(mix===undefined)continue;
          // A doubtful measure-level sound keeps every stock measure-level point.
          if(mix===null||child(item,'offset')||score.masterBars[bar].isAnacrusis||Math.round(cursor)>=length){
            measureOk=false;for(const type of soundTypes(item))measureTypes.add(`${index}/${type}`);continue;
          }
          for(const value of mix){points.push({part:index,bar,tick:cursor,measure:true,...value});measureTypes.add(`${index}/${value.type}`);}
          stock[index]+=stockCount(item);found=true;
        } else if(item.localName==='direction'){
          const sounds=children(item,'sound');
          for(const sound of sounds){
            const mix=soundMix(sound,instruments);if(mix===undefined)continue;
            // Sound-level offsets, unknown instruments and out-of-range values are not guessed.
            if(mix===null||sounds.length>1||child(sound,'offset')||score.masterBars[bar].isAnacrusis)return null;
            // Controller ticks are rounded, so a target must not round onto the bar end.
            const tick=directionTick(item,cursor,divisions);if(tick===null||tick<0||Math.round(tick)>=length)return null;
            for(const value of mix)points.push({part:index,bar,tick,measure:false,...value});
            found=true;
          }
        }
        end=Math.max(end,cursor);
      }
      if(end!==length)return null; // incomplete or overfull bars
      for(const [key,value] of voices){const staff=`${index}/${bar}/${key.split('/')[0]}`;layout.set(staff,[...layout.get(staff)??[],value].sort((a,b)=>a-b));}
    }
  }
  return found?{points,layout,stock,measureOk,measureTypes}:null;
}

// Part-level <volume>/<pan> is common, so only sounds carrying them justify a parse.
// One pass over opening tags; self-closing ones (common for dynamics) end at once.
function hasSoundMix(xml:string){
  let closers=true;
  for(const match of xml.matchAll(/<sound(?=[\s/>])[^>]*>/g)){
    const tag=match[0];if(/\span\s*=/.test(tag))return true;
    if(tag.endsWith('/>')||!closers)continue;
    const start=match.index!+tag.length,end=xml.indexOf('</sound',start);
    if(end<0){closers=false;continue;}
    if(/<(volume|pan)[\s>]/.test(xml.slice(start,end)))return true;
  }
  return false;
}

const isMix=(automation:model.Automation)=>automation.type===model.AutomationType.Volume||automation.type===model.AutomationType.Balance;
const trackBeats=(track:model.Track)=>track.staves.flatMap(staff=>staff.bars.flatMap(bar=>bar.voices.flatMap(voice=>voice.beats)));

// Every model voice must end where its source voice ends. Otherwise alphaTab placed
// the music differently from the source cursor (dropped or added time).
function sameVoices(score:model.Score,layout:Layout){
  for(const key of layout.keys()){const [part,,staff]=key.split('/').map(Number);if(!score.tracks[part]?.staves[staff])return false;}
  return score.tracks.every((track,part)=>track.staves.every(staff=>staff.bars.every(bar=>{
    const ends=bar.voices.filter(voice=>!voice.isEmpty&&voice.beats.length).map(voice=>{const last=voice.beats[voice.beats.length-1];return last.playbackStart+last.playbackDuration;}).sort((a,b)=>a-b);
    const source=layout.get(`${part}/${bar.index}/${staff.index}`)??[];
    return ends.length===source.length&&ends.every((value,index)=>value===source[index]);
  })));
}

export function applyMusicXmlDirectionMix(score:model.Score,bytes:Uint8Array,settings:Settings):model.Score {
  try {
    const source=readMusicXmlSource(bytes,settings);
    if(!source||!hasSoundMix(source.xml))return score;
    const planned=plan(new DOMParser().parseFromString(source.xml,'application/xml'),score);if(!planned||!sameVoices(score,planned.layout))return score;
    // Measure-level sounds replace alphaTab's truncated points only when every one is
    // in the domain and accounts for exactly the stock points; otherwise those stay.
    const exact=planned.measureOk&&score.tracks.every((track,part)=>trackBeats(track).reduce((count,beat)=>count+beat.automations.filter(isMix).length,0)===planned.stock[part]);
    // Kept stock points could interleave with direction points of their type, so
    // the fallback adds only types that no measure-level sound in the part sets.
    const points=exact?planned.points:planned.points.filter(point=>!point.measure&&!planned.measureTypes.has(`${point.part}/${point.type}`));if(!points.length)return score;
    const owners=points.map(point=>score.tracks[point.part].staves[0]?.bars[point.bar]?.voices[0]?.beats[0]);
    if(owners.some(owner=>!owner))return score;
    // Every point has an owner before any automation changes.
    if(exact)for(const track of score.tracks)for(const beat of trackBeats(track))beat.automations=beat.automations.filter(automation=>!isMix(automation));
    points.forEach((point,index)=>owners[index]!.automations.push(Object.assign(new model.Automation(),{type:point.type,value:point.value,ratioPosition:point.tick/score.masterBars[point.bar].calculateDuration(),isLinear:false,isVisible:true,text:''})));
  } catch {
    // Unreadable sources keep the stock import.
  }
  return score;
}
