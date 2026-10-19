// @vitest-environment jsdom
import { createHash } from 'node:crypto';
import { describe,expect,it } from 'vitest';
import { exporter,importer,model,Settings } from '@coderline/alphatab';
import { strToU8,unzipSync,zipSync } from 'fflate';
import { buildScore,previewEdit,trackIdentity } from '../engine';
import { blankProject } from '../project';
import { exportMidi } from '../export/midi';
import { buildPlaybackPlan,buildPlaybackPlanFromJson } from '../audio/plan';
import { loadInterchangeScore } from './gp';
import { applyMusicXmlNaturalHarmonics } from './musicxml-natural-harmonics';

const settings=new Settings();
const natural='<harmonic><natural/></harmonic>';
type Note={fret:number;harmonic?:string;extra?:string;technical?:string};
// Authored one-bar six-string TAB part: three natural harmonics on the low E
// string at frets 12/7/5, then a plain fret 3.
const fixture:Note[]=[{fret:12,harmonic:natural},{fret:7,harmonic:natural},{fret:5,harmonic:natural},{fret:3}];
const tuning=[['E',2],['A',2],['D',3],['G',3],['B',3],['E',4]].map(([step,octave],index)=>`<staff-tuning line="${index+1}"><tuning-step>${step}</tuning-step><tuning-octave>${octave}</tuning-octave></staff-tuning>`).join('');
const note=({fret,harmonic='',extra='',technical=''}:Note)=>`<note><pitch><step>E</step><octave>3</octave></pitch><duration>1</duration>${extra}<voice>1</voice><type>quarter</type><notations><technical>${harmonic}<string>6</string><fret>${fret}</fret>${technical}</technical></notations></note>`;
function musicXml(notes:Note[]=fixture,{title='Harmonic study',tail=''}={}){
  return `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><work><work-title>${title}</work-title></work><part-list><score-part id="P1"><part-name>Guitar</part-name><score-instrument id="P1-I1"><instrument-name>Guitar</instrument-name></score-instrument><midi-instrument id="P1-I1"><midi-program>26</midi-program></midi-instrument></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>TAB</sign><line>5</line></clef><staff-details><staff-lines>6</staff-lines>${tuning}</staff-details></attributes><direction><direction-type><words>Moderato</words></direction-type><sound tempo="120"/></direction>${notes.map(note).join('')}${tail}</measure></part></score-partwise>`;
}
const container=`<?xml version="1.0" encoding="UTF-8"?><container><rootfiles><rootfile full-path="scores/main.musicxml" media-type="application/vnd.recordare.musicxml+xml"/><rootfile full-path="scores/alternate.pdf" media-type="application/pdf"/></rootfiles></container>`;
function mxl(main:string,decoy=musicXml(fixture.map(note=>({fret:note.fret})),{title:'Decoy'})){
  return zipSync({
    'mimetype':strToU8('application/vnd.recordare.musicxml'),
    // An earlier, musically distinct XML member must not be selected.
    'decoy.xml':strToU8(decoy),
    'META-INF/container.xml':strToU8(container),
    'scores/main.musicxml':strToU8(main),
    'scores/alternate.pdf':strToU8('%PDF-1.4 alternate rendition'),
    'media/opaque.bin':new Uint8Array([0,255,1,254,80,75,3,4]),
  });
}
const encode=(kind:'xml'|'mxl',xml=musicXml())=>kind==='xml'?strToU8(xml):mxl(xml);
function project(bytes:Uint8Array,kind:string){
  const base={kind:'file' as const,filename:`harmonics.${kind}`,bytesBase64:Buffer.from(bytes).toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')};
  return {...blankProject(),base};
}
// Independent Standard MIDI byte decoder; it does not use alphaTab's reader.
function smfAttacks(bytes:Uint8Array){
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let p=0;
  const ascii=(n:number)=>String.fromCharCode(...bytes.slice(p,p+=n));
  const u32=()=>{const n=view.getUint32(p);p+=4;return n;},u16=()=>{const n=view.getUint16(p);p+=2;return n;};
  const variable=()=>{let v=0,n=0;do{n=bytes[p++];v=v*128+(n&127);}while(n&128);return v;};
  expect(ascii(4)).toBe('MThd');expect(u32()).toBe(6);u16();const tracks=u16();expect(u16()).toBe(960);
  const attacks:[number,number][]=[];
  for(let track=0;track<tracks;track++){
    expect(ascii(4)).toBe('MTrk');const stop=p+4+view.getUint32(p);p+=4;let tick=0,status=0;
    while(p<stop){tick+=variable();let type=bytes[p++];if(type<128){p--;type=status;}else if(type<240)status=type;
      if(type===255){p++;const length=variable();p+=length;}
      else if(type===240||type===247){const length=variable();p+=length;}
      else{const kind=type&240,n=kind===192||kind===208?1:2,data=bytes.slice(p,p+=n);if(kind===144&&data[1]>0)attacks.push([tick,data[0]]);}
    }
  }
  expect(p).toBe(bytes.length);return attacks.sort((a,b)=>a[0]-b[0]);
}
const beats=(score:model.Score)=>score.tracks[0].staves[0].bars[0].voices[0].beats;
const harmonics=(score:model.Score)=>beats(score).map(beat=>beat.notes.map(note=>[note.harmonicType,note.harmonicValue,note.realValue]));
const expected=[[[model.HarmonicType.Natural,12,52]],[[model.HarmonicType.Natural,7,59]],[[model.HarmonicType.Natural,5,64]],[[model.HarmonicType.None,0,43]]];
const stock=[[[0,0,52]],[[0,0,47]],[[0,0,45]],[[0,0,43]]];
const keys=(plan:ReturnType<typeof buildPlaybackPlan>)=>plan.notes.map(note=>[note.startTick,note.key,note.articulation==='harmonic']);
const sound=[[0,52,true],[960,59,true],[1920,64,true],[2880,43,false]];

describe('MusicXML tablature natural harmonics',()=>{
  it.each(['xml','mxl'] as const)('imports natural harmonics with their sounding pitch in %s',kind=>{
    const bytes=encode(kind),copy=bytes.slice(),value=project(bytes,kind),base=structuredClone(value.base),score=buildScore(value);
    expect(harmonics(score)).toEqual(expected);
    expect(smfAttacks(exportMidi(score,{tracks:[0],range:null}))).toEqual([[0,52],[960,59],[1920,64],[2880,43]]);
    expect(keys(buildPlaybackPlan(score,1))).toEqual(sound);
    expect(keys(buildPlaybackPlanFromJson(model.JsonConverter.scoreToJson(score),score.tracks.map(trackIdentity),1))).toEqual(sound);
    // The stock GP writer carries the restored harmonic.
    expect(harmonics(importer.ScoreLoader.loadScoreFromBytes(new exporter.Gp7Exporter().export(score,settings),settings))).toEqual(expected);
    // Source bytes stay authoritative; edits replay from them.
    expect(bytes).toEqual(copy);expect(value.base).toEqual(base);
    expect(createHash('sha256').update(Buffer.from(value.base.bytesBase64,'base64')).digest('hex')).toBe(base.sha256);
    const changed=previewEdit(value,{type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:3},string:1,fret:5});
    expect(changed.project.base).toEqual(base);
    const replayed=buildScore(JSON.parse(JSON.stringify(changed.project)));
    expect(harmonics(replayed).slice(0,3)).toEqual(expected.slice(0,3));
    expect(beats(replayed)[3].notes.map(note=>[note.fret,note.harmonicType])).toEqual([[5,model.HarmonicType.None]]);
    expect(harmonics(buildScore(value))).toEqual(expected);
  });

  it('accepts a touching-pitch natural harmonic and chords matched by string',()=>{
    const chord=`<note><chord/><pitch><step>B</step><octave>3</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type><notations><technical>${natural}<string>2</string><fret>12</fret></technical></notations></note>`;
    const xml=musicXml([{fret:12,harmonic:'<harmonic><natural/><touching-pitch/></harmonic>'},{fret:7,harmonic:natural},{fret:5,harmonic:natural},{fret:3}]).replace('</note><note>',`</note>${chord}<note>`);
    const notes=beats(loadInterchangeScore(strToU8(xml),settings))[0].notes.map(note=>[note.string,note.harmonicType,note.realValue]);
    expect(notes.sort((a,b)=>a[0]-b[0])).toEqual([[1,model.HarmonicType.Natural,52],[5,model.HarmonicType.Natural,71]]);
  });

  const variants:[string,string][]=[
    ['an artificial harmonic',musicXml([{fret:12,harmonic:'<harmonic><artificial/></harmonic>'},...fixture.slice(1)])],
    ['an empty harmonic',musicXml([{fret:12,harmonic:'<harmonic/>'},...fixture.slice(1)])],
    ['a sounding-pitch harmonic',musicXml([{fret:12,harmonic:'<harmonic><natural/><sounding-pitch/></harmonic>'},...fixture.slice(1)])],
    ['an unsupported fret',musicXml([{fret:6,harmonic:natural},...fixture.slice(1)])],
    ['a tied harmonic',musicXml([{fret:12,harmonic:natural,extra:'<tie type="start"/>'},...fixture.slice(1)])],
    ['a second voice',musicXml(fixture,{tail:'<backup><duration>4</duration></backup><note><rest/><duration>4</duration><voice>2</voice><type>whole</type></note>'})],
    ['a grace note',musicXml([{fret:12,harmonic:natural},...fixture.slice(1)]).replace('<note>','<note><grace/>').replace('<duration>1</duration>','')],
    ['a repeated string placement',musicXml([{fret:7,harmonic:natural},...fixture.slice(1)]).replace('</technical></notations></note>','</technical><technical><string>5</string></technical></notations></note><note><chord/><pitch><step>B</step><octave>2</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type><notations><technical><string>6</string><fret>7</fret></technical></notations></note>')],
    ['a prefixed element',musicXml(fixture,{tail:'<x:note xmlns:x="urn:example"><rest/><duration>1</duration></x:note>'})],
    ['a chord rest',musicXml(fixture,{tail:'<note><chord/><rest/><duration>1</duration><voice>1</voice><type>quarter</type></note>'})],
    // A prefixed note before the harmonic and a chord rest after it keep the beat
    // counts equal while alphaTab's beats sit one place earlier.
    ['offsetting parser disagreements',musicXml([{fret:7,harmonic:natural},{fret:7}],{tail:'<note><chord/><rest/><duration>1</duration><voice>1</voice><type>quarter</type></note>'}).replace('<note>','<x:note xmlns:x="urn:example"><rest/><duration>1</duration></x:note><note>')],
    ['a string beyond the tuning',musicXml().replace('<string>6</string>','<string>7</string>')],
    ['a staff without tablature tuning',musicXml().replace(/<clef>.*<\/staff-details>/,'<clef><sign>G</sign><line>2</line></clef>')],
  ];
  it.each(variants)('keeps the stock import for %s',(_name,xml)=>{
    const original=loadInterchangeScore(strToU8(xml),settings),plain=importer.ScoreLoader.loadScoreFromBytes(strToU8(xml),settings);
    expect(model.JsonConverter.scoreToJson(original)).toEqual(model.JsonConverter.scoreToJson(plain));
    expect(original.tracks[0].staves[0].bars.flatMap(bar=>bar.voices.flatMap(voice=>voice.beats.flatMap(beat=>beat.notes))).every(note=>note.harmonicType===model.HarmonicType.None)).toBe(true);
  });

  it('maps harmonics in a later measure',()=>{
    const plain=fixture.map(value=>({fret:value.fret}));
    const xml=musicXml(plain).replace('</measure>',`</measure><measure number="2">${fixture.map(note).join('')}</measure>`);
    const score=loadInterchangeScore(strToU8(xml),settings),bars=score.tracks[0].staves[0].bars;
    expect(bars[0].voices[0].beats.map(beat=>beat.notes[0].harmonicType)).toEqual([0,0,0,0]);
    expect(bars[1].voices[0].beats.map(beat=>[beat.notes[0].harmonicType,beat.notes[0].realValue])).toEqual(expected.map(beat=>[beat[0][0],beat[0][2]]));
  });

  it.each(['Content/score.gpif','score.gpif','Other/score.gpif'])('ignores a MusicXML member inside a GP archive read from %s',path=>{
    const stockScore=importer.ScoreLoader.loadScoreFromBytes(encode('xml',musicXml(fixture.map(value=>({fret:value.fret})))),settings);
    const {'Content/score.gpif':gpif,...gp}=unzipSync(new exporter.Gp7Exporter().export(stockScore,settings));
    const bytes=zipSync({...gp,[path]:gpif,'META-INF/container.xml':strToU8(container),'scores/main.musicxml':strToU8(musicXml())});
    expect(harmonics(loadInterchangeScore(bytes,settings))).toEqual(stock);
  });

  it('reproduces the stock loss as the negative control',()=>{
    const score=importer.ScoreLoader.loadScoreFromBytes(encode('xml'),settings);
    expect(harmonics(score)).toEqual(stock);
    expect(smfAttacks(exportMidi(score,{tracks:[0],range:null}))).toEqual([[0,52],[960,47],[1920,45],[2880,43]]);
  });

  it('reads only the container-selected MXL root',()=>{
    // The decoy carries harmonics; the selected root has none.
    const bytes=mxl(musicXml(fixture.map(note=>({fret:note.fret}))),musicXml());
    expect(harmonics(buildScore(project(bytes,'mxl')))).toEqual(stock);
  });

  it('returns the same score object for non-MusicXML and harmonic-free inputs',()=>{
    for(const bytes of [strToU8(musicXml(fixture.map(note=>({fret:note.fret})))),new Uint8Array([1,2,3]),zipSync({'Content/score.gpif':strToU8('<GPIF/>')})]){
      const score=new model.Score();
      expect(applyMusicXmlNaturalHarmonics(score,bytes,settings)).toBe(score);
    }
  });

  it('leaves the score untouched when the harmonic cannot be mapped',()=>{
    const score=new model.Score();
    expect(applyMusicXmlNaturalHarmonics(score,encode('xml'),settings)).toBe(score);
    expect(score.tracks).toEqual([]);
  });
});
