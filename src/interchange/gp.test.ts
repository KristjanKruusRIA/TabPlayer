// @vitest-environment jsdom
import { describe,expect,it,vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { exporter,importer,midi,model,Settings } from '@coderline/alphatab';
import { strFromU8,strToU8,unzipSync,zipSync } from 'fflate';
import { music } from '../editor/fixtures';
import { selectScore } from '../export/selection';
import { copyGpInterchangeSource,exportGpInterchange,loadInterchangeScore } from './gp';

const settings=new Settings();
const xml=(bytes:Uint8Array)=>new DOMParser().parseFromString(strFromU8(unzipSync(bytes)['Content/score.gpif']),'application/xml');
const changes=(score:model.Score)=>score.tracks.map(track=>track.staves.flatMap(staff=>staff.bars.flatMap(bar=>bar.voices.flatMap(voice=>voice.beats.flatMap(beat=>beat.automations.filter(a=>a.type===model.AutomationType.Volume||a.type===model.AutomationType.Balance).map(a=>({bar:bar.index,type:a.type,value:a.value,ratio:a.ratioPosition,linear:a.isLinear,visible:a.isVisible,text:a.text})))))));
function authored(){
  const score=music(),second=model.JsonConverter.jsonToScore(model.JsonConverter.scoreToJson(music()),settings).tracks[0];second.name='Second';score.addTrack(second);score.finish(settings);
  const entries=unzipSync(new exporter.Gp7Exporter().export(score,settings)),doc=xml(zipSync(entries)),tracks=doc.querySelectorAll('GPIF > Tracks > Track');
  tracks[0].setAttribute('id','42');tracks[1].setAttribute('id','7');doc.querySelector('MasterTrack > Tracks')!.textContent='7 42';
  const fixture=new DOMParser().parseFromString(readFileSync('src/interchange/fixtures/channel-strip-automations.gpif','utf8'),'application/xml');
  tracks[0].querySelector('RSE > ChannelStrip')!.append(doc.importNode(fixture.documentElement,true));
  tracks[0].querySelector('RSE > ChannelStrip > Parameters')!.textContent='0.5 0.5 0.5 0.5 0.5 0.5 0.5 0.5 0.5 1 0.5 0.58 0.66 0.5 0.5 0.5';
  entries['Content/score.gpif']=strToU8(new XMLSerializer().serializeToString(doc));
  entries['Content/Assets/authored.ogg']=new Uint8Array([0,79,103,103,255,4]);entries['Content/ScoreViews/1.gpsv']=strToU8('authored layout');entries['meta.json']=strToU8('{"authored":true}');
  return zipSync(entries);
}
function drumScore(articulations:number[],custom=false){
  const score=music(),track=score.tracks[0],staff=track.staves[0];staff.isPercussion=true;staff.stringTuning.tunings=[];track.playbackInfo.primaryChannel=9;track.playbackInfo.secondaryChannel=9;
  for(const bar of staff.bars)for(const beat of bar.voices[0].beats)beat.notes=[];
  if(custom)track.percussionArticulations=[new model.InstrumentArticulation('Custom shaker',-1,82,model.MusicFontSymbol.NoteheadXBlack,undefined,undefined,undefined,undefined,91)];
  for(const [index,articulation]of articulations.entries()){const note=new model.Note();note.string=-1;note.fret=-1;note.percussionArticulation=articulation;staff.bars[0].voices[0].beats[index].addNote(note);}
  score.finish(settings);return score;
}
function midiNotes(score:model.Score){
  const file=new midi.MidiFile();new midi.MidiFileGenerator(score,settings,new midi.AlphaSynthMidiFileHandler(file,true)).generate();
  const bytes=file.toBinary(),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let p=0;
  const ascii=(length:number)=>String.fromCharCode(...bytes.slice(p,p+=length)),u32=()=>{const value=view.getUint32(p);p+=4;return value;},u16=()=>{const value=view.getUint16(p);p+=2;return value;};
  const variable=()=>{let value=0,byte;do{byte=bytes[p++];value=value*128+(byte&127);}while(byte&128);return value;};
  expect(ascii(4)).toBe('MThd');expect(u32()).toBe(6);u16();const count=u16();expect(u16()).toBe(960);const result:number[][]=[];
  for(let track=0;track<count;track++){expect(ascii(4)).toBe('MTrk');const end=p+4+view.getUint32(p);p+=4;let tick=0,status=0;
    while(p<end){tick+=variable();let code=bytes[p++];if(code<128){p--;code=status;}else if(code<240)status=code;
      if(code===255){p++;const length=variable();p+=length;}else if(code===240||code===247){const length=variable();p+=length;}else{const kind=code&240,a=bytes[p++],b=kind===192||kind===208?undefined:bytes[p++];if(kind===144&&b)result.push([tick,a,code&15]);}
    }
  }expect(p).toBe(bytes.length);return result;
}
describe('native GP channel-strip interchange',()=>{
  it('restores exact DSP values, flags and same-position order using MasterTrack order',()=>{
    const bytes=authored(),before=bytes.slice(),score=loadInterchangeScore(bytes,settings);
    expect(score.tracks.map(t=>t.name)).toEqual(['Second','Guitar']);
    expect(changes(score)).toEqual([[],[
      {bar:0,type:model.AutomationType.Volume,value:9.28,ratio:.333333,linear:false,visible:false,text:'quiet & warm'},
      {bar:1,type:model.AutomationType.Balance,value:4,ratio:.375,linear:true,visible:true,text:'left → center'},
      {bar:1,type:model.AutomationType.Volume,value:10.56,ratio:.375,linear:false,visible:true,text:''},
      {bar:1,type:model.AutomationType.Volume,value:8,ratio:.375,linear:false,visible:false,text:''},
    ]]);
    expect(score.tracks[1].playbackInfo).toMatchObject({balance:9.28,volume:10.56});expect(bytes).toEqual(before);
  });
  it('writes only standard ChannelStrip nodes and keeps source siblings through clone/export cycles',()=>{
    const bytes=authored(),source=loadInterchangeScore(bytes,settings),before=JSON.stringify(model.JsonConverter.scoreToJson(source));
    const detached=model.JsonConverter.jsonToScore(model.JsonConverter.scoreToJson(source),settings);copyGpInterchangeSource(source,detached);
    const out=exportGpInterchange(detached,settings),doc=xml(out),nodes=[...doc.querySelectorAll('Track > RSE > ChannelStrip > Automations > Automation')];
    expect(nodes.map(node=>['Type','Bar','Position','Linear','Visible','Value','Text'].map(name=>node.querySelector(name)?.textContent??''))).toEqual([
      ['DSPParam_12','0','0.333333','false','false','0.58','quiet & warm'],
      ['DSPParam_11','1','0.375','true','true','0.25','left → center'],
      ['DSPParam_12','1','0.375','false','true','0.66',''],
      ['DSPParam_12','1','0.375','false','false','0.5',''],
    ]);
    expect([...doc.querySelectorAll('Track > Automations > Automation > Type')].some(node=>node.textContent?.startsWith('DSPParam_'))).toBe(false);
    const originalEntries=unzipSync(bytes),outputEntries=unzipSync(out);
    for(const [name,data]of Object.entries(originalEntries))if(name!=='Content/score.gpif')expect(outputEntries[name],name).toEqual(data);
    const again=loadInterchangeScore(out,settings);expect(changes(again)).toEqual(changes(source));
    expect(changes(loadInterchangeScore(exportGpInterchange(again,settings),settings))).toEqual(changes(source));
    expect(JSON.stringify(model.JsonConverter.scoreToJson(source))).toBe(before);expect(JSON.stringify(model.JsonConverter.scoreToJson(detached))).toBe(before);
  });
  it('collects events across staves and voices once, in musical order',()=>{
    const score=music(),track=score.tracks[0],extra=model.JsonConverter.jsonToScore(model.JsonConverter.scoreToJson(music()),settings).tracks[0].staves[0];track.addStaff(extra);score.finish(settings);
    const event=(value:number,ratioPosition:number)=>Object.assign(new model.Automation(),{type:model.AutomationType.Volume,value,ratioPosition});
    track.staves[0].bars[1].voices[0].beats[2].automations.push(event(6,.75));
    extra.bars[0].voices[0].beats[2].automations.push(event(4,.5));
    const shared=event(8,.75);track.staves[0].bars[1].voices[0].beats[2].automations.push(shared);extra.bars[1].voices[0].beats[2].automations.push(shared);
    const nodes=[...xml(exportGpInterchange(score,settings)).querySelectorAll('ChannelStrip > Automations > Automation')];
    expect(nodes.map(n=>[n.querySelector('Bar')!.textContent,n.querySelector('Position')!.textContent,n.querySelector('Value')!.textContent])).toEqual([['0','0.5','0.25'],['1','0.75','0.375'],['1','0.75','0.5']]);
  });
  it('exports a selected excerpt with inherited mix, rebased events and unchanged source',()=>{
    const score=music(),beat=(bar:number)=>score.tracks[0].staves[0].bars[bar].voices[0].beats[0];
    beat(0).automations.push(Object.assign(new model.Automation(),{type:model.AutomationType.Volume,value:4,ratioPosition:.5}));
    beat(2).automations.push(Object.assign(new model.Automation(),{type:model.AutomationType.Volume,value:9.28,ratioPosition:.375}));
    const before=JSON.stringify(model.JsonConverter.scoreToJson(score)),selected=selectScore(score,{tracks:[0],range:{first:2,last:3}}),round=loadInterchangeScore(exportGpInterchange(selected,settings),settings);
    expect(round.tracks[0].playbackInfo.volume).toBe(4);expect(changes(round)[0]).toEqual([{bar:0,type:model.AutomationType.Volume,value:9.28,ratio:.375,linear:false,visible:true,text:''}]);
    expect(JSON.stringify(model.JsonConverter.scoreToJson(score))).toBe(before);
  });
  it('retains public MusicXML loading and errors for unsupported data',()=>{
    const bytes=strToU8('<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note></measure></part></score-partwise>');
    expect(model.JsonConverter.scoreToJson(loadInterchangeScore(bytes,settings))).toEqual(model.JsonConverter.scoreToJson(importer.ScoreLoader.loadScoreFromBytes(bytes,settings)));
    const mxl=zipSync({'META-INF/container.xml':strToU8('<container><rootfiles><rootfile full-path="scores/piano.musicxml"/></rootfiles></container>'),'scores/piano.musicxml':bytes});
    expect(model.JsonConverter.scoreToJson(loadInterchangeScore(mxl,settings))).toEqual(model.JsonConverter.scoreToJson(importer.ScoreLoader.loadScoreFromBytes(mxl,settings)));
    expect(()=>loadInterchangeScore(strToU8('not a score'),settings)).toThrow();
  });
  it.each(['guitarpro3-notes.gp3','guitarpro4-notes.gp4','guitarpro5-notes.gp5','guitarpro6-notes.gpx'])('retains public binary loading for %s',filename=>{
    const bytes=new Uint8Array(readFileSync(`.analysis/compatibility/${filename}`)),before=bytes.slice();
    expect(model.JsonConverter.scoreToJson(loadInterchangeScore(bytes,settings))).toEqual(model.JsonConverter.scoreToJson(importer.ScoreLoader.loadScoreFromBytes(bytes,settings)));
    expect(bytes).toEqual(before);
  });
  it('writes UTF-8 XML even when legacy importer decoding settings are selected',()=>{
    const score=music();score.title='Ä →';const legacy=new Settings();legacy.importer.encoding='windows-1252';
    expect(xml(exportGpInterchange(score,legacy)).querySelector('Score > Title')!.textContent).toBe('Ä →');
  });
  it('exports standard drum IDs as native articulation table indices without changing their pitches',()=>{
    const score=drumScore([91,92,114,124]),before=model.JsonConverter.scoreToJson(score),bytes=exportGpInterchange(score,settings),doc=xml(bytes);
    const refs=[...doc.querySelectorAll('Notes > Note > InstrumentArticulation')].map(node=>Number(node.textContent));
    expect(refs.slice(0,2)).toEqual([2,4]);
    const table=[...doc.querySelectorAll('Track > InstrumentSet > Elements > Element > Articulations > Articulation')];
    expect(refs.map(index=>Number(table[index].querySelector('OutputMidiNumber')!.textContent))).toEqual([38,46,43,62]);
    const reopened=loadInterchangeScore(bytes,settings);expect(midiNotes(reopened)).toEqual([[0,38,9],[960,46,9],[1920,43,9],[2880,62,9]]);
    expect(midiNotes(loadInterchangeScore(exportGpInterchange(reopened,settings),settings))).toEqual([[0,38,9],[960,46,9],[1920,43,9],[2880,62,9]]);
    expect(model.JsonConverter.scoreToJson(score)).toBe(before);
  });
  it('keeps custom index overrides and unshadowed standard drum fallback in one native table',()=>{
    const score=drumScore([0,91],true),before=model.JsonConverter.scoreToJson(score),bytes=exportGpInterchange(score,settings),doc=xml(bytes);
    expect([...doc.querySelectorAll('Notes > Note > InstrumentArticulation')].map(node=>Number(node.textContent))).toEqual([0,3]);
    const table=[...doc.querySelectorAll('Track > InstrumentSet > Elements > Element > Articulations > Articulation')];
    expect(table[0].querySelector('OutputMidiNumber')!.textContent).toBe('82');expect(table[3].querySelector('OutputMidiNumber')!.textContent).toBe('38');
    const reopened=loadInterchangeScore(bytes,settings);expect(midiNotes(reopened)).toEqual([[0,82,9],[960,38,9]]);
    expect(reopened.tracks[0].percussionArticulations[0].noteHeadDefault).toBe(model.MusicFontSymbol.NoteheadXBlack);
    expect(midiNotes(loadInterchangeScore(exportGpInterchange(reopened,settings),settings))).toEqual([[0,82,9],[960,38,9]]);
    expect(model.JsonConverter.scoreToJson(score)).toBe(before);
  });
  it('bounds import DOM input to track metadata even when GPIF contains a large Notes section',()=>{
    const entries=unzipSync(new exporter.Gp7Exporter().export(music(),settings));
    const unused=Array.from({length:12000},(_,i)=>`<Note id="${100000+i}"><InstrumentArticulation>0</InstrumentArticulation><Properties/></Note>`).join('');
    const original=strFromU8(entries['Content/score.gpif']),end=original.lastIndexOf('</Notes>');entries['Content/score.gpif']=strToU8(original.slice(0,end)+unused+original.slice(end));
    const bytes=zipSync(entries),spy=vi.spyOn(DOMParser.prototype,'parseFromString');
    try {
      expect(loadInterchangeScore(bytes,settings).tracks[0].staves[0].bars).toHaveLength(4);
      expect(spy.mock.calls.length).toBeGreaterThan(0);expect(spy.mock.calls.every(([input])=>String(input).length<20000&&!String(input).includes('<Notes>'))).toBe(true);
    }finally{spy.mockRestore();}
  });
  it('exports an ordinary score with source siblings without creating any XML DOM',()=>{
    const entries=unzipSync(new exporter.Gp7Exporter().export(music(),settings));entries['Content/Assets/authored.bin']=new Uint8Array([0,1,255]);
    const source=loadInterchangeScore(zipSync(entries),settings),spy=vi.spyOn(DOMParser.prototype,'parseFromString');let output:Uint8Array;
    try {output=exportGpInterchange(source,settings);expect(spy.mock.calls).toHaveLength(0);}finally{spy.mockRestore();}
    expect(unzipSync(output!)['Content/Assets/authored.bin']).toEqual(new Uint8Array([0,1,255]));expect(xml(output!).querySelectorAll('Notes > Note')).toHaveLength(16);
  });
  it('bounds export DOM input and patches percussion references without parsing Notes',()=>{
    const score=drumScore([0,91],true);score.tracks[0].name='A > B </Tracks><Note id="1">';
    score.tracks[0].staves[0].bars[0].voices[0].beats[0].text='literal <Note id="2"><InstrumentArticulation>91</InstrumentArticulation></Note>';
    const spy=vi.spyOn(DOMParser.prototype,'parseFromString');let output:Uint8Array;
    try {
      output=exportGpInterchange(score,settings);expect(spy.mock.calls.length).toBeGreaterThan(0);expect(spy.mock.calls.every(([input])=>String(input).length<60000&&!String(input).includes('<Notes>'))).toBe(true);
    }finally{spy.mockRestore();}
    expect(midiNotes(loadInterchangeScore(output!,settings))).toEqual([[0,82,9],[960,38,9]]);
  });
  it.each([
    [1, model.TremoloPickingStyle.Default, '1/2'],
    [2, model.TremoloPickingStyle.Default, '1/4'],
    [3, model.TremoloPickingStyle.Default, '1/8'],
  ])('preserves default tremolo picking with %i marks (%s) through GP export and import', (marks, style, expectedXmlValue) => {
    const score = music();
    const beat = score.tracks[0].staves[0].bars[0].voices[0].beats[0];
    beat.tremoloPicking = Object.assign(new model.TremoloPickingEffect(), { marks, style });
    const bytes = exportGpInterchange(score, settings);
    const doc = xml(bytes);
    const beatNode = doc.querySelector(`Beats > Beat[id="${beat.id}"]`);
    expect(beatNode?.querySelector(':scope > Tremolo')?.textContent).toBe(expectedXmlValue);

    const reimported = loadInterchangeScore(bytes, settings);
    const reimportedBeat = reimported.tracks[0].staves[0].bars[0].voices[0].beats[0];
    expect(reimportedBeat.isTremolo).toBe(true);
    expect(reimportedBeat.tremoloPicking?.marks).toBe(marks);
    expect(reimportedBeat.tremoloPicking?.style).toBe(model.TremoloPickingStyle.Default);
  });
  it('pins buzz-roll tremolo behavior: speed is retained in GPIF rational while target format lacks roll style', () => {
    const score = music();
    const beat = score.tracks[0].staves[0].bars[0].voices[0].beats[0];
    beat.tremoloPicking = Object.assign(new model.TremoloPickingEffect(), { marks: 2, style: model.TremoloPickingStyle.BuzzRoll });
    const bytes = exportGpInterchange(score, settings);
    const doc = xml(bytes);
    const beatNode = doc.querySelector(`Beats > Beat[id="${beat.id}"]`);
    expect(beatNode?.querySelector(':scope > Tremolo')?.textContent).toBe('1/4');

    const reimported = loadInterchangeScore(bytes, settings);
    const reimportedBeat = reimported.tracks[0].staves[0].bars[0].voices[0].beats[0];
    expect(reimportedBeat.isTremolo).toBe(true);
    expect(reimportedBeat.tremoloPicking?.marks).toBe(2);
    expect(reimportedBeat.tremoloPicking?.style).toBe(model.TremoloPickingStyle.Default);
  });
});
it('writes byte-identical GP archives regardless of the wall clock',()=>{
  vi.useFakeTimers();
  try{
    const score=loadInterchangeScore(authored(),settings);
    vi.setSystemTime(new Date(2026,0,1,12,0,0,999));const first=exportGpInterchange(score,settings);
    vi.setSystemTime(new Date(2026,0,1,12,0,3));expect(exportGpInterchange(score,settings)).toEqual(first);
    const lyric=music();lyric.tracks[0].staves[0].bars[0].voices[0].beats[0].lyrics=['probe'];lyric.finish(settings);
    vi.setSystemTime(new Date(2026,0,1,12,0,0,999));const xmlFirst=exportGpInterchange(lyric,settings);
    vi.setSystemTime(new Date(2026,0,1,12,0,3));expect(exportGpInterchange(lyric,settings)).toEqual(xmlFirst);
  }finally{vi.useRealTimers();}
});
