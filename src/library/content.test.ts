import {readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {midi,model,Settings} from '@coderline/alphatab';
import {buildDocument,previewEdit,trackIdentity,validateProject} from '../engine';
import {buildPlaybackPlan,validatePlaybackPlan} from '../audio/plan';
import {tuningPresets} from '../tuning-presets';
import type {LibraryContent} from './types';

type Descriptor=LibraryContent&{path:string};
const root=new URL('../../assets/library/',import.meta.url);
const manifest=JSON.parse(readFileSync(new URL('manifest.json',root),'utf8')) as {format:string;version:number;templates:Descriptor[];examples:Descriptor[];documents:{path:string;sha256:string}[]};
const load=(item:Descriptor)=>validateProject(JSON.parse(readFileSync(new URL(item.path,root),'utf8')));
const expectedFactories=[
  ['factory-guitar-6','guitar-6-standard-e',25],['factory-guitar-7','guitar-7-standard-b',25],
  ['factory-guitar-8','guitar-8-standard-fsharp',25],['factory-guitar-9','guitar-9-standard-csharp',25],
  ['factory-bass-4','bass-4-standard-e',33],['factory-bass-5','bass-5-standard-b',33],['factory-bass-6','bass-6-standard-b',33],
] as const;
const allBeats=(score:model.Score)=>score.tracks.flatMap(t=>t.staves.flatMap(s=>s.bars.flatMap(b=>b.voices.flatMap(v=>v.beats))));
const allNotes=(score:model.Score)=>allBeats(score).flatMap(b=>b.notes);

describe('original bundled library',()=>{
  it('ships the ten real factory categories and three specified ensembles',()=>{
    expect(manifest.format).toBe('TabPlayerBundledLibrary');expect(manifest.version).toBe(1);
    expect(manifest.templates.map(x=>x.id)).toEqual([...expectedFactories.map(x=>x[0]),'factory-keys','factory-drums','factory-band']);
    expect(manifest.examples.map(x=>x.id)).toEqual(['example-windowline','example-seven-steps-five-echoes','example-lantern-counterpoint']);
  });

  it.each(expectedFactories)('%s uses the existing tuning, staff, layout and native sound', (id,presetId,program)=>{
    const item=manifest.templates.find(x=>x.id===id);expect(item,`Missing ${id}`).toBeDefined();
    const project=load(item!),{score,settings}=buildDocument(project),track=score.tracks[0],staff=track.staves[0];
    expect(score.tracks).toHaveLength(1);expect(track.playbackInfo.program).toBe(program);
    expect(staff.tuning).toEqual(tuningPresets.find(x=>x.id===presetId)!.tuning);expect(staff.isPercussion).toBe(false);
    expect(staff.showTablature).toBe(true);expect(staff.showStandardNotation).toBe(true);
    expect(staff.bars[0].clef).toBe(program===33?model.Clef.F4:model.Clef.G2);
    expect(track.defaultSystemsLayout).toBe(4);expect(settings.sounds[trackIdentity(track)]).toMatchObject({voiceId:program===33?'darkblack-bass':'green-guitar',presetId:program===33?'bass':'clean'});
  });

  it('keys and drums are actual non-tab staves and band has four instruments',()=>{
    const get=(id:string)=>{const item=manifest.templates.find(x=>x.id===id);expect(item).toBeDefined();return buildDocument(load(item!));};
    const keys=get('factory-keys');expect(keys.score.tracks).toHaveLength(1);expect(keys.score.tracks[0].playbackInfo.program).toBe(0);
    expect(keys.score.tracks[0].staves.map(s=>[s.tuning,s.showTablature,s.showStandardNotation,s.isPercussion,s.bars[0].clef])).toEqual([[[],false,true,false,model.Clef.G2],[[],false,true,false,model.Clef.F4]]);
    const drums=get('factory-drums');expect(drums.score.tracks).toHaveLength(1);expect(drums.score.tracks[0].staves[0].isPercussion).toBe(true);expect(drums.score.tracks[0].playbackInfo.primaryChannel).toBe(9);
    expect(drums.score.tracks[0].staves[0].tuning).toEqual([]);expect(drums.score.tracks[0].staves[0].bars[0].clef).toBe(model.Clef.Neutral);
    const band=get('factory-band');expect(band.score.tracks.map(t=>[t.name,t.playbackInfo.program,t.staves[0].isPercussion,t.staves[0].tuning.length])).toEqual([['6-string guitar',25,false,6],['4-string bass',33,false,4],['Drums',0,true,0],['Keys',0,false,0]]);
    for(const built of [keys,drums,band])for(const track of built.score.tracks)expect(built.settings.sounds[trackIdentity(track)]).toBeDefined();
  });

  it('every factory is a useful empty immutable baseline with no user undo edits',()=>{
    expect(manifest.templates).toHaveLength(10);
    for(const item of manifest.templates){const project=load(item),built=buildDocument(project);expect(project.schemaVersion).toBe(3);expect(project.baselineEdits.length).toBeGreaterThan(2);expect(project.edits).toEqual([]);expect(built.score.masterBars.length).toBeGreaterThanOrEqual(4);expect(allNotes(built.score)).toEqual([]);expect(allBeats(built.score).length).toBeGreaterThanOrEqual(16);expect(allBeats(built.score).every(b=>b.isRest)).toBe(true);}
  });

  it('builds every example into eight full playable measures with authored rhythms and articulations',()=>{
    expect(manifest.examples).toHaveLength(3);
    const expected=[[[6,false],[4,false],[0,true]],[[0,true]],[[0,false],[7,false]]];
    for(const [index,item] of manifest.examples.entries()){
      const project=load(item),built=buildDocument(project),score=built.score,before=JSON.stringify(project);
      expect(project.edits).toEqual([]);expect(score.masterBars).toHaveLength(8);
      expect(score.tracks.map(t=>[t.staves[0].tuning.length,t.staves[0].isPercussion])).toEqual(expected[index]);
      expect(score.tracks.map(t=>t.name)).toEqual(item.instruments);
      expect(allNotes(score).length).toBeGreaterThanOrEqual(32);
      expect(new Set(allBeats(score).filter(b=>b.notes.length).map(b=>`${b.duration}/${b.dots}`)).size).toBeGreaterThanOrEqual(2);
      expect(allNotes(score).some(n=>n.isStaccato||n.isPalmMute||n.accentuated>0||n.isGhost)).toBe(true);
      expect(new Set(allNotes(score).map(n=>n.isPercussion?n.percussionArticulation:n.realValue)).size).toBeGreaterThanOrEqual(5);
      for(const track of score.tracks)for(const staff of track.staves)for(const bar of staff.bars)for(const voice of bar.voices){
        expect(voice.beats.reduce((n,b)=>n+(b.isEmpty?0:b.playbackDuration),0)).toBe(score.masterBars[bar.index].calculateDuration(false));
      }
      const file=new midi.MidiFile(),handler=new midi.AlphaSynthMidiFileHandler(file,true);new midi.MidiFileGenerator(score,new Settings(),handler).generate();expect(file.toBinary().length).toBeGreaterThan(300);
      const plan=buildPlaybackPlan(score,1);validatePlaybackPlan(plan);expect(plan.occurrences.map(o=>o.bar)).toEqual([0,1,2,3,4,5,6,7]);
      expect(plan.notes.length).toBeGreaterThanOrEqual(32);expect(plan.notes.every(n=>n.endTick>n.startTick&&n.velocity>0)).toBe(true);
      const firstKeys=[[40,28,36],[35],[65,50]][index];
      for(const [trackIndex,track] of score.tracks.entries()){
        const id=trackIdentity(track),attacks=plan.notes.filter(n=>n.trackId===id&&n.source.target.bar===0&&n.source.target.beat===0&&n.source.target.staff===0);
        expect(attacks.map(n=>n.key)).toContain(firstKeys[trackIndex]);expect(plan.tracks.find(t=>t.id===id)).toMatchObject({program:track.playbackInfo.program,percussion:track.staves[0].isPercussion});
        if(track.staves[0].isPercussion)expect(plan.notes.filter(n=>n.trackId===id).every(n=>n.channel===9)).toBe(true);
      }
      const next=previewEdit(project,{type:'setScoreInfo',title:'Independent working copy',artist:'',tempo:107});expect(next.project.edits).toHaveLength(1);expect(next.project.baselineEdits).toEqual(project.baselineEdits);expect(JSON.stringify(project)).toBe(before);
    }
    const odd=buildDocument(load(manifest.examples[1])).score;expect(odd.masterBars.map(b=>[b.timeSignatureNumerator,b.timeSignatureDenominator])).toEqual([[7,8],[5,8],[7,8],[5,8],[7,8],[5,8],[7,8],[5,8]]);
  });

  it('pins exact offline native project bytes, metadata and dedication without private sources',()=>{
    const entries=[...manifest.templates,...manifest.examples];expect(entries).toHaveLength(13);
    expect(new Set(entries.map(x=>x.id)).size).toBe(13);expect(manifest.documents.map(x=>x.path)).toEqual(['README.md','CC0-1.0.txt']);
    for(const item of [...entries,...manifest.documents]){const bytes=readFileSync(new URL(item.path,root));expect(createHash('sha256').update(bytes).digest('hex')).toBe(item.sha256);}
    for(const item of entries){expect(item.license).toBe('CC0-1.0');expect(item.origin).toBe(manifest.templates.includes(item)?'factory':'example');expect(item.path).toMatch(/^(templates|examples)\/[a-z0-9-]+\.tabplayer$/);
      const project=load(item);expect(project.base.kind).toBe('blank');expect(project.assets).toEqual({});expect(JSON.stringify(project)).not.toMatch(/https?:|file:|[a-z]:[\\/]|bytesBase64|backing|vendor|copyrighted/i);
      const score=buildDocument(project).score;expect(score.title).toBe(item.title);expect(score.tracks.map(t=>t.name)).toEqual(item.instruments);
      expect(Object.keys(project).sort()).toEqual(['assets','base','baselineEdits','edits','engineVersion','format','schemaVersion']);
    }
    expect(readdirSync(new URL('templates/',root)).sort()).toEqual(manifest.templates.map(x=>x.path.split('/')[1]).sort());expect(readdirSync(new URL('examples/',root)).sort()).toEqual(manifest.examples.map(x=>x.path.split('/')[1]).sort());
  });
});
