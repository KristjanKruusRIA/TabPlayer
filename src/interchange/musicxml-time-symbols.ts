import { type model,type Settings } from '@coderline/alphatab';
import { readMusicXmlSource } from './musicxml-tempo-offsets';

// In MusicXML a time signature, symbol included, stays in force until the next <time>. alphaTab 1.8.4 sets
// timeSignatureCommon only on the measure whose own <time> carries symbol="common" or "cut", so a file with the
// symbol on its first measure loads as [true,false,false,...]. This carries the flag forward over the following
// measures that have no <time> of their own and the same meter, and stops at the next <time>, whatever it holds.
// Only a <time> the importer itself applies counts: it reads attributes before the first note of a measure.
// A project logged before the carry replays over the stock import (palette edits record commonTime per bar), so the
// carry is gated like the file's partial capo (see `appliesFilePartialCapo`) and a carried score is remembered here, so
// the first edit can mark the project.
const carriedScores=new WeakSet<model.Score>();
export const scoreHasMusicXmlTimeCarry=(score:model.Score)=>carriedScores.has(score);
export function copyMusicXmlTimeCarry(source:model.Score,destination:model.Score):void {if(carriedScores.has(source))carriedScores.add(destination);}
const children=(node:Element,name?:string)=>[...node.children].filter(child=>!name||child.localName===name);

/** For each measure of one part: whether it has a <time> the importer applies, and whether one of them carries a symbol. */
function timesOf(part:Element):{own:boolean;symbol:boolean}[] {
  return children(part,'measure').map(measure=>{
    let started=false,own=false,symbol=false;
    for(const item of children(measure)){
      if(item.localName==='note'){if(!children(item,'cue').length)started=true;}
      else if(item.localName==='attributes'&&!started){
        for(const time of children(item,'time')){
          own=true;
          const kind=time.getAttribute('symbol');if(kind==='common'||kind==='cut')symbol=true;
        }
      }
    }
    return {own,symbol};
  });
}

export function applyMusicXmlTimeSymbols(score:model.Score,bytes:Uint8Array,settings:Settings):model.Score {
  try {
    // A carry starts only from a measure the importer itself flagged, and the file is parsed only if a <time> really holds the symbol.
    if(!score.masterBars.some(bar=>bar.timeSignatureCommon))return score;
    const source=readMusicXmlSource(bytes,settings);
    if(!source||!/<time\b[^>]*\bsymbol\s*=\s*(["'])(?:common|cut)\1/.test(source.xml))return score;
    // alphaTab's parser expands only the predefined and decimal entities, so the DOM could see other text for any other
    // entity. A character reference (decimal or hex) is text and cannot make markup. CDATA matters only inside a part, where
    // alphaTab reads it as an element and the DOM as text.
    if(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(source.xml))return score;
    const firstPart=source.xml.search(/<part[\s>]/);
    if(firstPart>=0&&source.xml.indexOf('<![CDATA[',firstPart)>=0)return score;
    const doc=new DOMParser().parseFromString(source.xml,'application/xml'),root=doc.documentElement;
    if(doc.querySelector('parsererror')||root.localName!=='score-partwise')return score;
    if([root,...root.getElementsByTagName('*')].some(node=>node.prefix!==null||node.namespaceURI!==null))return score;
    // Every part's attributes reach the same master bar: the measure has an own time if any part gives one, a symbol if any gives one.
    const own:boolean[]=[],symbol:boolean[]=[];
    for(const part of children(root,'part'))timesOf(part).forEach((time,index)=>{
      if(index>=score.masterBars.length)return;
      own[index]=own[index]||time.own;symbol[index]=symbol[index]||time.symbol;
    });
    const flags=score.masterBars.map(bar=>bar.timeSignatureCommon);
    let carried:{numerator:number;denominator:number}|null=null;
    score.masterBars.forEach((bar,index)=>{
      if(own[index]||index===0){
        carried=symbol[index]&&bar.timeSignatureCommon?{numerator:bar.timeSignatureNumerator,denominator:bar.timeSignatureDenominator}:null;
      }else if(carried&&bar.timeSignatureNumerator===carried.numerator&&bar.timeSignatureDenominator===carried.denominator){
        flags[index]=true;
      }else carried=null;
    });
    score.masterBars.forEach((bar,index)=>{
      if(bar.timeSignatureCommon!==flags[index]){bar.timeSignatureCommon=flags[index];carriedScores.add(score);}
    });
  } catch {
    return score; // unreadable sources keep the stock import
  }
  return score;
}
