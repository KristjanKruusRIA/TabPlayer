// @vitest-environment jsdom
import { createHash } from 'node:crypto';
import { describe,expect,it } from 'vitest';
import { model,Settings } from '@coderline/alphatab';
import { strFromU8,strToU8,unzipSync,zipSync } from 'fflate';
import { buildScore,previewEdit,trackIdentity } from '../engine';
import { blankProject } from '../project';
import { exportMidi } from '../export/midi';
import { buildPlaybackPlan,buildPlaybackPlanFromJson } from '../audio/plan';
import { prepareMusicXmlTempoOffsets } from './musicxml-tempo-offsets';

const settings=new Settings();
type Options={offset?:string;sound?:string|null;nested?:boolean;extra?:string;notes?:string[];title?:string;measureTail?:string};
// Authored one-bar MusicXML 4.0: 120 BPM at the start, 60 BPM after the first quarter.
function musicXml(d:number,{offset=String(d),sound='yes',nested=false,extra='',notes=['C','D','E','F'],title='Offset study',measureTail=''}:Options={}){
  const quarter=(step:string)=>`<note><pitch><step>${step}</step><octave>4</octave></pitch><duration>${d}</duration><voice>1</voice><type>quarter</type></note>`;
  const flag=sound===null?'':` sound="${sound}"`;
  const offsetElement=offset===''?'':`<offset${flag}>${offset}</offset>`;
  const slow=`<direction placement="above"><direction-type><words>Slower</words></direction-type>${offsetElement}<sound tempo="60">${nested?`<offset>${d}</offset>`:''}</sound></direction>`;
  return `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><work><work-title>${title}</work-title></work><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>${d}</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes><direction placement="above"><direction-type><words>Moderato</words></direction-type><sound tempo="120"/></direction>${quarter(notes[0])}${slow}${notes.slice(1).map(quarter).join('')}${extra}${measureTail}</measure></part></score-partwise>`;
}
const container=`<?xml version="1.0" encoding="UTF-8"?><container><rootfiles><rootfile full-path="scores/main.musicxml" media-type="application/vnd.recordare.musicxml+xml"/><rootfile full-path="scores/alternate.pdf" media-type="application/pdf"/></rootfiles></container>`;
const opaque=new Uint8Array([0,255,1,254,80,75,3,4]);
function mxl(main:string,d:number,containerXml=container){
  return zipSync({
    'mimetype':strToU8('application/vnd.recordare.musicxml'),
    // An earlier, musically distinct qualifying document must not be selected.
    'decoy.xml':strToU8(musicXml(d,{notes:['G','A','B','C'],title:'Decoy'})),
    'META-INF/container.xml':strToU8(containerXml),
    'scores/main.musicxml':strToU8(main),
    'scores/alternate.pdf':strToU8('%PDF-1.4 alternate rendition'),
    'media/opaque.bin':opaque,
  });
}
const encode=(kind:'xml'|'mxl',d:number,options?:Options)=>kind==='xml'?strToU8(musicXml(d,options)):mxl(musicXml(d,options),d);
function project(bytes:Uint8Array,kind:string){
  const base={kind:'file' as const,filename:`offset.${kind}`,bytesBase64:Buffer.from(bytes).toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')};
  return {...blankProject(),base};
}
// Independent Standard MIDI byte decoder; it does not use alphaTab's reader.
function smf(bytes:Uint8Array){
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let p=0;
  const ascii=(n:number)=>String.fromCharCode(...bytes.slice(p,p+=n));
  const u32=()=>{const n=view.getUint32(p);p+=4;return n;},u16=()=>{const n=view.getUint16(p);p+=2;return n;};
  const variable=()=>{let v=0,n=0;do{n=bytes[p++];v=v*128+(n&127);}while(n&128);return v;};
  expect(ascii(4)).toBe('MThd');expect(u32()).toBe(6);u16();const tracks=u16();expect(u16()).toBe(960);
  const tempos:[number,number][]=[],attacks:number[]=[],releases:number[]=[];let end=0;
  for(let track=0;track<tracks;track++){
    expect(ascii(4)).toBe('MTrk');const stop=p+4+view.getUint32(p);p+=4;let tick=0,status=0;
    while(p<stop){tick+=variable();let type=bytes[p++];if(type<128){p--;type=status;}else if(type<240)status=type;
      if(type===255){const meta=bytes[p++],len=variable(),data=bytes.slice(p,p+=len);if(meta===81)tempos.push([tick,(data[0]<<16)|(data[1]<<8)|data[2]]);if(meta===47)end=Math.max(end,tick);}
      else if(type===240||type===247)p+=variable();
      else{const kind=type&240,n=kind===192||kind===208?1:2,data=bytes.slice(p,p+=n);if(kind===144&&data[1]>0)attacks.push(tick);else if(kind===128||kind===144)releases.push(tick);}
    }
  }
  expect(p).toBe(bytes.length);return {tempos,attacks:attacks.sort((a,b)=>a-b),releases:releases.sort((a,b)=>a-b),end};
}
const slowTempo=(score:model.Score)=>score.masterBars[0].tempoAutomations.find(a=>a.value===60)!;
function timing(score:model.Score){
  const bar=score.masterBars[0],slow=slowTempo(score);
  return {ratio:slow.ratioPosition,tick:slow.ratioPosition*bar.calculateDuration(),midi:smf(exportMidi(score,{tracks:[0],range:null})),
    direct:buildPlaybackPlan(score,1).durationMs,json:buildPlaybackPlanFromJson(model.JsonConverter.scoreToJson(score),score.tracks.map(trackIdentity),1).durationMs};
}
const pitches=(score:model.Score)=>score.tracks[0].staves[0].bars[0].voices[0].beats.map(beat=>beat.notes[0]?.realValue);

describe('MusicXML playback tempo offsets',()=>{
  describe.each([1,4,8])('divisions %i',d=>{
    it.each(['xml','mxl'] as const)('places the explicit playback offset at the second beat in %s',kind=>{
      const bytes=encode(kind,d),copy=bytes.slice(),value=project(bytes,kind),base=structuredClone(value.base),score=buildScore(value);
      expect(pitches(score)).toEqual([60,62,64,65]);
      const result=timing(score);
      expect(result.ratio).toBe(.5);expect(result.tick).toBe(1920);
      expect(result.midi.tempos).toEqual([[0,500000],[1920,1000000]]);
      expect(result.midi.attacks).toEqual([0,960,1920,2880]);
      expect(result.midi.releases).toEqual([960,1920,2880,3840]);
      expect(result.midi.end).toBe(3840);
      expect(result.direct).toBe(3000);expect(result.json).toBe(3000);
      // The loader shim never replaces the authoritative source.
      expect(bytes).toEqual(copy);expect(value.base).toEqual(base);
      expect(createHash('sha256').update(Buffer.from(value.base.bytesBase64,'base64')).digest('hex')).toBe(base.sha256);
      // Edits and JSON replay rebuild from the original bytes, without compounding the conversion.
      const changed=previewEdit(value,{type:'setPitchedNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},noteIndex:0,pitch:62});
      expect(changed.project.base).toEqual(base);
      const replayed=buildScore(JSON.parse(JSON.stringify(changed.project)));
      expect(pitches(replayed)).toEqual([62,62,64,65]);
      expect(timing(replayed).midi).toEqual(result.midi);expect(timing(buildScore(value)).midi).toEqual(result.midi);
      expect(timing(replayed).json).toBe(3000);
    });
    it.each(['xml','mxl'] as const)('keeps a direction without an offset at the first beat in %s',kind=>{
      const result=timing(buildScore(project(encode(kind,d,{offset:''}),kind)));
      expect(result.tick).toBe(960);expect(result.midi.tempos).toEqual([[0,500000],[960,1000000]]);
      expect(result.midi.attacks).toEqual([0,960,1920,2880]);expect(result.direct).toBe(3500);
    });
  });

  it('changes only the selected MXL root content and keeps every sibling exact',()=>{
    const original=mxl(musicXml(4),4),copy=original.slice(),prepared=prepareMusicXmlTempoOffsets(original,settings);
    expect(prepared).not.toBe(original);expect(original).toEqual(copy);
    const before=unzipSync(original),after=unzipSync(prepared);
    expect(Object.keys(after)).toEqual(Object.keys(before));
    for(const name of Object.keys(before))if(name!=='scores/main.musicxml')expect(after[name]).toEqual(before[name]);
    expect(after['media/opaque.bin']).toEqual(opaque);
    const root=new DOMParser().parseFromString(strFromU8(after['scores/main.musicxml']),'application/xml');
    expect([...root.querySelectorAll('direction > offset')].map(node=>node.textContent)).toEqual(['960']);
    expect(prepareMusicXmlTempoOffsets(original,settings)).toEqual(prepared);
  });

  it('converts plain XML deterministically and only in the qualifying offset',()=>{
    const original=strToU8(musicXml(8)),prepared=prepareMusicXmlTempoOffsets(original,settings);
    const before=new DOMParser().parseFromString(strFromU8(original),'application/xml'),after=new DOMParser().parseFromString(strFromU8(prepared),'application/xml');
    expect(after.querySelector('direction > offset')!.textContent).toBe('960');
    after.querySelector('direction > offset')!.textContent='8';
    expect(new XMLSerializer().serializeToString(after)).toBe(new XMLSerializer().serializeToString(before));
    expect(prepareMusicXmlTempoOffsets(original,settings)).toEqual(prepared);
  });

  it('converts a document carrying the standard partwise DOCTYPE',()=>{
    const text=musicXml(4).replace('<score-partwise','<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd"><score-partwise');
    expect(timing(buildScore(project(strToU8(text),'musicxml'))).tick).toBe(1920);
  });

  const unchanged:[string,string][]=[
    ['absent playback flag',musicXml(4,{sound:null})],
    ['explicit no playback flag',musicXml(4,{sound:'no'})],
    ['zero offset',musicXml(4,{offset:'0'})],
    ['negative offset',musicXml(4,{offset:'-2'})],
    ['offset reaching the next measure',musicXml(4,{offset:'12'})],
    ['nested sound offset',musicXml(4,{nested:true})],
    ['metronome direction',musicXml(4).replace('<words>Slower</words>','<metronome><beat-unit>quarter</beat-unit><per-minute>60</per-minute></metronome>')],
    ['second voice',musicXml(4,{extra:'<backup><duration>16</duration></backup><note><rest/><duration>16</duration><voice>2</voice></note>'})],
    ['note in another voice',musicXml(4).replace('<step>F</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice>','<step>F</step><octave>4</octave></pitch><duration>4</duration><voice>2</voice>')],
    ['chord note',musicXml(4,{extra:'<note><chord/><pitch><step>A</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice></note>'})],
    ['grace note',musicXml(4,{extra:'<note><grace/><pitch><step>A</step><octave>4</octave></pitch><voice>1</voice></note>'})],
    ['tuplet timing',musicXml(4).replace('<duration>4</duration><voice>1</voice><type>quarter</type></note>','<duration>4</duration><voice>1</voice><type>quarter</type><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification></note>')],
    ['incomplete bar',musicXml(4,{notes:['C','D','E','F']}).replace(/<note><pitch><step>F<\/step>.*?<\/note>/,'')],
    ['missing divisions',musicXml(4).replace('<divisions>4</divisions>','')],
    ['two parts',musicXml(4).replace('</part></score-partwise>','</part><part id="P2"><measure number="1"><note><rest/><duration>16</duration></note></measure></part></score-partwise>')],
    ['two staves',musicXml(4).replace('<clef>','<staves>2</staves><clef>')],
    ['changed divisions',musicXml(4).replace('</measure></part>','</measure><measure number="2"><attributes><divisions>8</divisions></attributes><note><rest/><duration>32</duration></note></measure></part>')],
    ['changed meter',musicXml(4).replace('</measure></part>','</measure><measure number="2"><attributes><time><beats>3</beats><beat-type>4</beat-type></time></attributes><note><rest/><duration>12</duration></note></measure></part>')],
    ['repeat routing',musicXml(4,{measureTail:'<barline location="right"><repeat direction="backward"/></barline>'})],
    ['jump routing',musicXml(4).replace('<sound tempo="120"/>','<sound tempo="120" segno="s1"/>')],
    ['timewise root',musicXml(4).replace(/score-partwise/g,'score-timewise')],
    ['nested sound offset in another direction',musicXml(4,{extra:'<direction><direction-type><words>Later</words></direction-type><sound dynamics="80"><offset>2</offset></sound></direction>'})],
    ['negative unflagged offset elsewhere',musicXml(4,{extra:'<direction><direction-type><words>Earlier</words></direction-type><offset>-2</offset></direction>'})],
    ['cross-measure unflagged offset elsewhere',musicXml(4,{extra:'<direction><direction-type><words>Later</words></direction-type><offset>1</offset></direction>'})],
    ['non-decimal offset text',musicXml(4,{offset:'0x4'})],
    ['offset markup inside a comment',musicXml(4,{extra:'<!-- <offset sound="yes">4</offset> -->'})],
    // Comment and CDATA hide offsets from different parsers; the counts and texts still agree.
    ['comment and CDATA offsets that would misalign the splice',musicXml(4,{offset:'<![CDATA[4]]>'}).replace('</measure></part>','</measure><measure number="2"><direction><direction-type><words>Later</words></direction-type><offset>4</offset><sound tempo="90"/></direction><!-- <offset>4</offset> --><note><rest/><duration>16</duration></note></measure></part>')],
  ];
  it.each(unchanged)('returns the same input for %s',(_,text)=>{
    expect(new DOMParser().parseFromString(text,'application/xml').querySelector('parsererror')).toBeNull();
    const xml=strToU8(text);expect(prepareMusicXmlTempoOffsets(xml,settings)).toBe(xml);
    const zipped=mxl(text,4);expect(prepareMusicXmlTempoOffsets(zipped,settings)).toBe(zipped);
  });

  it('keeps legacy timing for an unconverted absent flag',()=>{
    expect(timing(buildScore(project(strToU8(musicXml(4,{sound:null})),'xml'))).tick).toBe(964);
  });

  it('inherits unchanged divisions and meter in later measures',()=>{
    const text=musicXml(4).replace('</measure></part>','</measure><measure number="2"><attributes><divisions>4</divisions></attributes><note><rest/><duration>16</duration></note></measure></part>');
    const score=buildScore(project(strToU8(text),'xml'));
    expect(timing(score).tick).toBe(1920);
  });

  it.each([
    ['no rootfile','<container><rootfiles/></container>'],
    ['missing root member','<container><rootfiles><rootfile full-path="scores/missing.musicxml"/></rootfiles></container>'],
    ['non-MusicXML first rootfile','<container><rootfiles><rootfile full-path="scores/alternate.pdf" media-type="application/pdf"/><rootfile full-path="scores/main.musicxml"/></rootfiles></container>'],
    ['malformed container','<container><rootfiles>'],
  ])('returns the same MXL input for %s',(_,containerXml)=>{
    const zipped=mxl(musicXml(4),4,containerXml);expect(prepareMusicXmlTempoOffsets(zipped,settings)).toBe(zipped);
  });

  it('accepts a first rootfile without a media type',()=>{
    const zipped=mxl(musicXml(4),4,'<container><rootfiles><rootfile full-path="scores/main.musicxml"/></rootfiles></container>');
    expect(timing(buildScore(project(zipped,'mxl'))).tick).toBe(1920);
  });

  it('changes only the offset text and keeps every other source character',()=>{
    const original=musicXml(4,{title:'A&#x42;C &amp; D'}).replace('placement="above"','placement="above" id="a&#10;b"');
    const prepared=strFromU8(prepareMusicXmlTempoOffsets(strToU8(original),settings));
    expect(prepared).toBe(original.replace('<offset sound="yes">4</offset>','<offset sound="yes">960</offset>'));
  });

  it('returns the same MXL input for a duplicate root entry name',()=>{
    const bytes=zipSync({'META-INF/container.xml':strToU8(container),'scores/main.musicxml':strToU8(musicXml(4,{title:'First'})),'scores/main.musicxmX':strToU8(musicXml(4,{title:'Second'}))});
    const name=strToU8('scores/main.musicxmX');
    for(let i=0;i<=bytes.length-name.length;i++)if(name.every((byte,j)=>bytes[i+j]===byte))bytes[i+name.length-1]=0x6c;
    expect(prepareMusicXmlTempoOffsets(bytes,settings)).toBe(bytes);
  });

  it('returns the same MXL input when a sibling exceeds the decoding limit',()=>{
    const limited=new Settings();limited.importer.maxDecodingBufferSize=100000;
    const bytes=zipSync({'META-INF/container.xml':strToU8(container),'scores/main.musicxml':strToU8(musicXml(4)),'media/large.bin':new Uint8Array(200000)});
    expect(prepareMusicXmlTempoOffsets(bytes,limited)).toBe(bytes);
  });

  it('returns the same input for binary, GP archives, oversized roots and malformed XML',()=>{
    const gp=zipSync({'Content/score.gpif':strToU8('<GPIF/>'),'Content/offset.xml':strToU8(musicXml(4))});
    const limited=new Settings();limited.importer.maxDecodingBufferSize=64;
    for(const [bytes,options] of [[new Uint8Array([24,70,73,67,72,73,69,82]),settings],[gp,settings],[mxl(musicXml(4),4),limited],[strToU8('<score-partwise><offset sound="yes">'),settings],[new Uint8Array([80,75,3,4,1,2]),settings]] as const)
      expect(prepareMusicXmlTempoOffsets(bytes,options)).toBe(bytes);
    expect(()=>buildScore(project(strToU8('<score-partwise><offset sound="yes">'),'xml'))).toThrow();
  });
});
