import { model,type Settings } from '@coderline/alphatab';
import { readMusicXmlSource } from './musicxml-tempo-offsets';

// alphaTab 1.8.4 ignores MusicXML <harmonic>. For one narrow single-staff
// tablature domain this restores explicit natural harmonics on the loaded model,
// reading the original source. Any doubt leaves the stock import untouched.
// Frets whose alphaTab natural-harmonic value equals the fret itself.
const harmonicFrets=new Set([4,5,7,9,12,16,17,19,24]);
const measureChildren=new Set(['attributes','note','direction','barline','print','sound','harmony']);
const integer=(value:string|null|undefined)=>{const text=(value??'').trim();return /^\d+$/.test(text)?Number(text):null;};
const children=(node:Element,name?:string)=>[...node.children].filter(child=>!name||child.localName===name);
const child=(node:Element,name:string)=>children(node,name)[0];

type Placement={string:number;fret:number};
type Beat={rest:boolean;notes:(Placement|null)[];harmonics:Placement[]};

// The note's one string/fret placement anywhere in its notations. alphaTab keeps
// the last value it reads, so repeated values are refused, not guessed.
function placement(note:Element):Placement|null|undefined {
  const strings=note.getElementsByTagName('string'),frets=note.getElementsByTagName('fret');
  if(!strings.length&&!frets.length)return null;
  if(strings.length!==1||frets.length!==1)return undefined;
  const string=integer(strings[0].textContent),fret=integer(frets[0].textContent);
  return string!==null&&string>0&&fret!==null?{string,fret}:undefined;
}

function isNaturalHarmonic(note:Element,where:Placement):boolean {
  const harmonic=note.getElementsByTagName('harmonic')[0],technical=harmonic.parentElement;
  if(technical?.localName!=='technical'||technical.parentElement?.localName!=='notations'||technical.parentElement.parentElement!==note)return false;
  const kinds=children(harmonic).map(node=>node.localName).join(' ');
  if(kinds!=='natural'&&kinds!=='natural touching-pitch')return false;
  if(child(note,'tie')||note.getElementsByTagName('tied').length||child(note,'rest'))return false;
  return harmonicFrets.has(where.fret);
}

// The beats of every measure, or null when the score is outside the domain or
// has no harmonic to restore.
function plan(doc:Document):Beat[][]|null {
  const root=doc.documentElement;
  if(doc.querySelector('parsererror')||root.localName!=='score-partwise')return null;
  // Prefixed or namespaced elements are read differently by alphaTab's parser.
  if([root,...root.getElementsByTagName('*')].some(node=>node.prefix!==null||node.namespaceURI!==null))return null;
  const parts=children(root,'part');if(parts.length!==1)return null;
  const measures=children(parts[0]);if(!measures.length||measures.some(measure=>measure.localName!=='measure'))return null;
  const result:Beat[][]=[];let found=false;
  for(const measure of measures){
    const beats:Beat[]=[];
    for(const item of children(measure)){
      if(!measureChildren.has(item.localName))return null;
      if(item.localName==='attributes'&&child(item,'staves')&&integer(child(item,'staves')!.textContent)!==1)return null;
      if(item.localName==='direction'&&[child(item,'staff'),child(item,'voice')].some(node=>node&&node.textContent?.trim()!=='1'))return null;
      if(item.localName!=='note')continue;
      if(child(item,'grace')||child(item,'cue'))return null;
      if([child(item,'voice'),child(item,'staff')].some(node=>node&&node.textContent?.trim()!=='1'))return null;
      const rest=!!child(item,'rest'),where=placement(item);if(where===undefined)return null;
      if(child(item,'chord')){
        // A chord rest gets its own beat in alphaTab, so it cannot join this one.
        if(!beats.length||rest||beats[beats.length-1].rest)return null;
      } else beats.push({rest,notes:[],harmonics:[]});
      const beat=beats[beats.length-1];if(!rest)beat.notes.push(where);
      const count=item.getElementsByTagName('harmonic').length;if(!count)continue;
      if(count!==1||!where||!isNaturalHarmonic(item,where))return null;
      beat.harmonics.push(where);found=true;
    }
    result.push(beats);
  }
  return found?result:null;
}

function apply(score:model.Score,measures:Beat[][]){
  if(score.tracks.length!==1||score.tracks[0].staves.length!==1)return;
  const staff=score.tracks[0].staves[0],strings=staff.tuning.length;
  if(!strings||staff.bars.length!==measures.length||score.masterBars.length!==measures.length)return;
  // MusicXML string 1 is the highest string; alphaTab counts from the lowest.
  const on=(notes:model.Note[],where:Placement)=>where.string<=strings?notes.filter(note=>note.string===strings-where.string+1&&note.fret===where.fret):[];
  const targets:[model.Note,number][]=[];
  for(const [index,beats] of measures.entries()){
    const voices=staff.bars[index].voices;if(voices.length!==1||voices[0].beats.length!==beats.length)return;
    for(const [position,beat] of beats.entries()){
      // Every beat must hold the same notes as its source, not just the same count.
      const notes=voices[0].beats[position].notes;
      if(notes.length!==beat.notes.length||(beat.rest&&!voices[0].beats[position].isRest))return;
      if(beat.notes.some(where=>where&&on(notes,where).length!==1))return;
      for(const where of beat.harmonics){
        const note=on(notes,where)[0];
        if(!note.isStringed||note.harmonicType!==model.HarmonicType.None)return;
        targets.push([note,where.fret]);
      }
    }
  }
  // Every harmonic is mapped before any note changes.
  for(const [note,fret] of targets){note.harmonicType=model.HarmonicType.Natural;note.harmonicValue=fret;}
}

export function applyMusicXmlNaturalHarmonics(score:model.Score,bytes:Uint8Array,settings:Settings):model.Score {
  try {
    const source=readMusicXmlSource(bytes,settings);
    if(!source||!source.xml.includes('harmonic'))return score;
    const measures=plan(new DOMParser().parseFromString(source.xml,'application/xml'));
    if(measures)apply(score,measures);
  } catch {
    // Unreadable sources keep the stock import.
  }
  return score;
}
