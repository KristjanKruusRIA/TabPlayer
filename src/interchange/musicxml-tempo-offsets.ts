import type { Settings } from '@coderline/alphatab';
import { strToU8,unzipSync,zipSync } from 'fflate';

// alphaTab 1.8.4 adds a direction <offset> (MusicXML divisions) to its
// 960-per-quarter tick cursor. For one narrow, simple timing domain this builds
// temporary loader bytes with qualifying playback tempo offsets in ticks.
// The result is a compatibility shim: never store or export it.
const ticksPerQuarter=960;
const musicXmlMedia='application/vnd.recordare.musicxml+xml';
const jumpAttributes=['segno','coda','tocoda','dacapo','dalsegno','fine','forward-repeat'];
const measureChildren=new Set(['attributes','note','direction','barline','print']);
const positiveInteger=(value:string|null|undefined)=>{const text=(value??'').trim();return /^\d+$/.test(text)&&Number(text)>0?Number(text):null;};
const children=(node:Element,name?:string)=>[...node.children].filter(child=>!name||child.localName===name);
const child=(node:Element,name:string)=>children(node,name)[0];

function isUtf8(settings:Settings){return /^utf-?8$/i.test(settings.importer.encoding);}

// Returns the new offset text per qualifying element, or null when the whole
// score is outside the simple domain (the caller then keeps the input as is).
function plan(doc:Document):Map<Element,string>|null {
  const root=doc.documentElement;
  if(doc.querySelector('parsererror')||root.localName!=='score-partwise')return null;
  const parts=children(root,'part');if(parts.length!==1)return null;
  const measures=children(parts[0]);if(!measures.length||measures.some(measure=>measure.localName!=='measure'))return null;
  const changes=new Map<Element,string>();let divisions:number|null=null,meter:string|null=null;
  for(const measure of measures){
    if(measure.getAttribute('implicit')==='yes')return null;
    let cursor=0;const pending:[Element,number][]=[];
    for(const item of children(measure)){
      if(!measureChildren.has(item.localName))return null;
      if(item.localName==='attributes'){
        if(child(item,'staves')&&positiveInteger(child(item,'staves')!.textContent)!==1)return null;
        for(const node of children(item,'divisions')){const value=positiveInteger(node.textContent);if(value===null||(divisions!==null&&value!==divisions)||(divisions===null&&cursor>0))return null;divisions=value;}
        for(const time of children(item,'time')){
          const beats=children(time,'beats'),types=children(time,'beat-type');
          if(child(time,'senza-misura')||beats.length!==1||types.length!==1)return null;
          const value=`${beats[0].textContent?.trim()}/${types[0].textContent?.trim()}`;if(value!=='4/4'||(meter===null&&cursor>0))return null;meter=value;
        }
      } else if(item.localName==='barline'){
        if(child(item,'repeat')||child(item,'ending')||child(item,'segno')||child(item,'coda'))return null;
      } else if(item.localName==='note'){
        if(['chord','grace','cue','time-modification'].some(name=>child(item,name)))return null;
        if([child(item,'voice'),child(item,'staff')].some(node=>node&&node.textContent?.trim()!=='1'))return null;
        const duration=positiveInteger(child(item,'duration')?.textContent);if(duration===null||divisions===null||meter===null)return null;
        cursor+=duration;
      } else if(item.localName==='direction'){
        const sounds=children(item,'sound'),offset=child(item,'offset'),types=children(item,'direction-type').flatMap(type=>children(type));
        if(child(item,'staff')&&child(item,'staff')!.textContent?.trim()!=='1')return null;
        if(child(item,'voice')&&child(item,'voice')!.textContent?.trim()!=='1')return null;
        if(types.some(type=>type.localName==='segno'||type.localName==='coda'))return null;
        if(sounds.some(sound=>jumpAttributes.some(name=>sound.hasAttribute(name))))return null;
        if(!offset||offset.getAttribute('sound')!=='yes')continue; // absent means no: legacy behaviour
        const value=Number(offset.textContent);
        if(!Number.isFinite(value)||value<0)return null;
        if(value===0)continue;
        if(sounds.some(sound=>child(sound,'offset')))return null; // nested override: precedence not guessed
        const tempo=sounds.length===1?Number(sounds[0].getAttribute('tempo')):NaN;
        const qualifying=types.length>0&&types.every(type=>type.localName==='words')&&Number.isFinite(tempo)&&tempo>0&&sounds[0].attributes.length===1;
        if(divisions===null||meter===null)return null;
        pending.push([offset,cursor+value]);
        if(qualifying)changes.set(offset,String(value*ticksPerQuarter/divisions));
      }
    }
    if(divisions===null||meter===null||cursor!==4*divisions)return null;
    if(pending.some(([,target])=>target>=cursor))return null; // cross-measure playback offsets
  }
  return changes.size?changes:null;
}

function normalize(xml:string):string|null {
  if(!xml.includes('offset'))return null;
  const doc=new DOMParser().parseFromString(xml,'application/xml'),changes=plan(doc);
  if(!changes)return null;
  for(const [offset,text] of changes)offset.textContent=text;
  return new XMLSerializer().serializeToString(doc);
}

function decode(bytes:Uint8Array){
  try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return null;}
}
function declaredUtf8(xml:string){
  const encoding=/^\s*<\?xml[^>]*\bencoding\s*=\s*["']([^"']+)["']/.exec(xml)?.[1];
  return encoding===undefined||/^utf-?8$/i.test(encoding);
}

function prepareArchive(bytes:Uint8Array,settings:Settings):Uint8Array {
  const limit=settings.importer.maxDecodingBufferSize;let oversized=false;
  const read=(names:Set<string>)=>unzipSync(bytes,{filter:entry=>{
    if(!names.has(entry.name))return false;
    if(entry.originalSize>limit||strToU8(entry.name).length>limit){oversized=true;return false;}
    return true;
  }});
  // Only container metadata and the selected root are decompressed for inspection.
  const metadata=read(new Set(['META-INF/container.xml']))['META-INF/container.xml'];
  if(!metadata||oversized)return bytes;
  const containerXml=decode(metadata);if(containerXml===null)return bytes;
  const container=new DOMParser().parseFromString(containerXml,'application/xml');
  if(container.querySelector('parsererror')||container.documentElement.localName!=='container')return bytes;
  const rootfiles=child(container.documentElement,'rootfiles'),rootfile=rootfiles&&child(rootfiles,'rootfile');
  const path=rootfile?.getAttribute('full-path'),media=rootfile?.getAttribute('media-type');
  if(!path||(media!==null&&media!==undefined&&media!==musicXmlMedia))return bytes;
  const root=read(new Set([path]))[path];if(!root||oversized)return bytes;
  const xml=decode(root);if(xml===null||!declaredUtf8(xml))return bytes;
  const normalized=normalize(xml);if(normalized===null)return bytes;
  const entries=unzipSync(bytes,{filter:entry=>{
    if(entry.originalSize>limit||strToU8(entry.name).length>limit)oversized=true;
    return true;
  }});
  if(oversized)return bytes;
  entries[path]=strToU8(normalized);
  return zipSync(entries);
}

export function prepareMusicXmlTempoOffsets(bytes:Uint8Array,settings:Settings):Uint8Array {
  if(!isUtf8(settings))return bytes;
  try {
    if(bytes[0]===0x50&&bytes[1]===0x4b)return prepareArchive(bytes,settings);
    const start=bytes[0]===0xef&&bytes[1]===0xbb&&bytes[2]===0xbf?3:0;
    let first=start;while(first<bytes.length&&[9,10,13,32].includes(bytes[first]))first++;
    if(bytes[first]!==0x3c)return bytes;
    const xml=decode(bytes);if(xml===null||!declaredUtf8(xml))return bytes;
    const normalized=normalize(xml);
    return normalized===null?bytes:strToU8(normalized);
  } catch {
    return bytes; // malformed input keeps the stock loader's error path
  }
}
