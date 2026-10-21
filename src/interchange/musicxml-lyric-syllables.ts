import { type model,type Settings } from '@coderline/alphatab';
import { readMusicXmlSource } from './musicxml-tempo-offsets';

// alphaTab 1.8.4 reads <lyric> text but ignores <syllabic>, so words lose the
// trailing hyphen TabPlayer's lyrics use to join syllables. Where every lyric of a
// part sits in one staff and voice and its texts match the loaded syllables in
// order, begin and middle syllables get their hyphen back. Each line is matched on
// its own; any doubt leaves that line's stock import untouched.
const children=(node:Element,name?:string)=>[...node.children].filter(child=>!name||child.localName===name);
const child=(node:Element,name:string)=>children(node,name)[0];
type Syllable={line:number;text:string;joined:boolean};

// The part's lyrics in document order, with alphaTab's first-appearance line indices.
function syllables(part:Element):Syllable[]|null {
  const lines=new Map<string,number>(),result:Syllable[]=[];let lane:string|null=null;
  for(const measure of children(part,'measure'))for(const note of children(measure,'note')){
    const lyrics=children(note,'lyric');if(!lyrics.length)continue;
    if(child(note,'cue'))return null;
    const where=`${child(note,'staff')?.textContent?.trim()??'1'}/${child(note,'voice')?.textContent?.trim()??'1'}`;
    if(lane!==null&&lane!==where)return null;lane=where;
    const seen=new Set<number>();
    for(const lyric of lyrics){
      // alphaTab joins repeated texts and elisions, so only one plain text is mapped.
      if(children(lyric).some(node=>!['syllabic','text','extend'].includes(node.localName))||children(lyric,'text').length!==1||children(lyric,'syllabic').length>1)return null;
      const number=lyric.getAttribute('number')??'';
      if(!lines.has(number))lines.set(number,lines.size);
      const line=lines.get(number)!;if(seen.has(line))return null;seen.add(line);
      const syllabic=child(lyric,'syllabic')?.textContent?.trim();
      // alphaTab trims the text it reads.
      result.push({line,text:(child(lyric,'text')!.textContent??'').trim(),joined:syllabic==='begin'||syllabic==='middle'});
    }
  }
  return result;
}

export function applyMusicXmlLyricSyllables(score:model.Score,bytes:Uint8Array,settings:Settings):model.Score {
  try {
    const source=readMusicXmlSource(bytes,settings);
    if(!source||!source.xml.includes('<syllabic'))return score;
    const doc=new DOMParser().parseFromString(source.xml,'application/xml'),root=doc.documentElement;
    if(doc.querySelector('parsererror')||root.localName!=='score-partwise')return score;
    // alphaTab creates tracks in part-list order, so parts are matched by their id.
    const list=root.querySelector(':scope > part-list');if(!list)return score;
    const ids=children(list,'score-part').map(part=>part.getAttribute('id')),parts=children(root,'part');
    if(ids.length!==score.tracks.length||parts.length!==ids.length||new Set(ids).size!==ids.length)return score;
    const changes:[model.Beat,number][]=[];
    for(const part of parts){
      const index=ids.indexOf(part.getAttribute('id'));if(index<0)return score;
      const sung=syllables(part);if(!sung)continue;
      const beats=score.tracks[index].staves.flatMap(staff=>staff.bars.flatMap(bar=>bar.voices.flatMap(voice=>voice.beats)));
      for(const line of new Set(sung.map(syllable=>syllable.line))){
        const source=sung.filter(syllable=>syllable.line===line&&syllable.text),loaded=beats.filter(beat=>beat.lyrics?.[line]);
        if(source.length!==loaded.length||source.some((syllable,at)=>syllable.text!==loaded[at].lyrics![line]))continue;
        // A syllable whose text already ends in '-' keeps a single hyphen.
        source.forEach((syllable,at)=>{if(syllable.joined&&!loaded[at].lyrics![line].endsWith('-'))changes.push([loaded[at],line]);});
      }
    }
    // Every part is mapped before any syllable changes.
    for(const [beat,line]of changes)beat.lyrics![line]+='-';
  } catch {
    // Unreadable sources keep the stock import.
  }
  return score;
}
