import { readFileSync } from 'node:fs';
import { expect,it } from 'vitest';
import { exporter,importer,model,Settings } from '@coderline/alphatab';
import { strFromU8,strToU8,unzipSync,zipSync } from 'fflate';
import { music } from '../editor/fixtures';
import { scoreFromJson } from '../model-clone';
import { applyLyricsEdit,getTrackLyrics,reflowLyrics } from '../editor/lyrics';
import { readGpifLyrics,writeGpifLyrics } from './lyrics';

const settings=new Settings(),path='Content/score.gpif',sibling='Content/Assets/lyrics-test.txt';
const parse=(text:string)=>new DOMParser().parseFromString(text,'application/xml');
const serialize=(doc:Document)=>new XMLSerializer().serializeToString(doc);
const documentFrom=(bytes:Uint8Array)=>parse(strFromU8(unzipSync(bytes)[path]));
const authoredLines=[{startBar:0,text:'[VERSE]\nHel-lo  world+today'},{startBar:1,text:'& < ]]>'},{startBar:2,text:''},{startBar:0,text:'Õhtu kaunis'},{startBar:3,text:'last verse'}];
const orderedTrack=(doc:Document,index:number)=>doc.querySelector(`GPIF > Tracks > Track[id="${doc.querySelector('GPIF > MasterTrack > Tracks')!.textContent!.trim().split(/\s+/)[index]}"]`)!;
const matrix=(score:model.Score)=>score.tracks.map(track=>track.staves[0].bars.flatMap(bar=>bar.voices[0].beats.map(beat=>beat.lyrics)));
function authored() {
  const score=music();score.addTrack(scoreFromJson(model.JsonConverter.scoreToJson(music()),settings).tracks[0]);score.tracks[1].name='Second';score.finish(settings);
  const entries=unzipSync(new exporter.Gp7Exporter().export(score,settings)),doc=parse(strFromU8(entries[path])),tracks=[...doc.querySelectorAll('GPIF > Tracks > Track')];
  tracks[0].setAttribute('id','42');tracks[1].setAttribute('id','7');doc.querySelector('MasterTrack > Tracks')!.textContent='7 42';
  const fixture=parse(readFileSync('src/interchange/fixtures/lyrics-authored.gpif','utf8'));
  for(const track of tracks)track.querySelector(':scope > Lyrics')!.replaceWith(doc.importNode(fixture.querySelector(`Track[id="${track.getAttribute('id')}"] > Lyrics`)!,true));
  entries[path]=strToU8(serialize(doc));entries[sibling]=strToU8('independent harmless sibling → preserved');return zipSync(entries);
}
function loaded(bytes=authored()) {
  const score=importer.ScoreLoader.loadScoreFromBytes(bytes,settings);readGpifLyrics(score,documentFrom(bytes));return score;
}
function adapted(score:model.Score,original?:Uint8Array) {
  const generated=unzipSync(new exporter.Gp7Exporter().export(score,settings)),doc=parse(strFromU8(generated[path]));writeGpifLyrics(score,doc);
  return zipSync({...generated,...(original?unzipSync(original):{}),[path]:strToU8(serialize(doc))});
}

it('public_export_reconstructs_and_loses_raw_lyrics',()=>{
  const score=music();applyLyricsEdit(score,{type:'setTrackLyrics',track:0,visible:true,lines:[authoredLines[0]]});
  const doc=documentFrom(new exporter.Gp7Exporter().export(score,settings)),line=doc.querySelector('Track > Lyrics > Line')!;
  expect(line.querySelector('Text')!.textContent).toBe('Hel- lo  world+today');expect(line.querySelector('Offset')!.textContent).toBe('0');
  writeGpifLyrics(score,doc);
  expect(doc.querySelector('Track > Lyrics > Line > Text')!.textContent).toBe('[VERSE]\nHel-lo  world+today');
});

it('reads_raw_source_in_master_track_order_without_reflowing_imported_syllables',()=>{
  const bytes=authored(),before=bytes.slice(),score=importer.ScoreLoader.loadScoreFromBytes(bytes,settings),json=model.JsonConverter.scoreToJson(score);
  readGpifLyrics(score,documentFrom(bytes));
  expect(score.tracks.map(track=>track.name)).toEqual(['Second','Guitar']);
  expect(getTrackLyrics(score,0)).toEqual({visible:true,source:'raw',lines:[{startBar:0,text:'Other+track source'}]});
  expect(getTrackLyrics(score,1)).toEqual({visible:true,source:'raw',lines:authoredLines});
  reflowLyrics(score);expect(model.JsonConverter.scoreToJson(score)).toBe(json);expect(bytes).toEqual(before);
});

it('visible_raw_gpif_and_distributed_matrix_survive',()=>{
  const bytes=authored(),before=bytes.slice(),score=loaded(bytes);
  // The public CDATA writer cannot emit literal ]]>; root verifies its serialization workaround.
  const linesWithoutCdataTerminator=authoredLines.map(line=>({...line,text:line.text.replace(']]>','XML')}));
  applyLyricsEdit(score,{type:'setTrackLyrics',track:1,visible:true,lines:linesWithoutCdataTerminator});
  const beforeJson=model.JsonConverter.scoreToJson(score),out=adapted(score,bytes),doc=documentFrom(out),track=orderedTrack(doc,1),lines=[...track.querySelectorAll(':scope > Lyrics > Line')];
  expect(lines.map(line=>({startBar:Number(line.querySelector('Offset')!.textContent),text:line.querySelector('Text')!.textContent}))).toEqual(linesWithoutCdataTerminator);
  expect(lines).toHaveLength(5);expect(track.querySelector(':scope > Lyrics')!.getAttribute('dispatched')).toBe('true');expect(doc.querySelector('parsererror')).toBeNull();
  const reopened=loaded(out);expect(getTrackLyrics(reopened,1)).toEqual({visible:true,source:'raw',lines:linesWithoutCdataTerminator});
  expect(matrix(reopened)[1].slice(0,4)).toEqual([['Hel-','','','Õhtu',''],['lo','','','kaunis',''],['','','','',''],['world today','','','','']]);
  expect(matrix(reopened)).toEqual(matrix(score));expect(model.JsonConverter.scoreToJson(score)).toBe(beforeJson);expect(bytes).toEqual(before);
  expect(unzipSync(out)[sibling]).toEqual(strToU8('independent harmless sibling → preserved'));
});

it('retains_unmanaged_nonempty_raw_source_without_redistributing_it',()=>{
  const score=loaded(),before=model.JsonConverter.scoreToJson(score),doc=documentFrom(new exporter.Gp7Exporter().export(music(),settings)),other=doc.querySelector('Track')!.cloneNode(true) as Element;
  other.setAttribute('id','1');doc.querySelector('GPIF > Tracks')!.append(other);doc.querySelector('MasterTrack > Tracks')!.textContent='0 1';
  writeGpifLyrics(score,doc);
  expect(orderedTrack(doc,1).querySelector(':scope > Lyrics > Line > Text')!.textContent).toBe('[VERSE]\nHel-lo  world+today');
  expect(model.JsonConverter.scoreToJson(score)).toBe(before);
});

it('distributed_only_imports_stay_reconstructed_and_unmanaged_until_explicit_apply',()=>{
  const score=music();score.tracks[0].staves[0].bars[0].voices[0].beats[2].lyrics=['shown words'];
  const doc=documentFrom(new exporter.Gp7Exporter().export(score,settings));doc.querySelector('Track > Lyrics')!.remove();
  const bytes=zipSync({[path]:strToU8(serialize(doc))}),imported=loaded(bytes),json=model.JsonConverter.scoreToJson(imported);
  expect(getTrackLyrics(imported,0)).toEqual({visible:true,source:'distributed',lines:[{startBar:0,text:'  shown+words'}]});
  const untouched=serialize(doc);writeGpifLyrics(imported,doc);expect(serialize(doc)).toBe(untouched);reflowLyrics(imported);expect(model.JsonConverter.scoreToJson(imported)).toBe(json);
});

it('escapes_exact_raw_text_as_standard_xml_text_without_cdata',()=>{
  const score=music(),doc=documentFrom(new exporter.Gp7Exporter().export(score,settings)),raw='[VERSE]\n& < ]]> Õhtu';
  applyLyricsEdit(score,{type:'setTrackLyrics',track:0,visible:true,lines:[{startBar:3,text:raw}]});writeGpifLyrics(score,doc);
  const literal=serialize(doc);expect(literal).toContain('&amp; &lt; ]]&gt; Õhtu');expect(parse(literal).querySelector('Track > Lyrics > Line > Text')!.textContent).toBe(raw);
  expect(doc.querySelector('Track > Lyrics > Line > Offset')!.textContent).toBe('3');
});

it('hidden_raw_lyrics_roundtrip_uses_native_dispatched_false_and_remains_hidden',()=>{
  const score=music(),raw='[HIDDEN]\nsecret raw words',lines=[{startBar:0,text:raw},{startBar:1,text:''},{startBar:2,text:'third'},{startBar:0,text:''},{startBar:3,text:'last'}];
  applyLyricsEdit(score,{type:'setTrackLyrics',track:0,visible:false,lines});
  const bytes=adapted(score),doc=documentFrom(bytes);
  expect(doc.querySelector('Track > Lyrics')!.getAttribute('dispatched')).toBe('false');expect(doc.querySelectorAll('Track > Lyrics > Line')).toHaveLength(5);
  const publicImport=importer.ScoreLoader.loadScoreFromBytes(bytes,settings);expect(matrix(publicImport)[0].some(lyrics=>lyrics!==null)).toBe(true);
  readGpifLyrics(publicImport,doc);expect(matrix(publicImport)[0].every(lyrics=>lyrics===null)).toBe(true);expect(getTrackLyrics(publicImport,0)).toEqual({visible:false,source:'raw',lines});
  publicImport.finish(settings);reflowLyrics(publicImport);expect(matrix(publicImport)[0].every(lyrics=>lyrics===null)).toBe(true);
  const reopened=loaded(adapted(publicImport));expect(getTrackLyrics(reopened,0)).toEqual({visible:false,source:'raw',lines});expect(matrix(reopened)[0].every(lyrics=>lyrics===null)).toBe(true);
  applyLyricsEdit(reopened,{type:'setTrackLyrics',track:0,visible:true,lines});expect(matrix(reopened)[0][0]).toEqual(['secret','','','','']);
  applyLyricsEdit(score,{type:'setTrackLyrics',track:0,visible:false,lines:[{startBar:0,text:''}]});
  const empty=documentFrom(adapted(score));expect(empty.querySelector('Track > Lyrics')!.getAttribute('dispatched')).toBe('false');expect(empty.querySelector('Track > Lyrics > Line > Text')!.textContent).toBe('');
});
