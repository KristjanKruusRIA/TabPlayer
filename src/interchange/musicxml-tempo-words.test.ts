// @vitest-environment jsdom
import { describe,expect,it } from 'vitest';
import { importer,model,Settings } from '@coderline/alphatab';
import { strToU8 } from 'fflate';
import { loadInterchangeScore } from './gp';
import { applyMusicXmlTempoWords } from './musicxml-tempo-words';

const settings=new Settings();
const note=(step='C')=>`<note><pitch><step>${step}</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type></note>`;
const words=(text:string)=>`<direction placement="above"><direction-type><words>${text}</words></direction-type></direction>`;
const metronome=(perMinute:number,unit='quarter')=>`<direction-type><metronome><beat-unit>${unit}</beat-unit><per-minute>${perMinute}</per-minute></metronome></direction-type>`;
const tempo=(text:string,value:number)=>`<direction placement="above"><direction-type><words>${text}</words></direction-type>${metronome(value)}<sound tempo="${value}"/></direction>`;
const attributes='<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>';
const musicXml=(...measures:string[])=>`<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">${measures.map((content,index)=>`<measure number="${index+1}">${index===0?attributes:''}${content}</measure>`).join('')}</part></score-partwise>`;
const load=(xml:string)=>loadInterchangeScore(strToU8(xml),settings);
const texts=(score:model.Score)=>score.tracks[0].staves[0].bars.map(bar=>bar.voices[0].beats.map(beat=>beat.text??null));
const tempos=(score:model.Score)=>score.masterBars.map(bar=>bar.tempoAutomations.map(a=>[a.value,a.text]));

describe('MusicXML tempo words',()=>{
  it('moves the words of a tempo direction onto its tempo',()=>{
    const score=load(musicXml(tempo('Andante',80)+note()+note()+note()+note()));
    expect(tempos(score)).toEqual([[[80,'Andante']]]);
    expect(texts(score)).toEqual([[null,null,null,null]]);
  });

  it('reads a words + metronome direction without a sound tempo',()=>{
    const score=load(musicXml(`<direction><direction-type><words>Lento</words></direction-type>${metronome(60)}</direction>`+note()+note()+note()+note()));
    expect(tempos(score)).toEqual([[[60,'Lento']]]);
    expect(texts(score)).toEqual([[null,null,null,null]]);
  });

  it('keeps plain words as beat text',()=>{
    const score=load(musicXml(tempo('Andante',80)+note()+words('rit.')+note()+note()+note()));
    expect(tempos(score)).toEqual([[[80,'Andante']]]);
    expect(texts(score)).toEqual([[null,'rit.',null,null]]);
  });

  it('moves words that reach the beat of the next measure',()=>{
    const score=load(musicXml(note()+note()+note()+note()+tempo('Presto',160),note()+note()+note()+note()));
    expect(tempos(score).map(bar=>bar.map(([,text])=>text))).toEqual([['Presto',''],[]]);
    expect(texts(score)).toEqual([[null,null,null,null],[null,null,null,null]]);
  });

  it('leaves a beat text that a later plain words direction replaced',()=>{
    // alphaTab keeps only the last pending words; the tempo still gets its own text.
    const score=load(musicXml(tempo('Andante',80)+words('dolce')+note()+note()+note()+note()));
    expect(tempos(score)).toEqual([[[80,'Andante']]]);
    expect(texts(score)).toEqual([['dolce',null,null,null]]);
  });

  it('leaves the stock import when the beat text is ambiguous',()=>{
    const xml=musicXml(tempo('Andante',80)+note()+words('Andante')+note()+note()+note());
    const score=load(xml);
    expect(texts(score)).toEqual([['Andante','Andante',null,null]]);
    expect(tempos(score)).toEqual([[[80,'']]]);
  });

  it('follows the dashes that drop the pending words',()=>{
    const dashes=(text:string,sound='')=>`<direction><direction-type><words>${text}</words></direction-type><direction-type><dashes type="start"/></direction-type>${sound}</direction>`;
    const plain=load(musicXml(words('rit.')+dashes('rit.','<sound tempo="70"/>')+note()+note()+note()+note()));
    expect(tempos(plain)).toEqual([[[70,'']]]);
    expect(texts(plain)).toEqual([['rit.',null,null,null]]);
    const letRing=load(musicXml(tempo('Moderate Rock',110)+dashes('LetRing')+note()+note()+note()+note()));
    expect(tempos(letRing)).toEqual([[[110,'Moderate Rock']]]);
    expect(texts(letRing)).toEqual([[null,null,null,null]]);
  });

  it('leaves the stock import for two sound tempos in one direction',()=>{
    const score=load(musicXml(`<direction><direction-type><words>Allegro</words></direction-type><sound tempo="80"/><sound tempo="120"/></direction>`+note()+note()+note()+note()));
    expect(tempos(score).flat().map(([,text])=>text)).not.toContain('Allegro');
    expect(texts(score)[0][0]).toBe('Allegro');
  });

  it('reads trimmed words and skips whitespace words',()=>{
    const score=load(musicXml(`<direction><direction-type><words>
  Allegro </words></direction-type><sound tempo="120"/></direction>`+words(' ')+note()+note()+note()+note()));
    expect(tempos(score)).toEqual([[[120,'Allegro']]]);
    expect(texts(score)).toEqual([[null,null,null,null]]);
  });

  it('counts a chord on the first note of a measure as a new beat',()=>{
    const chord=note().replace('<pitch>','<chord/><pitch>');
    const score=load(musicXml(tempo('Moderato',120)+chord+words('mix')+note()+note()+note()));
    expect(tempos(score)).toEqual([[[120,'Moderato']]]);
    expect(texts(score)).toEqual([[null,'mix',null,null]]);
  });

  it('follows words that reach the next part',()=>{
    const part=(id:string,content:string)=>`<part id="${id}"><measure number="1">${attributes}${content}</measure></part>`;
    const list='<part-list><score-part id="P1"><part-name>A</part-name></score-part><score-part id="P2"><part-name>B</part-name></score-part></part-list>';
    const score=load(`<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0">${list}${part('P1',note()+note()+note()+note()+tempo('Fine',60))}${part('P2',note()+note()+note()+note())}</score-partwise>`);
    expect(tempos(score)[0].map(([,text])=>text)).toContain('Fine');
    expect(score.tracks.map(track=>track.staves[0].bars[0].voices[0].beats.map(beat=>beat.text??null))).toEqual([[null,null,null,null],[null,null,null,null]]);
  });

  it('leaves the stock import for a namespaced document',()=>{
    const prefixed=tempo('Allegro',120).replace('<direction ','<x:direction xmlns:x="urn:x" ').replace(/<\/direction>$/,'</x:direction>');
    const xml=strToU8(musicXml(tempo('Andante',80)+note()+note()+prefixed+words('dolce')+note()+note()));
    const score=loadInterchangeScore(xml,settings),stock=importer.ScoreLoader.loadScoreFromBytes(xml,settings);
    expect(tempos(score)).toEqual(tempos(stock));
    expect(texts(score)).toEqual(texts(stock));
  });

  // P1 ends on a 'Ghost' tempo, P2 has the same tempo without words, then 'dolce'.
  const twoParts=(listed:string,first:string,second:string,early=false)=>{
    const part=(id:string,content:string)=>`<part id="${id}"><measure number="1">${attributes}${content}</measure></part>`;
    const list=`<part-list><score-part id="${listed}"><part-name>A</part-name></score-part><score-part id="${second}"><part-name>B</part-name></score-part></part-list>`;
    const one=part(first,note()+note()+note()+note()+tempo('Ghost',120)),two=part(second,tempoOnly('120')+words('dolce')+note()+note()+note()+note());
    return `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0">${early?one+list:list+one}${two}</score-partwise>`;
  };
  const tempoOnly=(value:string)=>`<direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${value}</per-minute></metronome></direction-type><sound tempo="${value}"/></direction>`;
  it.each([
    ['CDATA in a direction-type',musicXml(words('rit.')+'<direction><direction-type><words>rit.</words><![CDATA[ ]]></direction-type><sound tempo="70"/></direction>'+note()+note()+note()+note())],
    ['a hex character reference',musicXml(tempoOnly('80')+note()+note()+'<direction><direction-type><words>Allegro</words></direction-type><sound tempo="&#x38;0"/></direction>'+note()+note())],
    ['a part before the part-list',twoParts('P1','P1','P2',true)],
    ['whitespace in a part id',twoParts('P	1','P 1','P2')],
  ])('leaves the stock import for %s',(_name,text)=>{
    const xml=strToU8(text),score=loadInterchangeScore(xml,settings),stock=importer.ScoreLoader.loadScoreFromBytes(xml,settings);
    expect(tempos(score)).toEqual(tempos(stock));
    expect(score.tracks.map(track=>track.staves[0].bars.map(bar=>bar.voices[0].beats.map(beat=>beat.text??null)))).toEqual(stock.tracks.map(track=>track.staves[0].bars.map(bar=>bar.voices[0].beats.map(beat=>beat.text??null))));
  });

  it('ignores sources without tempo words',()=>{
    const xml=musicXml(note()+note()+note()+note());
    const score=load(xml);
    expect(applyMusicXmlTempoWords(score,strToU8(xml),settings)).toBe(score);
  });
});
