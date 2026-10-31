// @vitest-environment jsdom
import {describe,expect,it} from 'vitest';
import {model,Settings} from '@coderline/alphatab';
import {strFromU8,unzipSync} from 'fflate';
import {music} from '../editor/fixtures';
import {unequalPickupScore} from '../audio/pickup.performance.fixture';
import {backingLocationsForScore,buildPlaybackPlan} from '../audio/plan';
import {scoreTickToAudioMs} from '../audio/backing-timeline';
import {defaultDocumentSettings,defaultMix} from '../document-settings';
import type {BackingFilter,BackingSettings} from '../edit-types';
import type {ExportSelection} from '../export/types';
import {exportGpInterchange,loadInterchangeScore} from './gp';
import {gpBackingSelectionIssue,projectGpDocument} from './backing-projection';

const full:ExportSelection={tracks:[0],range:null},bytes=new Uint8Array([9,8,7]),settings=new Settings();
const backing=(fields:Partial<BackingSettings>={}):BackingSettings=>({assetId:'a'.repeat(64),offsetMs:0,anchors:[],mix:defaultMix(),...fields});
function score120(){const score=music();score.masterBars[0].tempoAutomations=[model.Automation.buildTempoAutomation(false,0,120,2)];return score;}
function project(score:model.Score,value:BackingSettings|null,selection=full,include=true,asset:Uint8Array|null=bytes){return projectGpDocument({score,settings:{...defaultDocumentSettings(),backing:value},selection,backing:include,bytes:asset});}
const points=(score:model.Score)=>score.exportFlatSyncPoints().sort((a,b)=>a.millisecondOffset-b.millisecondOffset);
const round=(score:model.Score)=>loadInterchangeScore(exportGpInterchange(score,settings),settings);
const processingIssue='Backing pitch and filters cannot be stored in this Guitar Pro export. Clear Include backing audio to export notation.';
const filters:BackingFilter[]=['none','bassEnhance','bassAttenuation','mediumEnhance','mediumAttenuation','highEnhance','highAttenuation'];
function repeated(){const score=score120();score.masterBars[0].isRepeatStart=true;score.masterBars[1].repeatCount=2;score.rebuildRepeatGroups();score.finish(settings);return score;}
function grace(){const score=score120(),voice=score.tracks[0].staves[0].bars[0].voices[0],beat=new model.Beat();beat.duration=model.Duration.Eighth;beat.graceType=model.GraceType.BeforeBeat;beat.isEmpty=false;const note=new model.Note();note.string=1;note.fret=0;beat.addNote(note);beat.voice=voice;voice.beats.unshift(beat);score.finish(settings);return score;}
function physicalAt(score:model.Score,tick:number){const anchors=score.exportFlatSyncPoints().map(p=>({bar:p.barIndex,occurrence:p.barOccurence,ratio:p.barPosition,audioMs:p.millisecondOffset})),offsetMs=Math.max(0,...anchors.map(p=>-p.audioMs));return scoreTickToAudioMs(buildPlaybackPlan(score,1),{offsetMs,anchors:anchors.map(p=>({...p,audioMs:p.audioMs+offsetMs}))},tick);}

describe('current document GP backing projection',()=>{
  it.each(filters.flatMap(filter=>[false,true].map(direct=>({filter,direct}))))('guards included $filter processing (direct=$direct) for full and excerpt selections',({filter,direct})=>{
    for(const selection of [full,{tracks:[0],range:{first:1,last:1}}])for(const [semitones,cents]of [[1,-50],[-1,50],[0,1],[0,0]]){
      if(filter==='none'&&semitones===0&&cents===0)continue;
      const score=score120(),value=backing({processing:{semitones,cents,filter}}),before=model.JsonConverter.scoreToJson(score),stored=structuredClone(value);
      if(direct){expect(()=>project(score,value,selection)).toThrow(processingIssue);expect(()=>project(score,value,selection,true,null)).toThrow(processingIssue);}
      else expect(gpBackingSelectionIssue(score,value,selection)).toBe(processingIssue);
      expect(model.JsonConverter.scoreToJson(score)).toBe(before);expect(value).toEqual(stored);
    }
  });
  it.each([[0,0],[-1,100],[1,-100]])('includes unchanged raw bytes for neutral pair %s/%s', (semitones,cents)=>{
    for(const selection of [full,{tracks:[0],range:{first:1,last:1}}]){
      const score=score120(),value=backing({processing:{semitones,cents,filter:'none'}}),stored=structuredClone(value),out=project(score,value,selection);
      expect(gpBackingSelectionIssue(score,value,selection)).toBeNull();expect(out.backingTrack?.rawAudioFile).toEqual(bytes);expect(out.backingTrack?.rawAudioFile).not.toBe(bytes);
      expect(round(out).backingTrack?.rawAudioFile).toEqual(bytes);expect(value).toEqual(stored);
    }
  });
  it.each(filters)('explicit omission bypasses %s processing, unavailable bytes and invalid mapping without mutation',filter=>{
    const score=repeated();score.backingTrack=new model.BackingTrack();score.backingTrack.rawAudioFile=new Uint8Array([1,2,3]);score.applyFlatSyncPoints([{barIndex:1,barOccurence:99,barPosition:.5,millisecondOffset:3000}]);
    const value=backing({processing:{semitones:12,cents:100,filter},offsetMs:NaN,anchors:[{bar:999,occurrence:99,ratio:2,audioMs:-1}]}),stored=structuredClone(value),before=model.JsonConverter.scoreToJson(score);
    const input={score,settings:{...defaultDocumentSettings(),backing:value},selection:{tracks:[0],range:{first:1,last:1}},backing:false,get bytes():Uint8Array|null{throw new Error('Omission must not read bytes.');}},out=projectGpDocument(input);
    expect(out.masterBars).toHaveLength(1);expect(out.backingTrack).toBeUndefined();expect(out.exportFlatSyncPoints()).toEqual([]);expect(round(out).backingTrack).toBeUndefined();
    expect(model.JsonConverter.scoreToJson(score)).toBe(before);expect(value).toEqual(stored);expect(score.backingTrack.rawAudioFile).toEqual(new Uint8Array([1,2,3]));
  });
  it('detaches current bytes and replaces stale original sync without changing score, settings or assets',()=>{
    const score=score120();score.backingTrack=new model.BackingTrack();score.backingTrack.rawAudioFile=new Uint8Array([1,2,3]);score.applyFlatSyncPoints([{barIndex:0,barOccurence:9,barPosition:.5,millisecondOffset:999}]);
    const value=backing({offsetMs:-120,anchors:[{bar:0,occurrence:0,ratio:1/3,audioMs:2000}]}),before=model.JsonConverter.scoreToJson(score),stored=structuredClone(value),asset=bytes.slice();
    const out=project(score,value),again=round(out);
    expect(out).not.toBe(score);expect(out.backingTrack?.rawAudioFile).toEqual(asset);expect(out.backingTrack?.rawAudioFile).not.toBe(bytes);expect(again.backingTrack?.rawAudioFile).toEqual(asset);
    expect(points(out)).toContainEqual({barIndex:0,barOccurence:0,barPosition:1/3,millisecondOffset:2120});expect(points(out).every(p=>p.barOccurence===0)).toBe(true);
    expect(model.JsonConverter.scoreToJson(score)).toBe(before);expect(value).toEqual(stored);expect(bytes).toEqual(asset);expect(score.backingTrack.rawAudioFile).toEqual(new Uint8Array([1,2,3]));
  });
  it('uses immutable original embedded bytes when the effective asset is embedded',()=>{
    const score=score120();score.backingTrack=new model.BackingTrack();score.backingTrack.rawAudioFile=new Uint8Array([1,2,3]);
    const out=project(score,backing({assetId:'embedded',offsetMs:-120}),full,true,null);
    expect(out.backingTrack?.rawAudioFile).toEqual(new Uint8Array([1,2,3]));expect(points(out)[0].millisecondOffset).toBe(120);
  });
  it('requires captured bytes for an active committed asset',()=>{expect(()=>project(score120(),backing(),full,true,null)).toThrow(/bytes|audio/i);});
  it('explicit removal clears backing and every stale point after notation selection',()=>{
    const score=repeated();score.backingTrack=new model.BackingTrack();score.backingTrack.rawAudioFile=new Uint8Array([1,2,3]);score.applyFlatSyncPoints([{barIndex:1,barOccurence:1,barPosition:.5,millisecondOffset:3000}]);
    const out=project(score,null,{tracks:[0],range:{first:1,last:1}});
    expect(out.masterBars).toHaveLength(1);expect(out.backingTrack).toBeUndefined();expect(out.exportFlatSyncPoints()).toEqual([]);expect(round(out).backingTrack).toBeUndefined();
  });
  it('omission bypasses even an invalid source map while retaining selected notation',()=>{
    const score=repeated();score.applyFlatSyncPoints([{barIndex:1,barOccurence:99,barPosition:.5,millisecondOffset:3000}]);
    const out=project(score,backing({offsetMs:NaN,anchors:[{bar:999,occurrence:99,ratio:2,audioMs:-1}]}),{tracks:[0],range:{first:1,last:1}},false,null);
    expect(out.masterBars).toHaveLength(1);expect(out.backingTrack).toBeUndefined();expect(out.exportFlatSyncPoints()).toEqual([]);expect(()=>exportGpInterchange(out,settings)).not.toThrow();
  });
  it('preserves offset-only physical source origin for an excerpt',()=>{
    const out=project(score120(),backing({offsetMs:250}),{tracks:[0],range:{first:2,last:2}});
    expect(points(out)).toEqual([{barIndex:0,barOccurence:0,barPosition:0,millisecondOffset:3750},{barIndex:0,barOccurence:0,barPosition:1,millisecondOffset:5750}]);
    const reopened=round(out);expect(physicalAt(reopened,0)).toBeCloseTo(3750,8);expect(physicalAt(reopened,3840)).toBeCloseTo(5750,8);
  });
  it('interpolates cut boundaries even with no original interior anchor in the selected range',()=>{
    const value=backing({anchors:[{bar:0,occurrence:0,ratio:0,audioMs:1000},{bar:3,occurrence:0,ratio:1,audioMs:9000}]}),out=project(score120(),value,{tracks:[0],range:{first:2,last:2}});
    expect(points(out).map(p=>p.millisecondOffset)).toEqual([5000,7000]);
  });
  it('keeps arbitrary source and authored-tempo breakpoints with receiving seam ownership',()=>{
    const score=score120();score.masterBars[0].tempoAutomations.push(model.Automation.buildTempoAutomation(false,3/8,60,2));
    const out=project(score,backing({anchors:[{bar:0,occurrence:0,ratio:1/3,audioMs:1000},{bar:1,occurrence:0,ratio:0,audioMs:5000}]}));
    expect(points(out).filter(p=>p.barIndex===0).map(p=>p.barPosition)).toEqual([0,1/3,3/8]);expect(points(out).filter(p=>p.millisecondOffset===5000)).toEqual([{barIndex:1,barOccurence:0,barPosition:0,millisecondOffset:5000}]);
    const doc=new DOMParser().parseFromString(strFromU8(unzipSync(exportGpInterchange(out,settings))['Content/score.gpif']),'application/xml'),sync=[...doc.querySelectorAll('MasterTrack > Automations > Automation')].filter(n=>n.querySelector('Type')?.textContent==='SyncPoint');
    expect(sync.some(n=>n.querySelector('Position')?.textContent===String(1/3))).toBe(true);expect(sync.some(n=>n.querySelector('Position')?.textContent==='0.375')).toBe(true);
    const reopened=round(out);expect(reopened.masterBars[0].tempoAutomations.map(p=>[p.ratioPosition,p.value])).toEqual([[0,120],[3/8,60]]);
    // The authored 60-BPM change at tick1440 splits score time inside the wider source span.
    for(const [tick,sourceMs]of [[0,-1000/31],[1280,1000],[1360,33000/31],[1440,35000/31],[3840,5000]])expect(Math.abs(physicalAt(reopened,tick)-sourceMs)*44.1).toBeLessThan(1.5);
  });
  it('writes 44.1k frame padding and offsets with the general absolute error bound',()=>{
    const score=score120(),out=project(score,backing({anchors:[{bar:0,occurrence:0,ratio:0,audioMs:1000.01},{bar:0,occurrence:0,ratio:.5,audioMs:2500.02}]}));
    const archive=exportGpInterchange(out,settings),doc=new DOMParser().parseFromString(strFromU8(unzipSync(archive)['Content/score.gpif']),'application/xml');
    expect(doc.querySelector('BackingTrack > FramePadding')?.textContent).toBe('-44100');expect([...doc.querySelectorAll('Value > FrameOffset')].map(n=>Number(n.textContent))).toContain(66150);
    const once=loadInterchangeScore(archive,settings),twice=round(once);expect(points(once).slice(0,2).map(p=>p.millisecondOffset)).toEqual([1000,2500]);expect(points(twice)).toEqual(points(once));
    for(const [index,p] of points(once).entries())expect(Math.abs(p.millisecondOffset-points(out)[index].millisecondOffset)*44.1).toBeLessThan(1.5);
  });
  it('rejects signed32bit padding wrap before invoking the public writer',()=>{
    const value=backing({anchors:[{bar:0,occurrence:0,ratio:0,audioMs:2147483648/44.1}]});
    expect(gpBackingSelectionIssue(score120(),value,full)).toMatch(/padding|frame/i);expect(()=>project(score120(),value)).toThrow(/padding|frame/i);
  });
  it('keeps signed physical source coordinates through the standard GP wire',()=>{
    const out=project(score120(),backing({offsetMs:250})),reopened=round(out);
    expect(points(out)[0].millisecondOffset).toBe(-250);expect(points(reopened)[0].millisecondOffset).toBe(-250);expect(physicalAt(reopened,960)).toBeCloseTo(250,8);
  });
  it('uses actual six-eight and pickup durations for arbitrary GP ratios',()=>{
    for(const pickup of [false,true]){
      const score=score120(),voice=score.tracks[0].staves[0].bars[0].voices[0];score.masterBars[0].isAnacrusis=pickup;
      if(pickup)voice.beats.splice(1);else{score.masterBars[0].timeSignatureNumerator=6;score.masterBars[0].timeSignatureDenominator=8;for(const beat of voice.beats)beat.duration=model.Duration.Eighth;}
      score.finish(settings);
      const out=project(score,backing({anchors:[{bar:0,occurrence:0,ratio:1/3,audioMs:1000},{bar:0,occurrence:0,ratio:3/8,audioMs:1100}]})),reopened=round(out),duration=pickup?960:2880;
      expect(backingLocationsForScore(reopened)[0].endTick).toBe(duration);expect(points(reopened).slice(1,3).map(p=>p.barPosition)).toEqual([1/3,3/8]);
      expect(physicalAt(reopened,duration/3)).toBeCloseTo(1000,8);expect(physicalAt(reopened,duration*3/8)).toBeCloseTo(1100,8);
    }
  });
  it.each([-250.02,1000.0204,1000.0226])('bounds absolute quantization for first source %s ms',first=>{
    const out=project(score120(),backing({offsetMs:-first,anchors:[{bar:0,occurrence:0,ratio:0,audioMs:0},{bar:0,occurrence:0,ratio:.5,audioMs:1500.01}]})),reopened=round(out),again=round(reopened);
    for(const [index,point]of points(reopened).entries())expect(Math.abs(point.millisecondOffset-points(out)[index].millisecondOffset)*44.1).toBeLessThan(1.5);
    for(const [index,point]of points(again).entries())expect(Math.abs(point.millisecondOffset-points(reopened)[index].millisecondOffset)*44.1).toBeLessThan(1.5);
  });
  it('rejects unsafe frame offsets independently of initial padding',()=>{
    const value=backing({anchors:[{bar:0,occurrence:0,ratio:0,audioMs:0},{bar:3,occurrence:0,ratio:1,audioMs:Number.MAX_SAFE_INTEGER}]});
    expect(()=>project(score120(),value)).toThrow(/frame/i);
  });
  it('rejects distinct source pins that collapse to one GP audio frame',()=>{
    const value=backing({anchors:[{bar:0,occurrence:0,ratio:0,audioMs:0},{bar:0,occurrence:0,ratio:1/3,audioMs:.001}]});
    expect(gpBackingSelectionIssue(score120(),value,full)).not.toBeNull();expect(()=>project(score120(),value)).toThrow(/frame/i);
  });
});

describe('GP selected performed route admission',()=>{
  it('rebuilds fresh occurrence keys for a uniquely contained closed repeat',()=>{
    const score=repeated(),out=project(score,backing({offsetMs:-1000}),{tracks:[0],range:{first:0,last:1}}),route=backingLocationsForScore(out);
    expect(route.map(p=>[p.bar,p.occurrence])).toEqual([[0,0],[1,0],[0,1],[1,1]]);expect(points(out).map(p=>p.millisecondOffset)).toEqual([1000,5000,9000]);expect(()=>round(out)).not.toThrow();
    const doc=new DOMParser().parseFromString(strFromU8(unzipSync(exportGpInterchange(out,settings))['Content/score.gpif']),'application/xml');expect([...doc.querySelectorAll('Value > BarOccurrence')].map(n=>Number(n.textContent))).toEqual([0,1,1]);
  });
  it('rejects an ambiguous repeated bar with an actionable include issue and permits omit',()=>{
    const score=repeated(),selection={tracks:[0],range:{first:1,last:1}},value=backing();
    expect(gpBackingSelectionIssue(score,value,selection)).toMatch(/ambiguous|pass/i);expect(()=>project(score,value,selection)).toThrow(/backing|pass/i);expect(()=>round(project(score,value,selection,false,null))).not.toThrow();
  });
  it('rejects omission of a timing-controlling pickup track',()=>{
    const score=unequalPickupScore();expect(gpBackingSelectionIssue(score,backing(),full)).toMatch(/timing|duration|route/i);expect(()=>round(project(score,backing(),full,false,null))).not.toThrow();
  });
  it('rejects a written excerpt that joins separated original performed windows',()=>{
    const score=score120();score.masterBars[0].isRepeatStart=true;score.masterBars[1].repeatCount=2;score.masterBars[1].alternateEndings=1;score.masterBars[2].alternateEndings=2;score.rebuildRepeatGroups();score.finish(settings);
    expect(backingLocationsForScore(score).map(p=>p.bar)).toEqual([0,1,0,2,3]);
    const selection={tracks:[0],range:{first:1,last:2}};
    expect(gpBackingSelectionIssue(score,backing(),selection)).toMatch(/separated|route/i);expect(()=>project(score,backing(),selection)).toThrow(/route|continuous/i);expect(()=>round(project(score,backing(),selection,false,null))).not.toThrow();
  });
  it('rejects every nonidentity excerpt with a pre-body grace lead-in',()=>{
    const score=grace();expect(backingLocationsForScore(score)[0].startTick).toBe(120);expect(gpBackingSelectionIssue(score,backing(),{tracks:[0],range:{first:0,last:1}})).toMatch(/grace/i);
  });
  it('allows a same-duration full track reorder',()=>{
    const score=score120(),other=model.JsonConverter.jsonToScore(model.JsonConverter.scoreToJson(score),settings).tracks[0];score.addTrack(other);score.finish(settings);
    const out=project(score,backing({offsetMs:-100}),{tracks:[1,0],range:null});expect(out.tracks).toHaveLength(2);expect(points(out).map(p=>p.millisecondOffset)).toEqual([100,8100]);
  });
  it('does no backing route work when effective backing is absent',()=>{expect(gpBackingSelectionIssue(score120(),null,full)).toBeNull();});
});

describe('reference GP projection',()=>{
  it('keeps authored tempos and physical brackets for the selected second span',()=>{
    const value=backing({offsetMs:120,referenceSync:{entryAudioMs:1120,exitAudioMs:15120},anchors:[{bar:1,occurrence:0,ratio:0,audioMs:3120}]}),score=score120(),before=model.JsonConverter.scoreToJson(score),out=project(score,value,{tracks:[0],range:{first:1,last:1}});
    expect(points(out).map(p=>p.millisecondOffset)).toEqual([3000,7000]);expect(out.masterBars[0].tempoAutomations.map(p=>p.value)).toEqual([120]);expect(model.JsonConverter.scoreToJson(score)).toBe(before);
  });
  it('retains the literal full-identity grace source map after a real GP roundtrip',()=>{
    const score=grace(),value=backing({referenceSync:{entryAudioMs:1000,exitAudioMs:9000}}),out=project(score,value),reopened=round(out);
    expect(backingLocationsForScore(reopened)[0].startTick).toBe(120);expect(physicalAt(reopened,0)).toBeCloseTo(937.5,8);expect(physicalAt(reopened,120)).toBeCloseTo(1000,8);expect(physicalAt(reopened,3960)).toBeCloseTo(3000,8);expect(physicalAt(reopened,15480)).toBeCloseTo(9000,8);
  });
});
