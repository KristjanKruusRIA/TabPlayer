import { readFileSync } from 'node:fs';
import { expect,it } from 'vitest';
import { exporter,importer,model,Settings } from '@coderline/alphatab';
import { strFromU8,strToU8,unzipSync,zipSync } from 'fflate';
import type { HarmonyChord } from '../editor/harmony-types';
import { music,noteAt,target } from '../editor/fixtures';
import { applyHarmonyEdit } from '../harmony/edits';
import { getHarmonyChord } from '../harmony/chord-source';
import { readGpifHarmony,writeGpifHarmony } from './harmony';
import { projectGpifTracks } from './xml';

const settings=new Settings(),path='Content/score.gpif';
const parse=(xml:string)=>new DOMParser().parseFromString(xml,'application/xml');
const serialize=(doc:Document)=>new XMLSerializer().serializeToString(doc);
const raw=(score:model.Score)=>unzipSync(new exporter.Gp7Exporter().export(score,settings));
const fixture=()=>parse(readFileSync('src/interchange/fixtures/harmony-authored.gpif','utf8'));
const definition=():HarmonyChord=>({name:'Cm',nameMode:'theory',recipe:{root:{step:0,alteration:0},formula:'minor',alterations:[],omissions:[],bass:null},firstFret:3,frets:[3,4,5,5,3,-1],fingers:[1,2,3,4,1,0],barreFrets:[3],showName:false,showDiagram:true,showFingering:false});
function authored(alias:'Ring'|'Rank'='Ring') {
  const score=music(),chord=new model.Chord();chord.name='Cm';chord.firstFret=3;chord.strings=[3,4,5,5,3,-1];chord.barreFrets=[3];score.tracks[0].staves[0].addChord('cm',chord);noteAt(score).beat.chordId='cm';
  const entries=raw(score),doc=parse(strFromU8(entries[path]));for(const name of ['DiagramCollection','DiagramWorkingSet']){
    const source=fixture().querySelector(`Property[name="${name}"]`)!;const replacement=doc.importNode(source,true) as Element;for(const position of replacement.querySelectorAll('Position[finger="Ring"], Position[finger="Rank"]'))position.setAttribute('finger',alias);
    doc.querySelector(`Track > Staves > Staff > Properties > Property[name="${name}"]`)!.replaceWith(replacement);
  }
  entries[path]=strToU8(serialize(doc));return zipSync(entries);
}
function roundtrip(value:HarmonyChord) {
  const score=music();applyHarmonyEdit(score,{type:'setHarmonyChord',target,chord:value,fillEmptyBeat:false},4);const entries=raw(score),doc=parse(strFromU8(entries[path]));writeGpifHarmony(score,doc);entries[path]=strToU8(serialize(doc));
  const reopened=importer.ScoreLoader.loadScoreFromBytes(zipSync(entries),settings);readGpifHarmony(reopened,doc);return {native:getHarmonyChord(noteAt(score).beat.chord!),gp:getHarmonyChord(noteAt(reopened).beat.chord!)};
}

it.each(['Ring','Rank'] as const)('imports_authored_public_fields_and_%s_alias_without_touching_music',alias=>{
  const bytes=authored(alias),before=bytes.slice(),score=importer.ScoreLoader.loadScoreFromBytes(bytes,settings),json=model.JsonConverter.scoreToJson(score),doc=parse(strFromU8(unzipSync(bytes)[path]));
  readGpifHarmony(score,parse(projectGpifTracks(serialize(doc))!.xml));
  expect(getHarmonyChord(noteAt(score).beat.chord!)).toEqual({...definition(),nameMode:'manual',recipe:null});expect(model.JsonConverter.scoreToJson(score)).toBe(json);expect(bytes).toEqual(before);
});

it('writes_explicit_fingers_and_literal_reversed_string_relative_fret_fields_in_both_sets',()=>{
  const score=music();applyHarmonyEdit(score,{type:'setHarmonyChord',target,chord:definition(),fillEmptyBeat:false},4);const entries=raw(score),doc=parse(projectGpifTracks(strFromU8(entries[path]))!.xml),before=model.JsonConverter.scoreToJson(score);
  writeGpifHarmony(score,doc);
  for(const name of ['DiagramCollection','DiagramWorkingSet']){
    const item=doc.querySelector(`Property[name="${name}"] > Items > Item`)!;expect(item.getAttribute('name')).toBe('Cm');const diagram=item.querySelector('Diagram')!;
    expect(diagram.getAttribute('baseFret')).toBe('2');expect(diagram.getAttribute('stringCount')).toBe('6');
    expect([...diagram.querySelectorAll(':scope > Fret')].map(node=>[node.getAttribute('string'),node.getAttribute('fret')])).toEqual([['5','1'],['4','2'],['3','3'],['2','3'],['1','1']]);
    expect([...diagram.querySelectorAll('Fingering > Position')].map(node=>[node.getAttribute('finger'),node.getAttribute('fret'),node.getAttribute('string')])).toEqual([['Index','1','5'],['Index','1','1'],['Middle','2','4'],['Ring','3','3'],['Pinky','3','2'],['Thumb','-3','0']]);
    expect([...diagram.querySelectorAll(':scope > Property')].map(node=>[node.getAttribute('name'),node.getAttribute('value')])).toEqual([['ShowName','false'],['ShowDiagram','true'],['ShowFingering','false']]);
    expect([...diagram.children].map(node=>node.tagName)).toEqual(['Fret','Fret','Fret','Fret','Fret','Fingering','Property','Property','Property','Chord']);
    // The public exporter emits this C-major placeholder even for Cm. The adapter must not invent theory metadata.
    expect(diagram.querySelector('Chord > Degree[interval="Third"]')?.getAttribute('alteration')).toBe('Major');expect(diagram.querySelectorAll('Chord')).toHaveLength(1);
  }
  expect(model.JsonConverter.scoreToJson(score)).toBe(before);expect(serialize(doc)).not.toMatch(/TabPlayer|ScaleDiagram|recipe/);
});

it('public_gp_reopen_preserves_shape_flags_and_compatible_barre_while_owned_reader_recovers_fingers_without_recipe',()=>{
  const score=music();applyHarmonyEdit(score,{type:'setHarmonyChord',target,chord:definition(),fillEmptyBeat:false},4);const entries=raw(score),doc=parse(strFromU8(entries[path]));writeGpifHarmony(score,doc);entries[path]=strToU8(serialize(doc));const bytes=zipSync(entries),reopened=importer.ScoreLoader.loadScoreFromBytes(bytes,settings),chord=noteAt(reopened).beat.chord!;
  expect(chord.name).toBe('Cm');expect(chord.firstFret).toBe(3);expect(chord.strings).toEqual([3,4,5,5,3,-1]);expect(chord.barreFrets).toEqual([3]);expect([chord.showName,chord.showDiagram,chord.showFingering]).toEqual([false,true,false]);
  expect(getHarmonyChord(chord).fingers).toEqual([-2,-2,-2,-2,-2,-2]);readGpifHarmony(reopened,doc);expect(getHarmonyChord(chord)).toEqual({...definition(),nameMode:'manual',recipe:null});expect(getHarmonyChord(noteAt(score).beat.chord!).nameMode).toBe('theory');
});

it('reads_working_set_only_definitions_and_keeps_unrelated_existing_definitions',()=>{
  const score=music(),doc=fixture();doc.querySelector('Property[name="DiagramCollection"]')!.remove();doc.querySelector('MasterTrack > Tracks')!.textContent='42';const legacy=new model.Chord();legacy.name='untouched';score.tracks[0].staves[0].addChord('legacy',legacy);
  readGpifHarmony(score,doc);expect(getHarmonyChord(score.tracks[0].staves[0].getChord('cm')!)).toEqual({...definition(),nameMode:'manual',recipe:null});expect(score.tracks[0].staves[0].getChord('legacy')).toBe(legacy);
});

it('preserves_first_fret_zero_wide_hidden_and_zero_string_name_only_standard_fields',()=>{
  for(const frets of [[0,30,2,-1,19,0],[]]){
    const score=music();if(!frets.length)score.tracks[0].staves[0].stringTuning.tunings=[];
    const value:HarmonyChord={...definition(),name:' legacy ',nameMode:'manual',recipe:null,firstFret:0,frets,fingers:frets.map(()=>-1),barreFrets:[],showName:false,showDiagram:false,showFingering:false};applyHarmonyEdit(score,{type:'setHarmonyChord',target,chord:value,fillEmptyBeat:false},5);
    const entries=raw(score),doc=parse(strFromU8(entries[path]));writeGpifHarmony(score,doc);entries[path]=strToU8(serialize(doc));const reopened=importer.ScoreLoader.loadScoreFromBytes(zipSync(entries),settings);readGpifHarmony(reopened,doc);expect(getHarmonyChord(noteAt(reopened).beat.chord!)).toEqual(value);
  }
});

it('preserves_declared_order_of_coherent_compatible_explicit_barres_using_position_order',()=>{
  const value:HarmonyChord={...definition(),name:'manual',nameMode:'manual',recipe:null,fingers:[1,2,3,3,1,-2],barreFrets:[3,5]},result=roundtrip(value);
  expect(result.gp).toEqual(value);expect(result.native).toEqual(value);
});

it('reads_a_single_compatible_f_barre_once_when_three_strings_use_its_index_finger',()=>{
  const value:HarmonyChord={...definition(),name:'F',nameMode:'manual',recipe:null,firstFret:1,frets:[1,1,2,3,3,1],fingers:[1,1,2,4,3,1],barreFrets:[1],showName:true,showDiagram:true,showFingering:true},result=roundtrip(value);
  expect(result.gp).toEqual(value);expect(result.native).toEqual(value);
});

it.each([
  ['no_fingers_with_a_declared_barre',[-1,-1,-1,-1,-1,-1],[3],[-1,-1,-1,-1,-1,-1],[]],
  ['unknown_fingers_with_a_declared_barre',[-2,-2,-2,-2,-2,-2],[3],[1,-2,-2,-2,1,-2],[3]],
  ['repeated_explicit_finger_without_a_declared_barre',[1,2,3,4,1,0],[],[1,2,3,4,1,0],[3]],
] as Array<[string,number[],number[],number[],number[]]>)('documents_standard_gp_only_limit_%s_without_normalizing_the_native_snapshot',(_,fingers,barreFrets,gpFingers,gpBarres)=>{
  const value:HarmonyChord={...definition(),name:'manual',nameMode:'manual',recipe:null,fingers,barreFrets},result=roundtrip(value);
  // Standard Positions couple repeated fingers to barres; native snapshots store these independently.
  expect(result.gp).toEqual({...value,fingers:gpFingers,barreFrets:gpBarres});expect(result.native).toEqual(value);
});
