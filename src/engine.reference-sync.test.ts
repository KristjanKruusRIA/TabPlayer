import {describe,expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {model} from '@coderline/alphatab';
import {buildDocument,buildScore,effectiveAudioSettings,exportGp,previewEdit,replayDocumentSettings} from './engine';
import {blankProject,type EditCommand,type Project} from './project';
import type {BackingSettings} from './edit-types';
import {backingLocationsForScore,buildPlaybackPlan} from './audio/plan';
import {referenceSourceMs,referenceSyncTiming} from './audio/reference-sync';
import {scoreTickToAudioMs} from './audio/backing-timeline';
import {makeMusicClip} from './editor/clipboard-source';
import {projectGpDocument} from './interchange/backing-projection';

const assetId='a'.repeat(64),mix={gain:1,pan:0,mute:false,solo:false};
const target={track:0,staff:0,bar:0,voice:0,beat:0};
const measure=(bar:number,patch:Partial<Extract<EditCommand,{type:'setMeasureSettings'}>>={}):Extract<EditCommand,{type:'setMeasureSettings'}>=>({
  type:'setMeasureSettings',bar,numerator:4,denominator:4,pickup:false,freeTime:false,repeatStart:false,repeatCount:0,endings:[],section:'',tempos:[],...patch,
});
const backing=(patch:Partial<BackingSettings>={}):BackingSettings=>({assetId,offsetMs:0,anchors:[],mix:{...mix},referenceSync:{entryAudioMs:1000,exitAudioMs:9000},...patch});
const enable=(value=backing()):EditCommand=>({type:'setBacking',backing:value});
function project(edits:EditCommand[]=[]):Project {
  return {...blankProject(),assets:{[assetId]:{filename:'reference.wav',mediaType:'audio/wav',byteLength:100}},edits};
}
function imported(score:model.Score,edits:EditCommand[]=[]):Project {
  const bytes=exportGp(score);
  return {...project(edits),base:{kind:'file',filename:'source.gp',bytesBase64:Buffer.from(bytes).toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')}};
}
function timing(built:ReturnType<typeof buildDocument>) {
  return referenceSyncTiming(built.settings.backing!,backingLocationsForScore(built.score))!;
}
function shortened() {
  return [0,1,2].map(()=>({type:'deleteBeat' as const,target:{...target,beat:1}}));
}

describe('reference synchronization historical score replay',()=>{
  it('extends an appended bar at the historical final slope while preserving old mapping and one command',()=>{
    const input=project([enable(backing({anchors:[{bar:1,occurrence:0,ratio:0,audioMs:2000}]}))]),before=structuredClone(input),current=buildDocument(input),old=timing(current);
    const appended=previewEdit(input,{type:'appendMeasure'},current),next=timing(appended);
    expect(appended.settings.backing?.referenceSync?.entryAudioMs).toBe(1000);
    expect(appended.settings.backing?.referenceSync?.exitAudioMs).toBeCloseTo(9000+7000/3,10);
    for(const tick of [0,960,3840,7680,15360])expect(referenceSourceMs(next,tick)).toBeCloseTo(referenceSourceMs(old,tick),10);
    expect(appended.project.edits).toEqual([...input.edits,{type:'appendMeasure'}]);
    expect(appended.project.base).toEqual(input.base);expect(appended.project.assets).toEqual(input.assets);expect(input).toEqual(before);
    expect(buildDocument(JSON.parse(JSON.stringify(appended.project))).settings).toEqual(appended.settings);
  });

  it('inserts interior measures with fixed surviving source pins and removes/deindexes deleted pins',()=>{
    const input=project([enable(backing({anchors:[{bar:1,occurrence:0,ratio:0,audioMs:3000},{bar:2,occurrence:0,ratio:.5,audioMs:6000}]}))]);
    const inserted=previewEdit(input,{type:'insertMeasures',beforeBar:1,count:1});
    expect(inserted.settings.backing?.anchors).toEqual([{bar:2,occurrence:0,ratio:0,audioMs:3000},{bar:3,occurrence:0,ratio:.5,audioMs:6000}]);
    expect(inserted.settings.backing?.referenceSync).toEqual({entryAudioMs:1000,exitAudioMs:11000});
    expect(timing(inserted).segments[0].bpm).toBe(240);
    for(const edit of [{type:'removeMeasures',firstBar:1,lastBar:1},{type:'removeMeasure',bar:1}] as const) {
      const removed=previewEdit(input,edit);
      expect(removed.settings.backing?.anchors).toEqual([{bar:1,occurrence:0,ratio:.5,audioMs:6000}]);
      expect(removed.settings.backing?.referenceSync).toEqual({entryAudioMs:1000,exitAudioMs:7000});
    }
  });

  it('adjusts pasted bars through the same historical route path',()=>{
    const clip=makeMusicClip(buildScore(blankProject()),{kind:'bars',tracks:[0],firstBar:0,lastBar:0},'singleTrack');
    const edit:EditCommand={type:'pasteMusic',clip,options:{target:{...target,bar:1},destinations:[{sourceTrack:0,track:0,staffMap:[0]}],count:2,placement:'beforeBar',filters:{diagrams:true,texts:true,timers:true,trackAutomations:true,masterAutomations:false,sections:false}}};
    const input=project([enable(backing({anchors:[{bar:2,occurrence:0,ratio:0,audioMs:5000}]}))]),pasted=previewEdit(input,edit);
    expect(pasted.score.masterBars).toHaveLength(6);expect(pasted.settings.backing?.referenceSync?.exitAudioMs).toBe(13000);
    expect(pasted.settings.backing?.anchors).toEqual([{bar:4,occurrence:0,ratio:0,audioMs:5000}]);
    expect(pasted.project.edits.at(-1)).toEqual(edit);
    expect(replayDocumentSettings(pasted.project,pasted).settings).toEqual(pasted.settings);
  });

  it.each([
    {name:'meter',before:[] as EditCommand[],edit:measure(0,{numerator:5}),exit:9500},
    {name:'pickup',before:shortened(),edit:measure(0,{pickup:true}),exit:7500},
    {name:'free time unrepresented body',before:[...shortened(),measure(0,{freeTime:true})],edit:{type:'setDuration',target,duration:2,dots:0} as EditCommand,exit:9000},
    {name:'pickup rhythm',before:[...shortened(),measure(0,{pickup:true})],edit:{type:'setDuration',target,duration:2,dots:0} as EditCommand,exit:9000+8000/13},
    {name:'repeat',before:[measure(0,{repeatStart:true})],edit:measure(1,{repeatCount:2}),exit:13000},
    {name:'direction',before:[{type:'setDirections',bar:0,directions:[model.Direction.TargetFine]}] as EditCommand[],edit:{type:'setDirections',bar:1,directions:[model.Direction.JumpDaCapoAlFine]} as EditCommand,exit:7000},
  ])('recomputes actual performed extent for $name commands',({before,edit,exit})=>{
    const input=project([...before,enable()]),changed=previewEdit(input,edit);
    expect(changed.settings.backing?.referenceSync?.entryAudioMs).toBe(1000);
    expect(changed.settings.backing?.referenceSync?.exitAudioMs).toBeCloseTo(exit,10);
    expect(timing(changed).exitTick-timing(changed).entryTick).toBeGreaterThan(0);
    expect(replayDocumentSettings(changed.project,changed).settings).toEqual(changed.settings);
  });

  it('keeps body bounds fixed for initial grace and uses freshly rebuilt rhythm for the next command',()=>{
    const rhythm:EditCommand={type:'setBeatRhythm',target,duration:8,dots:0,tupletNumerator:1,tupletDenominator:1,graceType:model.GraceType.BeforeBeat};
    const input=project([enable()]),grace=previewEdit(input,rhythm);
    expect(timing(grace).entryTick).toBeGreaterThan(0);expect(grace.settings.backing?.referenceSync).toEqual(input.edits[0].type==='setBacking'&&input.edits[0].backing?.referenceSync);
    const appended=previewEdit(grace.project,{type:'appendMeasure'});
    expect(appended.settings.backing?.referenceSync?.exitAudioMs).toBe(11000);
    expect(timing(appended).entryTick).toBe(timing(grace).entryTick);
  });

  it('reflows pickup longest-lane removal from a silent voice',()=>{
    const source=buildScore(blankProject()),staff=source.tracks[0].staves[0];source.masterBars[0].isAnacrusis=true;staff.bars[0].voices[0].beats.splice(1);
    const voice=new model.Voice();for(let i=0;i<3;i++){const beat=new model.Beat();beat.duration=4;beat.isEmpty=false;voice.addBeat(beat);}staff.bars[0].addVoice(voice);
    for(let bar=1;bar<4;bar++){const empty=new model.Voice(),beat=new model.Beat();beat.isEmpty=true;empty.addBeat(beat);staff.bars[bar].addVoice(empty);}
    const input=imported(source,[enable()]),old=timing(buildDocument(input));
    const changed=previewEdit(input,{type:'removeVoice',track:0,staff:0,voice:1});
    expect(timing(changed).exitTick-timing(changed).entryTick).toBe(old.exitTick-old.entryTick-1920);
    expect(changed.settings.backing?.referenceSync?.exitAudioMs).toBeCloseTo(9000-8000*1920/(old.exitTick-old.entryTick),10);
  });

  it.each(['staff','track'] as const)('reflows pickup after removing its longest silent %s',kind=>{
    const source=buildScore(blankProject()),first=source.tracks[0].staves[0];source.masterBars[0].isAnacrusis=true;first.bars[0].voices[0].beats.splice(1);
    const staff=new model.Staff();staff.stringTuning.tunings=[...first.tuning];
    if(kind==='staff')source.tracks[0].addStaff(staff);
    else {const track=new model.Track();track.name='Silent long pickup';track.playbackInfo.primaryChannel=2;track.playbackInfo.secondaryChannel=3;track.addStaff(staff);source.addTrack(track);}
    for(let index=0;index<4;index++) {
      const bar=new model.Bar(),voice=new model.Voice();staff.addBar(bar);bar.addVoice(voice);
      for(let i=0;i<(index?4:3);i++){const beat=new model.Beat();beat.duration=4;beat.isEmpty=false;voice.addBeat(beat);}
    }
    const input=imported(source,[enable()]),old=timing(buildDocument(input));
    const edit:EditCommand=kind==='staff'?{type:'removeStaff',track:0,staff:1}:{type:'removeTrack',track:1};
    const changed=previewEdit(input,edit);
    expect(timing(changed).exitTick-timing(changed).entryTick).toBe(old.exitTick-old.entryTick-1920);
    expect(changed.settings.backing?.referenceSync?.exitAudioMs).toBeCloseTo(7933.333333333333,10);
    expect(replayDocumentSettings(changed.project,changed).settings).toEqual(changed.settings);
  });

  it('uses each command historical slope across baseline edits, later backing replacement and Undo/Redo settings replay',()=>{
    const input=project([enable(backing({referenceSync:{entryAudioMs:2000,exitAudioMs:12000}})),{type:'appendMeasure'},{type:'removeMeasure',bar:3}]);
    input.baselineEdits=[enable(),{type:'appendMeasure'}];
    const built=buildDocument(input);
    expect(built.settings.backing?.referenceSync).toEqual({entryAudioMs:2000,exitAudioMs:12000});
    const cleared=previewEdit(input,{type:'setBacking',backing:null},built),undone=replayDocumentSettings(input,cleared);
    expect(undone.settings).toEqual(built.settings);expect(undone.score).toBe(built.score);
    const redone=replayDocumentSettings(cleared.project,undone);expect(redone.settings.backing).toBeNull();expect(redone.score).toBe(built.score);
    const prior={...input,edits:input.edits.slice(0,-1)},priorBuilt=buildDocument(prior);
    expect(priorBuilt.settings.backing?.referenceSync?.exitAudioMs).toBe(14000);
    expect(replayDocumentSettings(prior,priorBuilt).settings).toEqual(priorBuilt.settings);
    const mixOnly=previewEdit(input,{type:'setTrackMix',trackId:'base/0',mix:{...mix,gain:.5}},built);
    expect(mixOnly.score).toBe(built.score);expect(mixOnly.settings.backing).toEqual(built.settings.backing);
  });

  it('rejects a missing performed pin at its historical command even when a later setting clears backing',()=>{
    const input=project([measure(0,{repeatStart:true}),measure(1,{repeatCount:2}),enable(backing({referenceSync:{entryAudioMs:1000,exitAudioMs:13000},anchors:[{bar:1,occurrence:1,ratio:.5,audioMs:8000}]}))]);
    const current=buildDocument(input),before=structuredClone(input),settings=structuredClone(current.settings);
    expect(()=>buildDocument({...input,edits:[...input.edits,measure(1),{type:'setBacking',backing:null}]})).toThrow(/missing|anchor|occurrence/i);
    expect(()=>previewEdit(input,measure(1),current)).toThrow(/missing|anchor|occurrence/i);
    expect(input).toEqual(before);expect(current.settings).toEqual(settings);
  });

  it('rejects a surviving source pin crossed by a shortened exit before a later backing clear',()=>{
    const input=project([enable(backing({anchors:[{bar:2,occurrence:0,ratio:.5,audioMs:8000}]})),{type:'removeMeasures',firstBar:0,lastBar:1},{type:'setBacking',backing:null}]);
    expect(()=>buildDocument(input)).toThrow(/anchor|inside|endpoint/i);
  });

  it('includes harmony transposition in historical reference validation and preserves its fixed bounds',()=>{
    const edit:EditCommand={type:'transposeHarmony',selection:{kind:'bars',tracks:[0],firstBar:0,lastBar:3},interval:{kind:'semitones',semitones:2},includeKeySignatures:false,includeChords:false};
    const input=project([{type:'setNote',target,string:1,fret:3},enable()]),changed=previewEdit(input,edit);
    expect(changed.score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].fret).toBe(5);
    expect(changed.settings.backing?.referenceSync).toEqual({entryAudioMs:1000,exitAudioMs:9000});
    const invalid=project([enable(backing({anchors:[{bar:1,occurrence:1,ratio:.5,audioMs:5000}]})),edit,{type:'setBacking',backing:null}]);
    expect(()=>buildDocument(invalid)).toThrow(/missing|anchor/i);
  });

  it('retains legacy anchor coordinates through score growth and settings replay',()=>{
    const legacy=backing({referenceSync:null,offsetMs:250,anchors:[{bar:1,occurrence:0,ratio:.5,audioMs:4500}]}),input=project([enable(legacy),{type:'appendMeasure'},{type:'setDuration',target,duration:8,dots:0}]);
    const built=buildDocument(input),replayed=replayDocumentSettings(input,built);
    expect(built.settings.backing).toEqual(legacy);expect(replayed.settings).toEqual(built.settings);expect(replayed.score).toBe(built.score);
  });

  it('preserves cross-measure score links through fresh reference route rebuilds',()=>{
    const from={target:{...target,beat:3},string:1},to={target:{...target,bar:1},string:1};
    const input=project([{type:'setNote',...from,fret:3},{type:'setNote',...to,fret:3},{type:'setNoteLink',from,to,kind:'tie'},enable()]);
    const changed=previewEdit(input,{type:'appendMeasure'}),origin=changed.score.tracks[0].staves[0].bars[0].voices[0].beats[3].notes[0],destination=changed.score.tracks[0].staves[0].bars[1].voices[0].beats[0].notes[0];
    expect(origin.tieDestination).toBe(destination);expect(destination.tieOrigin).toBe(origin);expect(destination.isTieDestination).toBe(true);
    expect(changed.settings.backing?.referenceSync?.exitAudioMs).toBe(11000);
  });

  it('dispatches exact-ratio authored tempo replacement as one score command without changing reference pins',()=>{
    const points=[{bar:0,ratio:0,bpm:123.456,linear:false},{bar:0,ratio:1/3,bpm:81.25,linear:true},{bar:2,ratio:1,bpm:240.5,linear:false}];
    const input=project([enable()]),built=buildDocument(input),changed=previewEdit(input,{type:'replaceTempoAutomations',points},built);
    expect(changed.score.masterBars.map(bar=>bar.tempoAutomations.map(tempo=>[tempo.ratioPosition,tempo.value,tempo.isLinear]))).toEqual([[[0,123.456,false],[1/3,81.25,true]],[],[[1,240.5,false]],[]]);
    expect(changed.score.tempo).toBe(123.456);expect(changed.settings.backing).toEqual(built.settings.backing);
    expect(changed.project.edits).toHaveLength(2);expect(buildDocument({...changed.project,edits:changed.project.edits.slice(0,-1)}).score.tempo).toBe(120);
    expect(buildDocument(JSON.parse(JSON.stringify(changed.project))).settings).toEqual(changed.settings);
    expect(()=>previewEdit(input,{type:'replaceTempoAutomations',points:[...points,{bar:4,ratio:0,bpm:60,linear:false}]},built)).toThrow(/missing bar/i);
  });

  it('normalizes signed original GP source points while preserving physical mapping through export/reopen',()=>{
    const source=buildScore({...blankProject(),base:{...blankProject().base,kind:'blank',title:'Signed',artist:'',tempo:120,tuning:[64,59,55,50,45,40],measureCount:1}});
    source.backingTrack=new model.BackingTrack();source.backingTrack.rawAudioFile=new Uint8Array([82,73,70,70]);
    source.masterBars[0].syncPoints=[0,1].map((ratio,index)=>{const point=new model.Automation();point.ratioPosition=ratio;point.syncPointValue=new model.SyncPointData();point.syncPointValue.barOccurence=0;point.syncPointValue.millisecondOffset=index?1750:-250;return point;});
    const input=imported(source),built=buildDocument(input),effective=effectiveAudioSettings(input,built);
    expect(effective.backing?.offsetMs).toBe(250);expect(effective.backing?.anchors.map(anchor=>anchor.audioMs)).toEqual([0,2000]);
    expect(scoreTickToAudioMs(buildPlaybackPlan(built.score,0),effective.backing!,960)).toBe(250);
    const projected=projectGpDocument({score:built.score,settings:effective,bytes:built.embeddedBacking,selection:{tracks:[0],range:null},backing:true});
    const reopenedInput=imported(projected),reopened=buildDocument(reopenedInput),restored=effectiveAudioSettings(reopenedInput,reopened).backing!;
    expect(restored.anchors[0].audioMs-restored.offsetMs).toBe(-250);
    expect(scoreTickToAudioMs(buildPlaybackPlan(reopened.score,0),restored,960)).toBe(250);
  });
});
