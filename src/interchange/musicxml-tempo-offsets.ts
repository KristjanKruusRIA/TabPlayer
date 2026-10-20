import type { Settings } from '@coderline/alphatab';
import { strToU8,unzipSync,zipSync } from 'fflate';
import { numberTransposedTies } from './musicxml-transposed-ties';

// alphaTab 1.8.4 adds a direction <offset> (MusicXML divisions) to its
// 960-per-quarter tick cursor for sound tempos, metronome marks and pedals,
// whatever its playback flag. This builds temporary loader bytes in which a
// tempo offset is in ticks with sound="yes" and zero otherwise (the sound then
// takes effect at the current location), and a pedal-only offset is always in
// ticks: TabPlayer only draws pedals, and an offset always moves the drawing.
// The result is a compatibility shim: never store or export it.
const ticksPerQuarter=960;
const musicXmlMedia='application/vnd.recordare.musicxml+xml';
const decimal=(value:string|null|undefined)=>{const text=(value??'').trim();return /^-?(\d+(\.\d+)?|\.\d+)$/.test(text)?Number(text):null;};
const positiveInteger=(value:string|null|undefined)=>{const text=(value??'').trim();return /^\d+$/.test(text)&&Number(text)>0?Number(text):null;};
const children=(node:Element,name?:string)=>[...node.children].filter(child=>!name||child.localName===name);
const child=(node:Element,name:string)=>children(node,name)[0];

function isUtf8(settings:Settings){return /^utf-?8$/i.test(settings.importer.encoding);}

// The measure length in ticks from simple numeric <time> elements, or null.
function meterTicks(attributes:Element):number|null|undefined {
  const times=children(attributes,'time');if(!times.length)return undefined;
  const lengths=times.map(time=>{
    const beats=children(time,'beats'),types=children(time,'beat-type');
    if(child(time,'senza-misura')||beats.length!==1||types.length!==1)return null;
    const count=positiveInteger(beats[0].textContent),type=positiveInteger(types[0].textContent);
    return count===null||type===null?null:count*4*ticksPerQuarter/type;
  });
  return lengths.every(length=>length!==null&&length===lengths[0])?lengths[0]:null;
}

// Returns the new offset text per tempo or pedal offset alphaTab would misplace,
// or null when the score is outside the domain (the caller keeps the input).
// The cursor follows the rules alphaTab shares with the source; where they part
// (cue notes, chord rests, an early backup, repeated values) nothing changes.
function plan(doc:Document):Map<Element,string>|null {
  const root=doc.documentElement;
  if(doc.querySelector('parsererror')||root.localName!=='score-partwise')return null;
  if([root,...root.getElementsByTagName('*')].some(node=>node.prefix!==null||node.namespaceURI!==null))return null;
  const changes=new Map<Element,string>(),meters:(number|null|undefined)[][]=[],moved=new Set<number>();
  for(const part of children(root,'part')){
    // undefined: no <time> yet; null: one that alphaTab may read differently.
    let divisions:number|null=null,meter:number|null|undefined;const partMeters:(number|null|undefined)[]=[];meters.push(partMeters);
    for(const [index,measure] of children(part).entries()){
      if(measure.localName!=='measure')return null;
      let cursor=0,end=0,started=false;const flagged:{offset:Element;target:number;text:string}[]=[],voices=new Map<string,number>(),pedals:{tick:number;moved:boolean}[]=[];
      const ticks=(node:Element)=>{
        const durations=children(node,'duration');if(durations.length!==1||children(node,'voice').length>1||children(node,'staff').length>1)return null;
        const duration=positiveInteger(durations[0].textContent);if(duration===null||divisions===null)return null;
        const value=duration*ticksPerQuarter/divisions;return Number.isInteger(value)?value:null;
      };
      for(const item of children(measure)){
        if(item.localName==='attributes'){
          for(const node of children(item,'divisions')){divisions=positiveInteger(node.textContent);if(divisions===null)return null;}
          const length=meterTicks(item);if(length!==undefined)meter=length;
        } else if(item.localName==='note'){
          if(child(item,'cue')||child(item,'chord')&&(child(item,'rest')||!started))return null;
          started=true;
          if(child(item,'chord'))continue;
          // alphaTab moves its cursor to the voice end when a note starts inside
          // music its voice already holds.
          // Keyed as alphaTab parses them: numeric staff, and voice 1 for non-numbers.
          const number=(name:string)=>{const value=Number.parseInt(child(item,name)?.textContent??'1',10);return Number.isNaN(value)?1:value;};
          const voice=`${number('staff')}/${number('voice')}`;
          if(cursor<(voices.get(voice)??0))return null;
          if(child(item,'grace'))continue;
          const value=ticks(item);if(value===null)return null;cursor+=value;voices.set(voice,cursor);
        } else if(item.localName==='forward'||item.localName==='backup'){
          const value=ticks(item);if(value===null||!started&&item.localName==='backup')return null;
          cursor+=item.localName==='forward'?value:-value;if(cursor<0)return null;
        } else if(item.localName==='direction'){
          // alphaTab uses the offset only for tempos, metronome marks and pedal markers.
          const sounds=children(item,'sound'),offsets=children(item,'offset'),types=children(item,'direction-type').flatMap(type=>children(type));
          const tempo=sounds.some(sound=>(decimal(sound.getAttribute('tempo'))??0)>0)||types.some(type=>type.localName==='metronome');
          const pedal=types.some(type=>type.localName==='pedal'&&['start','stop','continue'].includes(type.getAttribute('type')??''));
          if(!offsets.length){if(pedal)pedals.push({tick:cursor,moved:false});continue;}
          if(!tempo&&!pedal)continue;
          if(sounds.length>1||offsets.length>1||sounds.some(sound=>child(sound,'offset')))return null; // nested override: precedence not guessed
          const offset=offsets[0],flag=offset.getAttribute('sound'),value=decimal(offset.textContent);
          if(value===null||(flag!==null&&flag!=='yes'&&flag!=='no'))return null;
          if(value===0){if(pedal)pedals.push({tick:cursor,moved:false});continue;}
          // A shared tempo keeps its playback rule; a pedal on its own follows its drawing.
          if(flag!=='yes'&&tempo){changes.set(offset,'0');if(pedal)pedals.push({tick:cursor,moved:false});continue;}
          if(divisions===null)return null;
          const shift=value*ticksPerQuarter/divisions;flagged.push({offset,target:cursor+shift,text:String(shift)});
          if(pedal)pedals.push({tick:cursor+shift,moved:true});
        }
        end=Math.max(end,cursor);
      }
      partMeters[index]=meter;
      // alphaTab drops a marker at or before the previous one, so a moved pedal must
      // stay strictly between its neighbours.
      if(pedals.some((marker,at)=>at>0&&(marker.moved||pedals[at-1].moved)&&marker.tick<=pedals[at-1].tick))return null;
      if(!flagged.length)continue;
      moved.add(index);
      // A moved tempo must stay inside a complete, explicit measure.
      if(measure.getAttribute('implicit')==='yes'||typeof meter!=='number'||end!==meter)return null;
      for(const {offset,target,text} of flagged){if(target<0||target>=meter)return null;changes.set(offset,text);}
    }
  }
  // alphaTab keeps one bar length per measure, so every part that sets one must agree.
  for(const index of moved){const set=meters.map(partMeters=>partMeters[index]).filter(value=>value!==undefined);if(set.some(value=>value!==set[0]))return null;}
  return changes.size?changes:null;
}

// The DOM decides what changes; only the offset text is replaced in the source
// string, so every other character reaches the stock parser exactly as authored.
function normalize(xml:string):string|null {
  if(!xml.includes('offset'))return null;
  const doc=new DOMParser().parseFromString(xml,'application/xml'),changes=plan(doc);
  if(!changes)return null;
  const elements=[...doc.getElementsByTagName('offset')],matches=[...xml.matchAll(/<offset(?=[\s>])[^>]*>([^<]*)<\/offset\s*>/g)];
  if(matches.length!==elements.length||matches.some((match,index)=>match[1]!==elements[index].textContent))return null;
  let result='',position=0;
  matches.forEach((match,index)=>{
    const text=changes.get(elements[index]);if(text===undefined)return;
    const start=match.index!+match[0].indexOf('>')+1;
    result+=xml.slice(position,start)+text;position=start+match[1].length;
  });
  result+=xml.slice(position);
  // Comments and CDATA can hide offsets from one side only, so confirm on a fresh
  // parse that every offset carries exactly its planned text.
  const expected=elements.map(element=>changes.get(element)??element.textContent);
  const actual=[...new DOMParser().parseFromString(result,'application/xml').getElementsByTagName('offset')].map(element=>element.textContent);
  return actual.length===expected.length&&actual.every((text,index)=>text===expected[index])?result:null;
}

function decode(bytes:Uint8Array){
  try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return null;}
}
function declaredUtf8(xml:string){
  const encoding=/^\s*<\?xml[^>]*\bencoding\s*=\s*["']([^"']+)["']/.exec(xml)?.[1];
  return encoding===undefined||/^utf-?8$/i.test(encoding);
}

// Returns the MusicXML text the stock loader reads: plain UTF-8 XML, or an MXL
// container's first rootfile (path set). Anything else gives null.
export function readMusicXmlSource(bytes:Uint8Array,settings:Settings):{xml:string;path:string|null}|null {
  if(!isUtf8(settings))return null;
  if(bytes[0]===0x50&&bytes[1]===0x4b)return readArchiveRoot(bytes,settings);
  const start=bytes[0]===0xef&&bytes[1]===0xbb&&bytes[2]===0xbf?3:0;
  let first=start;while(first<bytes.length&&[9,10,13,32].includes(bytes[first]))first++;
  if(bytes[first]!==0x3c)return null;
  const xml=decode(bytes);
  return xml===null||!declaredUtf8(xml)?null:{xml,path:null};
}

function readArchiveRoot(bytes:Uint8Array,settings:Settings):{xml:string;path:string}|null {
  const limit=settings.importer.maxDecodingBufferSize;let oversized=false,duplicate=false;const seen=new Set<string>();
  const read=(names:Set<string>)=>unzipSync(bytes,{filter:entry=>{
    // fflate keeps the last of repeated names while the stock reader takes the first.
    if(seen.has(entry.name))duplicate=true;seen.add(entry.name);
    if(!names.has(entry.name))return false;
    if(entry.originalSize>limit||strToU8(entry.name).length>limit){oversized=true;return false;}
    return true;
  }});
  // Only container metadata and the selected root are decompressed for inspection.
  const metadata=read(new Set(['META-INF/container.xml']))['META-INF/container.xml'];
  if(!metadata||oversized||duplicate)return null;
  const containerXml=decode(metadata);if(containerXml===null)return null;
  const container=new DOMParser().parseFromString(containerXml,'application/xml');
  if(container.querySelector('parsererror')||container.documentElement.localName!=='container')return null;
  const rootfiles=child(container.documentElement,'rootfiles'),rootfile=rootfiles&&child(rootfiles,'rootfile');
  const path=rootfile?.getAttribute('full-path'),media=rootfile?.getAttribute('media-type');
  if(!path||(media!==null&&media!==undefined&&media!==musicXmlMedia))return null;
  const root=read(new Set([path]))[path];if(!root||oversized)return null;
  const xml=decode(root);
  return xml===null||!declaredUtf8(xml)?null:{xml,path};
}

function repack(bytes:Uint8Array,settings:Settings,path:string,xml:string):Uint8Array {
  const limit=settings.importer.maxDecodingBufferSize;let oversized=false;
  const entries=unzipSync(bytes,{filter:entry=>{
    if(entry.originalSize>limit||strToU8(entry.name).length>limit){oversized=true;return false;}
    return true;
  }});
  if(oversized)return bytes;
  entries[path]=strToU8(xml);
  return zipSync(entries);
}

export function prepareMusicXmlTempoOffsets(bytes:Uint8Array,settings:Settings):Uint8Array {
  try {
    const source=readMusicXmlSource(bytes,settings);if(!source)return bytes;
    const normalized=normalize(source.xml);if(normalized===null)return bytes;
    return source.path===null?strToU8(normalized):repack(bytes,settings,source.path,normalized);
  } catch {
    return bytes; // malformed input keeps the stock loader's error path
  }
}

// All temporary loader rewrites: tempo offsets in ticks, then numbered ties in
// transposing parts. Either may apply alone; original bytes stay authoritative.
export function prepareMusicXmlLoaderBytes(bytes:Uint8Array,settings:Settings):Uint8Array {
  try {
    const source=readMusicXmlSource(bytes,settings);if(!source)return bytes;
    const tempo=normalize(source.xml),xml=tempo??source.xml,ties=numberTransposedTies(xml),result=ties??tempo;
    if(result===null)return bytes;
    return source.path===null?strToU8(result):repack(bytes,settings,source.path,result);
  } catch {
    return bytes; // malformed input keeps the stock loader's error path
  }
}
