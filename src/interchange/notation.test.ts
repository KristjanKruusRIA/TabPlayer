import { expect,it } from 'vitest';
import { readFileSync } from 'node:fs';
import { exporter,importer,model,Settings } from '@coderline/alphatab';
import { strFromU8,strToU8,unzipSync,zipSync } from 'fflate';
import { music } from '../editor/fixtures';
import { writeGpifNotation } from './notation';
const settings=new Settings();
const parse=(xml:string)=>new DOMParser().parseFromString(xml,'application/xml');
const serialize=(doc:Document)=>new XMLSerializer().serializeToString(doc);
const xml=(bytes:Uint8Array)=>parse(strFromU8(unzipSync(bytes)['Content/score.gpif']));
function authored(){const score=music();score.tracks[0].staves[0].bars[0].voices[0].beats[0].invertBeamDirection=true;for(const [offset,type,length]of [[0,0,.5],[87,1,1.25],[960,2,2]])score.masterBars[0].addFermata(offset,Object.assign(new model.Fermata(),{type,length}));return score;}
const fermatas=(doc:Document)=>[...doc.querySelectorAll('MasterBars > MasterBar > Fermatas > Fermata')].map(n=>['Type','Length','Offset'].map(name=>n.querySelector(name)?.textContent));
it('public_writer_loses_inversion_and_fractional_fermata',()=>{
  const score=authored(),doc=xml(new exporter.Gp7Exporter().export(score,settings));expect(doc.querySelector('Beats > Beat > XProperties > XProperty[id="1124204545"]')).toBeNull();expect(fermatas(doc)).toEqual([['Short','0.5','0/1'],['Long','2','1/1']]);
});
it('owned_writer_preserves_proven_standard_fields',()=>{
  const score=authored(),source=new exporter.Gp7Exporter().export(score,settings),beforeBytes=source.slice(),beforeModel=JSON.stringify(model.JsonConverter.scoreToJson(score));
  const entries=unzipSync(source),doc=xml(source),other=doc.querySelector('Tracks')!.outerHTML;
  entries['Content/Assets/authored.bin']=new Uint8Array([0,255,1,47]);entries['meta.json']=strToU8('{"authored":true}');
  writeGpifNotation(score,doc);writeGpifNotation(score,doc);
  expect([...doc.querySelectorAll('Beats > Beat > XProperties > XProperty[id="1124204545"]')].map(n=>n.innerHTML)).toEqual(['<Int>1</Int>']);expect(fermatas(doc)).toEqual([['Short','0.5','0/1'],['Medium','1.25','29/320'],['Long','2','1/1']]);
  expect(doc.querySelector('Tracks')!.outerHTML).toBe(other);entries['Content/score.gpif']=strToU8(serialize(doc));const output=zipSync(entries),reopened=importer.ScoreLoader.loadScoreFromBytes(output,settings);
  expect(reopened.tracks[0].staves[0].bars[0].voices[0].beats[0].invertBeamDirection).toBe(true);expect([...reopened.masterBars[0].fermata!].map(([offset,f])=>[offset,f.type,f.length])).toEqual([[0,0,.5],[87,1,1.25],[960,2,2]]);
  expect(unzipSync(output)['Content/Assets/authored.bin']).toEqual(new Uint8Array([0,255,1,47]));expect(strFromU8(unzipSync(output)['meta.json'])).toBe('{"authored":true}');expect(source).toEqual(beforeBytes);expect(JSON.stringify(model.JsonConverter.scoreToJson(score))).toBe(beforeModel);
});
it('clears_only_owned_inversion_and_fermata_nodes_and_normalizes_duplicates',()=>{
  const score=music(),beat=score.tracks[0].staves[0].bars[0].voices[0].beats[0],doc=parse(readFileSync('src/interchange/fixtures/notation-authored.gpif','utf8'));
  doc.querySelector('Beat')!.setAttribute('id',String(beat.id));const sibling=doc.querySelector('XProperty[id="687935489"]')!.outerHTML,masterSibling=doc.querySelector('MasterBar > XProperties')!.outerHTML;
  writeGpifNotation(score,doc);expect(doc.querySelector('XProperty[id="1124204545"]')).toBeNull();expect(doc.querySelector('Fermatas')).toBeNull();expect(doc.querySelector('XProperty[id="687935489"]')!.outerHTML).toBe(sibling);expect(doc.querySelector('MasterBar > XProperties')!.outerHTML).toBe(masterSibling);
  beat.invertBeamDirection=true;writeGpifNotation(score,doc);const property=doc.querySelector('XProperty[id="1124204545"]')!;property.parentElement!.append(property.cloneNode(true));property.querySelector('Int')!.textContent='0';writeGpifNotation(score,doc);
  expect(doc.querySelectorAll('XProperty[id="1124204545"]').length).toBe(1);expect(doc.querySelector('XProperty[id="1124204545"] > Int')!.textContent).toBe('1');
  score.masterBars[0].fermata=new Map();writeGpifNotation(score,doc);expect(doc.querySelector('Fermatas')).toBeNull();
});
it('accepts_bounded_projections_and_missing_sections',()=>{
  const score=authored(),beat=score.tracks[0].staves[0].bars[0].voices[0].beats[0],doc=parse(`<GPIF><Beats><Beat id="${beat.id}"><XProperties/></Beat><Beat id="999999999"><XProperties><XProperty id="1124204545"><Int>1</Int></XProperty></XProperties></Beat></Beats></GPIF>`);
  writeGpifNotation(score,doc);expect(doc.querySelectorAll('XProperty[id="1124204545"]').length).toBe(2);expect(()=>writeGpifNotation(score,parse('<GPIF><Tracks/></GPIF>'))).not.toThrow();
  const masterOnly=parse('<GPIF><MasterBars><MasterBar><Time>4/4</Time></MasterBar></MasterBars></GPIF>');writeGpifNotation(score,masterOnly);expect(fermatas(masterOnly)).toHaveLength(3);
});
it('replaces_fermata_subtree_in_place_without_reordering_siblings',()=>{
  const score=authored(),doc=parse(readFileSync('src/interchange/fixtures/notation-authored.gpif','utf8'));writeGpifNotation(score,doc);expect([...doc.querySelector('MasterBar')!.children].map(n=>n.localName)).toEqual(['Time','Bars','Fermatas','XProperties']);
});
