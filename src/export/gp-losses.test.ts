// @vitest-environment jsdom
import { afterEach,describe,expect,it,vi } from 'vitest';
import { act,cleanup,renderHook } from '@testing-library/react';
import { model,Settings } from '@coderline/alphatab';
import { strToU8 } from 'fflate';
import { DocumentController } from '../controller';
import { blankProject,type EditCommand,type ProjectSnapshot } from '../project';
import type { NativeBridge } from '../bridge';
import type { DocumentSnapshot } from '../workspace/types';
import { music } from '../editor/fixtures';
import { defaultDocumentSettings } from '../document-settings';
import { convertScoreBytes,runBatch,type BatchBridge } from '../batch/convert';
import { curveLosses } from '../interchange/curves';
import { exportGpInterchange,loadInterchangeScore } from '../interchange/gp';
import { useExportCoordinator } from './useExportCoordinator';
import type { ExportNativeBridge } from './bridge';

vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(async()=>true)}));
afterEach(()=>{cleanup();vi.restoreAllMocks();});
const settings=new Settings();
const target={track:0,staff:0,bar:0,voice:0,beat:0};
/** A GP5-range whammy: five points down to -48, which Guitar Pro 5 holds and a GPIF file cannot. */
const longWhammy=[{offset:0,value:0},{offset:15,value:-12},{offset:30,value:-48},{offset:45,value:-24},{offset:60,value:0}];
const whammyEdit:EditCommand={type:'setBeatTechniques',target,patch:{whammy:{type:1,style:0,points:longWhammy}}};

function bridgeFor(edits:EditCommand[]) {
  const project={...blankProject(),edits};
  const current:ProjectSnapshot={project,canUndo:false,canRedo:false,dirty:false,path:null};
  const snapshot=():DocumentSnapshot=>({documentId:'document-a',revision:1,snapshot:{...structuredClone(current),redoEdit:null}});
  return {
    documentId:'document-a',snapshot:vi.fn(async()=>snapshot()),cancelAsset:vi.fn(async()=>true),readBackingAsset:vi.fn(),applyEdit:vi.fn(),setLock:vi.fn(),saveProject:vi.fn(async()=>null),
    exportGp:vi.fn(async()=>true),askUnsaved:async()=>'discard' as const,confirmExport:vi.fn(async()=>true),
  } as unknown as NativeBridge;
}
const twoVoiceXml=(second:string)=>strToU8(`<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>${second}</measure></part></score-partwise>`);
const crossVoice=twoVoiceXml(`<note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>half</type><notations><slur type="start" number="1"/></notations></note><note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>half</type></note><backup><duration>4</duration></backup><note><pitch><step>G</step><octave>3</octave></pitch><duration>2</duration><voice>2</voice><type>half</type></note><note><pitch><step>A</step><octave>3</octave></pitch><duration>2</duration><voice>2</voice><type>half</type><notations><slur type="stop" number="1"/></notations></note>`);
const sameChord=twoVoiceXml(`<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>whole</type><notations><slur type="start" number="1"/></notations></note><note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>whole</type><notations><slur type="stop" number="1"/></notations></note>`);

describe('what a Guitar Pro 7/8 export cannot keep',()=>{
  it('is listed by one pure function, shortest curves first when the cap is hit',()=>{
    const score=music(),notes=score.tracks[0].staves[0].bars.flatMap(bar=>bar.voices[0].beats.map(beat=>beat.notes[0]));
    const bend=(note:model.Note,count:number,value:number)=>{note.bendType=model.BendType.Custom;for(let index=0;index<count;index++)note.addBendPoint(new model.BendPoint(60*index/(count-1),index%2?value:1));};
    // Sixteen curves of 1024 points fill the cap exactly; a later 5-point curve over the limit is the one that is lost, only if it cannot fit.
    for(const note of notes.slice(0,16))bend(note,1024,2);
    score.finish(settings);
    expect(curveLosses(score)).toEqual([]);
    // A short curve arrives last in the score: on a second note of the final beat.
    const last=score.tracks[0].staves[0].bars[3].voices[0].beats[3],chord=new model.Note();chord.string=5;chord.fret=2;last.addNote(chord);
    chord.bendType=model.BendType.Custom;for(let index=0;index<5;index++)chord.addBendPoint(new model.BendPoint(15*index,index%2?2:1));
    score.finish(settings);
    // The cap is counted over curves above four points and ordered shortest first, so the late 5-point bend fits and one 1024-point bend goes, not the short curve that merely came last.
    const losses=curveLosses(score);
    expect(losses).toHaveLength(1);expect(losses[0]).toMatch(/1024-point bend/);expect(losses[0]).toMatch(/more than 16384 points/);
  });
  it('does not depend on where in the score the curves sit',()=>{
    const build=(whammyAt:number)=>{
      const score=music(),beats=score.tracks[0].staves[0].bars.flatMap(bar=>bar.voices[0].beats);
      for(const beat of beats){const note=beat.notes[0];note.bendType=model.BendType.Custom;for(let point=0;point<1024;point++)note.addBendPoint(new model.BendPoint(60*point/1023,point%2?2:1));}
      const holder=beats[whammyAt];holder.whammyBarType=model.WhammyType.Custom;for(let point=0;point<600;point++)holder.addWhammyBarPoint(new model.BendPoint(60*point/599,point%2?-2:-1));
      score.finish(settings);return curveLosses(score).map(text=>text.replace(/ at track.*? is left/,' is left'));
    };
    // 16 bends of 1024 and a 600-point whammy are 16984 points: the shortest curve is kept and exactly one bend goes, wherever the whammy is.
    expect(build(0)).toEqual(build(15));expect(build(0)).toHaveLength(1);
  });
  it('exports a GP5-range long whammy and a file past the cap instead of refusing, leaving them out of the property',()=>{
    const score=music(),beat=score.tracks[0].staves[0].bars[0].voices[0].beats[1];
    beat.whammyBarType=model.WhammyType.Custom;for(const point of longWhammy)beat.addWhammyBarPoint(new model.BendPoint(point.offset,point.value));score.finish(settings);
    expect(curveLosses(score)).toHaveLength(1);
    const bytes=exportGpInterchange(score,settings),loaded=loadInterchangeScore(bytes,settings);
    expect(loaded.tracks).toHaveLength(1);expect(loaded.masterBars).toHaveLength(4);
    const over=music(),notes=over.tracks[0].staves[0].bars.flatMap(bar=>bar.voices[0].beats.map(item=>item.notes[0]));
    for(const note of notes){note.bendType=model.BendType.Custom;for(let point=0;point<1024;point++)note.addBendPoint(new model.BendPoint(60*point/1023,point%2?2:1));}
    const top=over.tracks[0].staves[0].bars[0].voices[0].beats[0];top.whammyBarType=model.WhammyType.Custom;for(let point=0;point<1024;point++)top.addWhammyBarPoint(new model.BendPoint(60*point/1023,point%2?-2:-1));
    over.finish(settings);
    expect(curveLosses(over).length).toBeGreaterThan(0);
    expect(()=>exportGpInterchange(over,settings)).not.toThrow();
  });
});

describe('batch conversion',()=>{
  it('converts a MusicXML cross-voice slur and says what it left out',()=>{
    expect(Object.values(loadInterchangeScore(crossVoice,settings).tracks[0].staves[0].bars[0].voices).some(voice=>voice.beats.some(beat=>beat.notes.some(note=>note.slurDestination)))).toBe(true);
    const converted=convertScoreBytes(crossVoice);
    expect(converted.detail).toMatch(/left out of the Guitar Pro file: .*slur at track 1, bar 1, beat 1/);
    expect(loadInterchangeScore(converted.bytes,new Settings()).masterBars).toHaveLength(1);
  });
  it('converts a slur inside one chord and reports it',()=>{
    const converted=convertScoreBytes(sameChord);
    expect(converted.detail).toMatch(/left out of the Guitar Pro file: .*slur/);
  });
  it('reports the converted row with its note, not as Failed',async()=>{
    const rows=await runBatch({bridge:{read:async()=>crossVoice,write:async()=>({relative:'a.gp',renamed:false})} as unknown as BatchBridge,scan:{files:[{index:0,relative:'a.xml'}],skipped:[],truncated:false} as never,keepFolders:false,cancelled:()=>false,onProgress:()=>undefined,probe:async()=>({ok:true}) as never});
    expect(rows).toEqual([expect.objectContaining({status:'Converted',detail:expect.stringContaining('left out of the Guitar Pro file')})]);
  });
  it('adds no note when nothing is left out',()=>{
    expect(convertScoreBytes(twoVoiceXml(`<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>`)).detail).not.toContain('left out');
  });
});

describe('the app asks before writing',()=>{
  it('the document export asks once, with the losses, before the file is written',async()=>{
    const bridge=bridgeFor([whammyEdit]),controller=await DocumentController.create(bridge);
    await controller.export();
    const confirm=vi.mocked(bridge.confirmExport),write=vi.mocked(bridge.exportGp);
    expect(confirm).toHaveBeenCalledTimes(1);expect(confirm.mock.calls[0][0]?.message).toMatch(/Left out of this file: .*5-point whammy bar at track 1, bar 1, beat 1/);
    expect(write).toHaveBeenCalledTimes(1);expect(confirm.mock.invocationCallOrder[0]).toBeLessThan(write.mock.invocationCallOrder[0]);
  });
  it('the document export asks the plain question, and writes nothing if declined',async()=>{
    const plain=bridgeFor([]),controller=await DocumentController.create(plain);await controller.export();
    expect(vi.mocked(plain.confirmExport).mock.calls[0]).toEqual([]);
    const declined=bridgeFor([whammyEdit]);vi.mocked(declined.confirmExport).mockResolvedValue(false);
    await (await DocumentController.create(declined)).export();expect(declined.exportGp).not.toHaveBeenCalled();
  });
  it('the export dialog asks once, with the losses of the selected tracks, before the file is written',async()=>{
    const score=music(),beat=score.tracks[0].staves[0].bars[0].voices[0].beats[1];
    beat.whammyBarType=model.WhammyType.Custom;for(const point of longWhammy)beat.addWhammyBarPoint(new model.BendPoint(point.offset,point.value));score.finish(settings);
    const confirmExport=vi.fn(async(_detail?:{title:string;message:string})=>true),exportGp=vi.fn(async()=>true);
    const native={exportGp5:async()=>true} as unknown as ExportNativeBridge;
    const {result}=renderHook(()=>useExportCoordinator({revision:3,score,settings:defaultDocumentSettings(),currentSpeed:1,bridge:{confirmExport,readBackingAsset:vi.fn(),exportGp},native}));
    await act(async()=>{expect(await result.current.run({format:'gp',selection:{tracks:[0],range:null}})).toBe(true);});
    expect(confirmExport).toHaveBeenCalledTimes(1);expect(confirmExport.mock.calls[0][0]?.message).toMatch(/5-point whammy bar/);
    expect(confirmExport.mock.invocationCallOrder[0]).toBeLessThan(exportGp.mock.invocationCallOrder[0]);
  });
});
