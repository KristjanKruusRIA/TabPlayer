import { expect,it,vi } from 'vitest';
import { model,Settings } from '@coderline/alphatab';
import { unzipSync,zipSync } from 'fflate';
import { blankProject,type EditCommand } from '../project';
import { buildScore,exportGp,previewEdit } from '../engine';
import { loadInterchangeScore } from './gp';
import { getTrackLyrics } from '../editor/lyrics';

const settings=new Settings(),target={track:0,staff:0,bar:0,voice:0,beat:0};
const path='Content/score.gpif',zipOptions={mtime:new Date(1980,0,1)};
const parse=(bytes:Uint8Array)=>new DOMParser().parseFromString(new TextDecoder().decode(unzipSync(bytes)[path]),'application/xml');
const notes:EditCommand[]=Array.from({length:4},(_,beat)=>({type:'setNote',target:{...target,beat},string:1,fret:beat}));
it('retains exact raw lyrics including XML characters and CRLF through real GP and project replay',()=>{
  const raw='[VERSE]\r\nHel-lo  world+today & < ]]> Ω';
  const score=buildScore({...blankProject(),edits:[...notes,{type:'setTrackLyrics',track:0,visible:true,lines:[{startBar:0,text:raw},{startBar:1,text:''}]}]});
  const before=model.JsonConverter.scoreToJson(score),bytes=exportGp(score),doc=parse(bytes);
  expect(doc.querySelector('Tracks > Track > Lyrics > Line > Text')?.textContent).toBe(raw);
  expect(getTrackLyrics(loadInterchangeScore(bytes,settings),0)).toEqual({visible:true,lines:[{startBar:0,text:raw},{startBar:1,text:''}],source:'raw'});
  expect(model.JsonConverter.scoreToJson(score)).toBe(before);
  const original=unzipSync(bytes);original['Content/Assets/probe.bin']=new Uint8Array([1,2,255]);const source=zipSync(original,zipOptions);
  const file={...blankProject(),base:{kind:'file' as const,filename:'authored.gp',bytesBase64:Buffer.from(source).toString('base64'),sha256:'a'.repeat(64)},edits:[]};
  const rebuilt=previewEdit(file,{type:'appendMeasure'}).score,again=exportGp(rebuilt);
  expect(getTrackLyrics(rebuilt,0).lines[0].text).toBe(raw);expect(unzipSync(again)['Content/Assets/probe.bin']).toEqual(new Uint8Array([1,2,255]));
  expect(source).toEqual(zipSync(original,zipOptions));
});
it('retains standard inverted stems and exact fermata offsets through the bounded GP wrapper',()=>{
  const score=buildScore({...blankProject(),edits:[...notes,{type:'setBeatGestures',target,patch:{stem:'inverted'}}]});
  score.masterBars[0].addFermata(87,Object.assign(new model.Fermata(),{type:2,length:1.5}));
  const source=model.JsonConverter.scoreToJson(score),spy=vi.spyOn(DOMParser.prototype,'parseFromString');let bytes:Uint8Array;
  try {
    bytes=exportGp(score);
    expect(spy.mock.calls.length).toBeGreaterThan(0);expect(spy.mock.calls.every(([text])=>String(text).length<20000&&!/<Notes>\s*<Note\b/.test(String(text)))).toBe(true);
  }finally{spy.mockRestore();}
  const doc=parse(bytes!);
  expect(doc.querySelector('Beats > Beat > XProperties > XProperty[id="1124204545"] > Int')?.textContent).toBe('1');
  expect(doc.querySelector('MasterBars > MasterBar > Fermatas > Fermata > Offset')?.textContent).toBe('29/320');
  const reopened=loadInterchangeScore(bytes!,settings);
  expect(reopened.tracks[0].staves[0].bars[0].voices[0].beats[0].invertBeamDirection).toBe(true);
  expect(reopened.masterBars[0].fermata?.get(87)).toMatchObject({type:2,length:1.5});expect(model.JsonConverter.scoreToJson(score)).toBe(source);
});
it('exports literal CDATA terminators as valid raw and distributed lyric text',()=>{
  const raw=']]> & < Ω';
  const score=buildScore({...blankProject(),edits:[...notes,{type:'setTrackLyrics',track:0,visible:true,lines:[{startBar:0,text:raw}]}]});
  const before=model.JsonConverter.scoreToJson(score),bytes=exportGp(score),doc=parse(bytes);
  expect(doc.querySelector('parsererror')).toBeNull();expect(doc.querySelector('Tracks > Track > Lyrics > Line > Text')?.textContent).toBe(raw);
  expect(loadInterchangeScore(bytes,settings).tracks[0].staves[0].bars[0].voices[0].beats[0].lyrics?.[0]).toBe(']]>');
  expect(model.JsonConverter.scoreToJson(score)).toBe(before);
});
it('retains hidden raw lyrics in standard GP without redisplaying them after native rebuild',()=>{
  const raw='[VERSE]\nprivate+verse';
  const score=buildScore({...blankProject(),edits:[...notes,{type:'setTrackLyrics',track:0,visible:false,lines:[{startBar:1,text:raw}]}]}),bytes=exportGp(score);
  const doc=parse(bytes);expect(doc.querySelector('Tracks > Track > Lyrics')?.getAttribute('dispatched')).toBe('false');
  expect(doc.querySelector('Tracks > Track > Lyrics > Line > Text')?.textContent).toBe(raw);
  const imported=loadInterchangeScore(bytes,settings);expect(getTrackLyrics(imported,0)).toEqual({visible:false,lines:[{startBar:1,text:raw}],source:'raw'});
  expect(imported.tracks[0].staves[0].bars.flatMap(b=>b.voices.flatMap(v=>v.beats)).every(b=>b.lyrics===null)).toBe(true);
  expect(parse(exportGp(imported)).querySelector('Tracks > Track > Lyrics')?.getAttribute('dispatched')).toBe('false');
});
