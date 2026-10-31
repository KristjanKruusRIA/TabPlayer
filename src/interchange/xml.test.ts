import { expect,it } from 'vitest';
import { patchGpifNoteArticulations,projectGpifTracks } from './xml';

const source=`<?xml version="1.0"?><GPIF test="a > b">
<!-- <Tracks><Track id='fake'/></Tracks> -->
<MasterTrack><Tracks>7 42</Tracks></MasterTrack>
<Tracks probe='quoted > value'><Track id='7'><Name><![CDATA[</Tracks><Note id="1">bogus]]></Name></Track><Track id="42"/></Tracks>
<Notes><Note probe=">" id='1'><Text><![CDATA[<Note id="2"><InstrumentArticulation>91</InstrumentArticulation></Note>]]></Text><InstrumentArticulation>91</InstrumentArticulation></Note>
<!-- <Note id="2"><InstrumentArticulation>91</InstrumentArticulation></Note> -->
<Note id="2" probe='still > quoted'><InstrumentArticulation>92</InstrumentArticulation></Note><Note id='3'><InstrumentArticulation>124</InstrumentArticulation></Note></Notes></GPIF>`;
it('projects only root master/track elements while respecting comments, CDATA and quoted greater-than characters',()=>{
  const projection=projectGpifTracks(source);
  expect(projection?.xml).toBe(`<GPIF><MasterTrack><Tracks>7 42</Tracks></MasterTrack><Tracks probe='quoted > value'><Track id='7'><Name><![CDATA[</Tracks><Note id="1">bogus]]></Name></Track><Track id="42"/></Tracks></GPIF>`);
  expect(projection&&source.slice(projection.tracks.start,projection.tracks.end)).toBe(`<Tracks probe='quoted > value'><Track id='7'><Name><![CDATA[</Tracks><Note id="1">bogus]]></Name></Track><Track id="42"/></Tracks>`);
});
it('patches only actual native note references and leaves quoted/comment/CDATA lookalikes byte-identical',()=>{
  expect(patchGpifNoteArticulations(source,new Map([[1,2],[2,4]]))).toBe(source.replace('</Text><InstrumentArticulation>91','</Text><InstrumentArticulation>2').replace("probe='still > quoted'><InstrumentArticulation>92","probe='still > quoted'><InstrumentArticulation>4"));
});
it.each(['<!DOCTYPE GPIF [<!ENTITY name "Guitar">]><GPIF><MasterTrack/><Tracks/></GPIF>','<GPIF xmlns="urn:gpif"><MasterTrack/><Tracks/></GPIF>'])('uses the DOM fallback for unsupported declarations or namespaces',xml=>{
  expect(projectGpifTracks(xml)).toBeUndefined();expect(patchGpifNoteArticulations(xml,new Map([[1,2]]))).toBeUndefined();
});
it('projects only requested notation beats and master bars without parsing note payloads',()=>{
  const xml=source.replace('<Notes>',`<MasterBars><MasterBar><Time>4/4</Time></MasterBar></MasterBars><Beats><Beat id="3"><XProperties/></Beat><Beat id="9"><Text><![CDATA[</Beat>]]></Text></Beat><Beat id="11"/></Beats><Notes>`);
  const projection=projectGpifTracks(xml,{beatIds:new Set([9]),masterBars:true});
  expect(projection?.xml).toContain('<MasterBars><MasterBar><Time>4/4</Time></MasterBar></MasterBars>');
  expect(projection?.xml).toContain('<Beats><Beat id="9"><Text><![CDATA[</Beat>]]></Text></Beat></Beats>');
  expect(projection?.xml).not.toContain('<Notes>');expect(projection?.xml).not.toContain('<Beat id="3">');
  expect(projection?.masterBars&&xml.slice(projection.masterBars.start,projection.masterBars.end)).toBe('<MasterBars><MasterBar><Time>4/4</Time></MasterBar></MasterBars>');
  expect(projection?.beats?.get(9)&&xml.slice(projection.beats.get(9)!.start,projection.beats.get(9)!.end)).toBe('<Beat id="9"><Text><![CDATA[</Beat>]]></Text></Beat>');
});
