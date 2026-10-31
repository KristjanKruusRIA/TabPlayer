import { expect,it } from 'vitest';
import { model,Settings } from '@coderline/alphatab';
import { applyMeasureEdit,mapBackingMeasures,planMeasureMap } from './measures';
import { music,noteAt } from './fixtures';
import { captureNoteLinks,restoreNoteLinks } from './links';
import { scoreFromJson } from '../model-clone';
import { exportMidi } from '../export/midi';
import { exportGpInterchange,loadInterchangeScore } from '../interchange/gp';
import type { MeasureCommand } from './measures-types';

const settings=new Settings();
const fingerprint=(score:model.Score)=>model.JsonConverter.scoreToJson(score);
function rebuild(score:model.Score) {const links=captureNoteLinks(score),copy=scoreFromJson(fingerprint(score),settings);restoreNoteLinks(copy,links);return copy;}
function multi() {
  const score=music();score.masterBars.pop();score.tracks[0].staves[0].bars.pop();
  for(let t=0;t<3;t++) {
    const track=t===0?score.tracks[0]:new model.Track();if(t>0)score.addTrack(track);
    while(track.staves.length<2){const staff=new model.Staff();staff.stringTuning.tunings=t===0?[64,59,55,50,45,40]:[];staff.isPercussion=t===2;track.addStaff(staff);}
    for(const staff of track.staves) {
      while(staff.bars.length<3){const bar=new model.Bar();staff.addBar(bar);}
      for(const bar of staff.bars)while(bar.voices.length<4){const voice=new model.Voice(),beat=new model.Beat();beat.isEmpty=true;voice.addBeat(beat);bar.addVoice(voice);}
    }
  }
  return rebuild(score);
}
const automation=(type:model.AutomationType,value:number,ratioPosition=0)=>Object.assign(new model.Automation(),{type,value,ratioPosition});
function pedal(bar:model.Bar,pedalType:model.SustainPedalMarkerType,ratioPosition=0){bar.sustainPedals.push(Object.assign(new model.SustainPedalMarker(),{bar,pedalType,ratioPosition}));}
function autoAt(score:model.Score,bar:number,type:model.AutomationType) {return score.tracks[0].staves.flatMap(staff=>staff.bars[bar].voices.flatMap(voice=>voice.beats.flatMap(beat=>beat.automations.filter(a=>a.type===type))));}
type BoundedLink='tie'|'hammerPull'|'slide';
function linkAcrossFirstTwoBars(kind:BoundedLink) {
  const score=music(),from=noteAt(score,0,3),to=noteAt(score,1);
  if(kind==='tie'){from.tieDestination=to;to.tieOrigin=from;to.isTieDestination=true;}
  else if(kind==='hammerPull'){from.hammerPullDestination=to;from.isHammerPullOrigin=true;to.hammerPullOrigin=from;}
  else {from.slideTarget=to;from.slideOutType=model.SlideOutType.Shift;to.slideOrigin=from;}
  return score;
}
function unprotectedGpGap(kind:BoundedLink,count:number) {
  const score=linkAcrossFirstTwoBars(kind);
  // An independently authored whole-rest fixture, without the editor transform.
  for(let index=0;index<count;index++) {
    score.masterBars.splice(1,0,new model.MasterBar());
    const bar=new model.Bar(),voice=new model.Voice(),rest=new model.Beat();rest.duration=model.Duration.Whole;rest.isEmpty=false;voice.addBeat(rest);bar.addVoice(voice);score.tracks[0].staves[0].bars.splice(1,0,bar);
  }
  return rebuild(score);
}

it('index_map_first_middle_tail_and_keep_one',()=>{
  expect(planMeasureMap(3,{type:'insertMeasures',beforeBar:1,count:2})).toEqual({oldToNew:[0,3,4],inserted:[1,2]});
  expect(planMeasureMap(3,{type:'insertMeasures',beforeBar:3,count:2})).toEqual({oldToNew:[0,1,2],inserted:[3,4]});
  expect(planMeasureMap(3,{type:'insertMeasures',beforeBar:0,count:1})).toEqual({oldToNew:[1,2,3],inserted:[0]});
  expect(planMeasureMap(5,{type:'removeMeasures',firstBar:1,lastBar:2})).toEqual({oldToNew:[0,null,null,1,2],inserted:[]});
  for(const command of [{type:'removeMeasures',firstBar:0,lastBar:2},{type:'removeMeasures',firstBar:1,lastBar:3},{type:'removeMeasures',firstBar:2,lastBar:1},{type:'insertMeasures',beforeBar:4,count:1},{type:'insertMeasures',beforeBar:0,count:0},{type:'insertMeasures',beforeBar:0,count:1001},{type:'insertMeasures',beforeBar:.5,count:1},{type:'insertMeasures',beforeBar:0,count:1,extra:true}] as MeasureCommand[])expect(()=>planMeasureMap(3,command)).toThrow();
  expect(planMeasureMap(1,{type:'insertMeasures',beforeBar:1,count:1000}).inserted).toHaveLength(1000);
  const score=music(),before=fingerprint(score);expect(applyMeasureEdit(score,{type:'other'} as unknown as MeasureCommand)).toBe(false);
  expect(()=>applyMeasureEdit(score,{type:'removeMeasures',firstBar:2,lastBar:4})).toThrow();expect(fingerprint(score)).toBe(before);
});

it('GP_reopen_resolves_tie_at_exact_three_bar_search_boundary',()=>{
  const score=linkAcrossFirstTwoBars('tie');applyMeasureEdit(score,{type:'insertMeasures',beforeBar:1,count:2});
  const copy=loadInterchangeScore(exportGpInterchange(rebuild(score),settings),settings),from=noteAt(copy,0,3),to=noteAt(copy,3);
  expect(to.tieOrigin===from).toBe(true);
});

it.each(['tie','hammerPull','slide'] as const)('GP_parser_%s_search_boundary_is_proven_independently_of_editor_guards',kind=>{
  for(const [gap,resolvable]of [[2,true],[3,false]] as const) {
    const score=unprotectedGpGap(kind,gap),from=noteAt(score,0,3),to=noteAt(score,gap+1);
    expect(kind==='tie'?model.Note.findTieOrigin(to)===from:kind==='hammerPull'?model.Note.findHammerPullDestination(from)===to:model.Note.nextNoteOnSameLine(from)===to).toBe(resolvable);
  }
});

it.each(['hammerPull','slide'] as const)('GP_reopen_loses_forward_%s_across_one_blank_even_inside_static_search_bound',kind=>{
  const source=unprotectedGpGap(kind,1),from=noteAt(source,0,3),to=noteAt(source,2);expect(kind==='hammerPull'?from.hammerPullDestination===to:from.slideTarget===to).toBe(true);
  const copy=loadInterchangeScore(exportGpInterchange(source,settings),settings),reopenedFrom=noteAt(copy,0,3),reopenedTo=noteAt(copy,2);expect(kind==='hammerPull'?reopenedFrom.hammerPullDestination===reopenedTo:reopenedFrom.slideTarget===reopenedTo).toBe(false);
});

it.each(['tie','hammerPull','slide'] as const)('insertion_rejects_%s_expansion_beyond_proven_GP_reopen_compatibility_atomically',kind=>{
  const score=linkAcrossFirstTwoBars(kind),before=fingerprint(score);expect(()=>applyMeasureEdit(score,{type:'insertMeasures',beforeBar:1,count:kind==='tie'?3:1})).toThrow(/GP.*link|link.*GP/i);expect(fingerprint(score)).toBe(before);expect(score.masterBars).toHaveLength(4);
});

it.each(['tie','hammerPull','slide'] as const)('unrelated_insertions_keep_preexisting_long_%s_links',kind=>{
  const score=unprotectedGpGap(kind,5),from=noteAt(score,0,3),to=noteAt(score,6);applyMeasureEdit(score,{type:'insertMeasures',beforeBar:0,count:1});applyMeasureEdit(score,{type:'insertMeasures',beforeBar:score.masterBars.length,count:1});expect(kind==='tie'?to.tieOrigin===from:kind==='hammerPull'?from.hammerPullDestination===to:from.slideTarget===to).toBe(true);expect(to.beat.voice.bar.index-from.beat.voice.bar.index).toBe(6);
});
it('insertion_keeps_unbounded_explicit_slurs',()=>{
  const slur=music(),origin=noteAt(slur,0,3),destination=noteAt(slur,1);origin.slurDestination=destination;destination.slurOrigin=origin;destination.isSlurDestination=true;applyMeasureEdit(slur,{type:'insertMeasures',beforeBar:1,count:6});expect(destination.slurOrigin).toBe(origin);
});

it('all_tracks_staves_voices_inherit_without_alias',()=>{
  const score=multi(),master=score.masterBars[0],source=score.tracks[0].staves[0].bars[0],kept=noteAt(score,1);
  master.timeSignatureCommon=true;master.tripletFeel=model.TripletFeel.Triplet8th;master.beamingRules=new model.BeamingRules();master.beamingRules.groups.set(8,[2,2,2,2]);
  master.section=Object.assign(new model.Section(),{text:'Verse'});master.addFermata(0,new model.Fermata());master.addDirection(model.Direction.TargetSegno);master.addSyncPoint(automation(model.AutomationType.SyncPoint,0));
  source.keySignature=-3;source.keySignatureType=model.KeySignatureType.Minor;source.clef=model.Clef.F4;source.clefOttava=model.Ottavia._8vb;
  kept.dynamics=3;kept.slideOutType=model.SlideOutType.OutUp;const id=kept.id;
  const first=noteAt(score,0,3);first.tieDestination=kept;kept.tieOrigin=first;kept.isTieDestination=true;
  applyMeasureEdit(score,{type:'insertMeasures',beforeBar:1,count:2});
  expect(score.masterBars).toHaveLength(5);expect(noteAt(score,3)).toBe(kept);expect(kept.id).toBe(id);expect(kept.dynamics).toBe(3);expect(kept.tieOrigin).toBe(first);
  for(const track of score.tracks)for(const staff of track.staves) {expect(staff.bars).toHaveLength(5);for(const index of [1,2]){expect(staff.bars[index].voices).toHaveLength(4);expect(staff.bars[index].voices[0].beats.map(beat=>[beat.duration,beat.isEmpty,beat.notes.length])).toEqual([[4,false,0],[4,false,0],[4,false,0],[4,false,0]]);expect(staff.bars[index].voices.slice(1).every(voice=>voice.beats.length===1&&voice.beats[0].isEmpty)).toBe(true);}}
  expect(score.tracks[0].staves[0].bars[1]).toMatchObject({keySignature:-3,keySignatureType:model.KeySignatureType.Minor,clef:model.Clef.F4,clefOttava:model.Ottavia._8vb});
  for(const inserted of score.masterBars.slice(1,3)){expect(inserted).toMatchObject({timeSignatureCommon:true,tripletFeel:model.TripletFeel.Triplet8th,isRepeatStart:false,repeatCount:0,alternateEndings:0,section:null,fermata:null,directions:null});expect(inserted.tempoAutomations).toEqual([]);expect(inserted.syncPoints).toBeUndefined();expect(inserted.beamingRules?.groups.get(8)).toEqual([2,2,2,2]);}
  score.masterBars[1].beamingRules!.groups.get(8)![0]=9;expect(score.masterBars[2].beamingRules!.groups.get(8)).toEqual([2,2,2,2]);expect(master.beamingRules.groups.get(8)).toEqual([2,2,2,2]);
  score.tracks[0].staves[0].bars[1].voices[0].beats[0].text='new';expect(score.tracks[0].staves[0].bars[2].voices[0].beats[0].text).toBeNull();
  const copy=rebuild(score);expect(noteAt(copy,3).tieOrigin?.id).toBe(first.id);expect(noteAt(copy,3).dynamics).toBe(3);expect(noteAt(copy,3).slideOutType).toBe(model.SlideOutType.OutUp);
});

it('free_time_insertions_use_empty_carriers_and_front_insert_seeds_initial_tempo',()=>{
  const score=music();score.masterBars[0].isFreeTime=true;score.masterBars[0].tempoAutomations=[model.Automation.buildTempoAutomation(false,0,90,2)];
  applyMeasureEdit(score,{type:'insertMeasures',beforeBar:0,count:2});
  expect(score.masterBars[0].tempoAutomations.map(a=>[a.value,a.ratioPosition])).toEqual([[90,0]]);expect(score.masterBars[1].tempoAutomations).toEqual([]);
  for(const bar of score.tracks[0].staves[0].bars.slice(0,2))expect(bar.voices[0].beats.map(beat=>[beat.isEmpty,beat.notes.length])).toEqual([[true,0]]);
});

it('remove_detaches_boundaries_preserves_survivors_and_linebreaks',()=>{
  const score=music(),a=noteAt(score,0),b=noteAt(score,1),c=noteAt(score,2),d=noteAt(score,3);
  a.tieDestination=b;b.tieOrigin=a;b.isTieDestination=true;b.slurDestination=c;c.slurOrigin=b;c.isSlurDestination=true;
  b.slideTarget=c;b.slideOutType=model.SlideOutType.Legato;c.slideOrigin=b;a.hammerPullDestination=b;a.isHammerPullOrigin=true;b.hammerPullOrigin=a;
  c.tieDestination=d;d.tieOrigin=c;d.isTieDestination=true;noteAt(score,2,1).slideOutType=model.SlideOutType.OutDown;score.tracks[0].lineBreaks=new Set([0,1,3]);
  applyMeasureEdit(score,{type:'removeMeasures',firstBar:1,lastBar:1});
  expect(a.tieDestination).toBeNull();expect(a.hammerPullDestination).toBeNull();expect(a.isHammerPullOrigin).toBe(false);expect(c.slurOrigin).toBeNull();expect(c.isSlurDestination).toBe(false);expect(c.slideOrigin).toBeNull();expect(b.tieOrigin).toBeNull();expect(b.slideTarget).toBeNull();
  expect([...score.tracks[0].lineBreaks!]).toEqual([0,2]);const copy=rebuild(score);expect(noteAt(copy,1).tieDestination?.id).toBe(d.id);expect(noteAt(copy,1,1).slideOutType).toBe(model.SlideOutType.OutDown);
});

it('removal_clears_a_surviving_continued_bend_origin_even_without_a_direct_tie_edge',()=>{
  const score=music(),removed=noteAt(score,1),survivor=noteAt(score,2);survivor.bendOrigin=removed;survivor.isContinuedBend=true;
  applyMeasureEdit(score,{type:'removeMeasures',firstBar:1,lastBar:1});expect(survivor.bendOrigin).toBeNull();expect(survivor.isContinuedBend).toBe(false);
});

it('meter_rests_and_linebreaks_move_without_copying_beat_annotations',()=>{
  const score=music(),context=score.masterBars[0],beat=noteAt(score).beat;context.timeSignatureNumerator=7;context.timeSignatureDenominator=8;context.tripletFeel=model.TripletFeel.Triplet16th;
  beat.text='Keep on source';beat.showTimer=true;beat.chordId='chord';beat.lyrics=['Raw'];score.tracks[0].lineBreaks=new Set([0,2]);
  applyMeasureEdit(score,{type:'insertMeasures',beforeBar:1,count:1});const inserted=score.tracks[0].staves[0].bars[1];
  expect(inserted.voices[0].beats.map(beat=>[beat.duration,beat.isEmpty,beat.text,beat.showTimer,beat.chordId,beat.lyrics])).toEqual(Array.from({length:7},()=>[8,false,null,false,null,null]));expect([...score.tracks[0].lineBreaks!]).toEqual([0,3]);expect(beat.text).toBe('Keep on source');
});

it('suffix_state_prefers_explicit_zero_and_uses_bar_ratios',()=>{
  const score=multi(),track=score.tracks[0],staff=track.staves[0],removed=staff.bars[1],suffix=staff.bars[2];
  score.masterBars[1].tempoAutomations=[model.Automation.buildTempoAutomation(false,.5,90,2)];
  removed.voices[0].beats[1].automations.push(automation(model.AutomationType.Instrument,30),automation(model.AutomationType.Bank,2));
  removed.voices[0].beats[0].automations.push(automation(model.AutomationType.Volume,4,.75),automation(model.AutomationType.Balance,12,.5));
  removed.voices[0].beats[3].automations.push(Object.assign(automation(model.AutomationType.Volume,10,.25),{isLinear:true,text:'quiet',isVisible:true}));
  suffix.voices[0].beats[3].automations.push(Object.assign(automation(model.AutomationType.Volume,6,.25),{isLinear:true,text:'rise',isVisible:true}));suffix.voices[0].beats[0].fade=model.FadeType.FadeIn;pedal(removed,model.SustainPedalMarkerType.Down,.75);pedal(suffix,model.SustainPedalMarkerType.Hold);
  applyMeasureEdit(score,{type:'removeMeasures',firstBar:1,lastBar:1});
  expect(score.masterBars[1].tempoAutomations.map(a=>[a.value,a.ratioPosition])).toEqual([[90,0]]);
  expect(autoAt(score,1,model.AutomationType.Instrument).map(a=>[a.value,a.ratioPosition])).toEqual([[30,0]]);expect(autoAt(score,1,model.AutomationType.Bank).map(a=>[a.value,a.ratioPosition])).toEqual([[2,0]]);
  expect(autoAt(score,1,model.AutomationType.Volume).map(a=>[a.value,a.ratioPosition])).toEqual([[4,0],[6,.25]]);expect(autoAt(score,1,model.AutomationType.Volume)[1]).toMatchObject({isLinear:true,text:'rise',isVisible:true});expect(autoAt(score,1,model.AutomationType.Balance).map(a=>a.value)).toEqual([12]);
  expect(staff.bars[1].sustainPedals.map(p=>[p.pedalType,p.ratioPosition])).toEqual([[model.SustainPedalMarkerType.Down,0],[model.SustainPedalMarkerType.Hold,0]]);expect(staff.bars[1].voices[0].beats[0].fade).toBe(model.FadeType.FadeIn);
  const explicit=multi(),s=explicit.tracks[0].staves[0],other=explicit.tracks[0].staves[1];explicit.masterBars[1].tempoAutomations=[model.Automation.buildTempoAutomation(false,0,90,2)];explicit.masterBars[2].tempoAutomations=[model.Automation.buildTempoAutomation(false,0,130,2)];
  s.bars[1].voices[0].beats[0].automations.push(automation(model.AutomationType.Instrument,30),automation(model.AutomationType.Volume,4));other.bars[2].voices[0].beats[0].automations.push(automation(model.AutomationType.Instrument,42),automation(model.AutomationType.Volume,8),automation(model.AutomationType.Balance,3));pedal(s.bars[1],model.SustainPedalMarkerType.Down);pedal(s.bars[2],model.SustainPedalMarkerType.Up);
  applyMeasureEdit(explicit,{type:'removeMeasures',firstBar:1,lastBar:1});expect(explicit.masterBars[1].tempoAutomations.map(a=>a.value)).toEqual([130]);expect(autoAt(explicit,1,model.AutomationType.Instrument).map(a=>a.value)).toEqual([42]);expect(autoAt(explicit,1,model.AutomationType.Volume).map(a=>a.value)).toEqual([8]);expect(s.bars[1].sustainPedals.map(p=>p.pedalType)).toEqual([model.SustainPedalMarkerType.Up]);
});

it('tail_removal_adds_no_suffix_resets_and_malformed_last_staff_is_atomic',()=>{
  const score=multi();score.masterBars[2].tempoAutomations=[model.Automation.buildTempoAutomation(false,0,90,2)];const retained=score.tracks[0].staves[0].bars[1];applyMeasureEdit(score,{type:'removeMeasures',firstBar:2,lastBar:2});expect(score.masterBars[1].tempoAutomations).toEqual([]);expect(retained.voices[0].beats.every(beat=>beat.automations.length===0)).toBe(true);
  const malformed=multi();malformed.tracks[2].staves[1].bars.pop();const before=fingerprint(malformed);expect(()=>applyMeasureEdit(malformed,{type:'insertMeasures',beforeBar:1,count:1})).toThrow(/aligned/i);expect(fingerprint(malformed)).toBe(before);
});

it('context_guards_are_atomic_for_simile_repeat_ending_and_direction_changes',()=>{
  function rejected(score:model.Score,command:MeasureCommand,reason:RegExp){const before=fingerprint(score);expect(()=>applyMeasureEdit(score,command)).toThrow(reason);expect(fingerprint(score)).toBe(before);}
  let score=music();score.tracks[0].staves[0].bars[2].simileMark=model.SimileMark.Simple;rejected(score,{type:'insertMeasures',beforeBar:2,count:1},/simile/i);rejected(score,{type:'removeMeasures',firstBar:1,lastBar:1},/simile/i);
  score=music();score.tracks[0].staves[0].bars[2].simileMark=model.SimileMark.FirstOfDouble;score.tracks[0].staves[0].bars[3].simileMark=model.SimileMark.SecondOfDouble;rejected(score,{type:'insertMeasures',beforeBar:3,count:1},/simile/i);rejected(score,{type:'removeMeasures',firstBar:3,lastBar:3},/simile/i);rejected(score,{type:'insertMeasures',beforeBar:1,count:1},/simile/i);
  score=music();score.masterBars[0].isRepeatStart=true;score.masterBars[1].repeatCount=2;score.masterBars[1].alternateEndings=1;score.masterBars[2].alternateEndings=2;score.rebuildRepeatGroups();rejected(score,{type:'removeMeasures',firstBar:1,lastBar:1},/repeat/i);rejected(score,{type:'removeMeasures',firstBar:0,lastBar:1},/repeat/i);
  score=music();score.masterBars[1].addDirection(model.Direction.TargetSegno);score.masterBars[3].addDirection(model.Direction.JumpDaCapo);rejected(score,{type:'removeMeasures',firstBar:1,lastBar:1},/direction/i);
});

it('complete_repeat_removal_and_insertion_inside_intact_repeat_succeed',()=>{
  const score=music();score.masterBars[0].isRepeatStart=true;score.masterBars[1].repeatCount=2;score.rebuildRepeatGroups();applyMeasureEdit(score,{type:'removeMeasures',firstBar:0,lastBar:1});expect(score.masterBars).toHaveLength(2);expect(score.masterBars.every(bar=>!bar.isRepeatStart&&!bar.isRepeatEnd)).toBe(true);
  const inserted=music();inserted.masterBars[0].isRepeatStart=true;inserted.masterBars[2].repeatCount=2;inserted.rebuildRepeatGroups();applyMeasureEdit(inserted,{type:'insertMeasures',beforeBar:1,count:1});const copy=rebuild(inserted);expect(copy.masterBars[1].repeatGroup).toBe(copy.masterBars[0].repeatGroup);expect(copy.masterBars[3].repeatCount).toBe(2);
});

it('checks_context_in_the_last_hidden_staff_before_mutating_any_track',()=>{
  const score=multi();score.tracks[2].staves[1].bars[2].simileMark=model.SimileMark.Simple;const before=fingerprint(score);
  expect(()=>applyMeasureEdit(score,{type:'insertMeasures',beforeBar:2,count:2})).toThrow(/simile/i);expect(fingerprint(score)).toBe(before);
  applyMeasureEdit(score,{type:'insertMeasures',beforeBar:0,count:1});expect(score.tracks[2].staves[1].bars[3].simileMark).toBe(model.SimileMark.Simple);
});

it('whole_direction_context_can_be_removed_and_unaffected_prefix_state_is_not_duplicated',()=>{
  const score=music(),first=noteAt(score).beat;score.masterBars[1].addDirection(model.Direction.TargetSegno);score.masterBars[2].addDirection(model.Direction.JumpDalSegno);first.automations.push(automation(model.AutomationType.Volume,4),automation(model.AutomationType.Bank,2));pedal(score.tracks[0].staves[0].bars[0],model.SustainPedalMarkerType.Down);
  applyMeasureEdit(score,{type:'removeMeasures',firstBar:1,lastBar:2});expect(score.masterBars).toHaveLength(2);expect(score.masterBars[1].directions).toBeNull();expect(score.masterBars[1].tempoAutomations).toEqual([]);expect(autoAt(score,1,model.AutomationType.Volume)).toEqual([]);expect(autoAt(score,1,model.AutomationType.Bank)).toEqual([]);expect(score.tracks[0].staves[0].bars[1].sustainPedals).toEqual([]);
});

it('preserves_inherited_linear_text_visibility_and_held_sustain_through_safe_rebuild',()=>{
  const score=music(),removed=score.tracks[0].staves[0].bars[1],suffix=score.tracks[0].staves[0].bars[2];
  removed.voices[0].beats[3].automations.push(Object.assign(automation(model.AutomationType.Volume,5,.75),{isLinear:true,isVisible:true,text:'lower'}));pedal(removed,model.SustainPedalMarkerType.Down,.75);pedal(suffix,model.SustainPedalMarkerType.Hold);
  applyMeasureEdit(score,{type:'removeMeasures',firstBar:1,lastBar:1});const copy=rebuild(score);
  expect(autoAt(copy,1,model.AutomationType.Volume)).toHaveLength(1);expect(autoAt(copy,1,model.AutomationType.Volume)[0]).toMatchObject({value:5,ratioPosition:0,isLinear:true,isVisible:true,text:'lower'});
  expect(copy.tracks[0].staves[0].bars[1].sustainPedals.map(marker=>[marker.pedalType,marker.ratioPosition])).toEqual([[model.SustainPedalMarkerType.Down,0]]);
});

it('backing_map_moves_surviving_anchors_without_changing_audio_settings',()=>{
  const backing={assetId:'asset',offsetMs:150,mix:{gainDb:-3,pan:.2,mute:false,solo:true},anchors:[{bar:0,occurrence:0,ratio:0,audioMs:10},{bar:1,occurrence:1,ratio:.5,audioMs:110},{bar:3,occurrence:2,ratio:.25,audioMs:500}]};
  mapBackingMeasures(backing,planMeasureMap(5,{type:'removeMeasures',firstBar:1,lastBar:2}));expect(backing).toEqual({assetId:'asset',offsetMs:150,mix:{gainDb:-3,pan:.2,mute:false,solo:true},anchors:[{bar:0,occurrence:0,ratio:0,audioMs:10},{bar:1,occurrence:2,ratio:.25,audioMs:500}]});mapBackingMeasures(null,{oldToNew:[],inserted:[]});
  const invalid={anchors:[{bar:0,occurrence:0,ratio:0,audioMs:0},{bar:9,occurrence:0,ratio:0,audioMs:10}]},before=structuredClone(invalid);expect(()=>mapBackingMeasures(invalid,planMeasureMap(2,{type:'insertMeasures',beforeBar:1,count:1}))).toThrow(/anchor/i);expect(invalid).toEqual(before);
});

// Independent SMF parsing makes musical controller positions the observable contract.
function midiEvents(bytes:Uint8Array) {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let p=10;const tracks=view.getUint16(p);p=14;
  const variable=()=>{let value=0,byte;do{byte=bytes[p++];value=value*128+(byte&127);}while(byte&128);return value;};
  const events:{tick:number;kind:number;data:number[]}[]=[];
  for(let track=0;track<tracks;track++){p+=4;const end=p+4+view.getUint32(p);p+=4;let tick=0,status=0;while(p<end){tick+=variable();let code=bytes[p++];if(code<128){p--;code=status;}else if(code<240)status=code;if(code===255){const kind=bytes[p++],length=variable();events.push({tick,kind,data:[...bytes.slice(p,p+=length)]});}else if(code===240||code===247){const length=variable();p+=length;}else{const kind=code&240,first=bytes[p++],second=kind===192||kind===208?undefined:bytes[p++];events.push({tick,kind,data:second===undefined?[first]:[first,second]});}}}return events;
}
it('SMF_retained_suffix_has_literal_tempo_program_bank_mix_and_fractional_ticks',()=>{
  const score=music(),voice=score.tracks[0].staves[0].bars[1].voices[0];score.masterBars[1].tempoAutomations=[model.Automation.buildTempoAutomation(false,0,90,2)];voice.beats[0].automations.push(automation(model.AutomationType.Instrument,30),automation(model.AutomationType.Bank,2),automation(model.AutomationType.Volume,4,.75),automation(model.AutomationType.Balance,12,.5));voice.beats[3].automations.push(automation(model.AutomationType.Volume,10,.25));noteAt(score,2,3).beat.automations.push(automation(model.AutomationType.Volume,6,.25));noteAt(score,2).dynamics=3;
  applyMeasureEdit(score,{type:'removeMeasures',firstBar:1,lastBar:1});const events=midiEvents(exportMidi(rebuild(score),{tracks:[0],range:null}));
  expect(events.filter(e=>e.kind===81).map(e=>[e.tick,e.data])).toContainEqual([3840,[10,44,42]]);expect(events.filter(e=>e.kind===192).map(e=>[e.tick,e.data[0]])).toContainEqual([3840,30]);expect(events.filter(e=>e.kind===176).map(e=>[e.tick,...e.data])).toEqual(expect.arrayContaining([[3840,32,2],[3840,7,32],[3840,10,96],[4800,7,48]]));expect(events.filter(e=>e.kind===144&&e.tick===3840).map(e=>e.data[1])).toContain(63);
});

it('SMF_inherited_program_and_bank_use_the_active_boundary_voice_when_voice_zero_is_empty',()=>{
  const original=music(),staff=original.tracks[0].staves[0];
  for(const bar of staff.bars){const voice=new model.Voice(),beat=new model.Beat();beat.isEmpty=true;voice.addBeat(beat);bar.addVoice(voice);}
  staff.bars[2].voices.reverse();staff.bars[1].voices[0].beats[0].automations.push(automation(model.AutomationType.Instrument,30),automation(model.AutomationType.Bank,2));
  const score=rebuild(original),before=midiEvents(exportMidi(score,{tracks:[0],range:null}));
  expect(before.filter(event=>event.kind===192).map(event=>[event.tick,...event.data])).toContainEqual([3840,30]);expect(before.filter(event=>event.kind===176).map(event=>[event.tick,...event.data])).toContainEqual([3840,32,2]);
  const sounding=score.tracks[0].staves[0].bars[2].voices[1].beats.map(beat=>[beat.id,beat.duration,beat.playbackStart,beat.notes.map(note=>note.id)]);
  applyMeasureEdit(score,{type:'removeMeasures',firstBar:1,lastBar:1});const copy=rebuild(score),after=midiEvents(exportMidi(copy,{tracks:[0],range:null}));
  expect(after.filter(event=>event.kind===192).map(event=>[event.tick,...event.data])).toContainEqual([3840,30]);expect(after.filter(event=>event.kind===176).map(event=>[event.tick,...event.data])).toContainEqual([3840,32,2]);
  expect(copy.tracks[0].staves[0].bars[1].voices[0].beats.map(beat=>[beat.isEmpty,beat.automations.length])).toEqual([[true,0]]);expect(copy.tracks[0].staves[0].bars[1].voices[1].beats.map(beat=>[beat.id,beat.duration,beat.playbackStart,beat.notes.map(note=>note.id)])).toEqual(sounding);
});

it('missing_processed_boundary_carrier_rejects_atomically_instead_of_delaying_program_or_bank',()=>{
  const score=music();noteAt(score,1).beat.automations.push(automation(model.AutomationType.Instrument,30),automation(model.AutomationType.Bank,2));
  for(const beat of score.tracks[0].staves[0].bars[2].voices[0].beats)beat.playbackStart+=120;
  const before=fingerprint(score);expect(()=>applyMeasureEdit(score,{type:'removeMeasures',firstBar:1,lastBar:1})).toThrow(/program or bank.*boundary/i);expect(fingerprint(score)).toBe(before);expect(score.masterBars).toHaveLength(4);
});

it.each([false,true])('pre_boundary_sounding_grace_rejects_atomically_when_ratio_zero_cannot_restore_its_program (explicit start %s)',explicit=>{
  const original=music(),staff=original.tracks[0].staves[0],grace=new model.Beat(),note=new model.Note();grace.graceType=model.GraceType.BeforeBeat;grace.duration=model.Duration.Sixteenth;grace.isEmpty=false;note.string=6;note.fret=5;grace.addNote(note);grace.voice=staff.bars[2].voices[0];staff.bars[2].voices[0].beats.unshift(grace);
  staff.bars[1].voices[0].beats[0].automations.push(automation(model.AutomationType.Instrument,30));if(explicit)staff.bars[2].voices[0].beats[1].automations.push(automation(model.AutomationType.Instrument,42));const score=rebuild(original),before=fingerprint(score);expect(score.tracks[0].staves[0].bars[2].voices[0].beats[0].playbackStart).toBeLessThan(0);
  expect(()=>applyMeasureEdit(score,{type:'removeMeasures',firstBar:1,lastBar:1})).toThrow(/program or bank.*grace/i);expect(fingerprint(score)).toBe(before);
});

it('SMF_inactive_removed_voice_program_and_bank_do_not_become_effective_after_removal',()=>{
  const original=music(),staff=original.tracks[0].staves[0];for(const bar of staff.bars){const voice=new model.Voice(),beat=new model.Beat();beat.isEmpty=true;voice.addBeat(beat);bar.addVoice(voice);}
  staff.bars[1].voices[0].beats[0].automations.push(automation(model.AutomationType.Instrument,30),automation(model.AutomationType.Bank,2));staff.bars[1].voices[1].beats[0].automations.push(automation(model.AutomationType.Instrument,55),automation(model.AutomationType.Bank,6));
  const score=rebuild(original),before=midiEvents(exportMidi(score,{tracks:[0],range:null}));expect(before.filter(event=>event.kind===192).map(event=>event.data[0])).not.toContain(55);expect(before.filter(event=>event.kind===176).map(event=>event.data)).not.toContainEqual([32,6]);
  applyMeasureEdit(score,{type:'removeMeasures',firstBar:1,lastBar:1});const after=midiEvents(exportMidi(rebuild(score),{tracks:[0],range:null}));
  expect(after.filter(event=>event.kind===192).map(event=>[event.tick,...event.data])).toContainEqual([3840,30]);expect(after.filter(event=>event.kind===176).map(event=>[event.tick,...event.data])).toContainEqual([3840,32,2]);expect(after.filter(event=>event.kind===192).map(event=>event.data[0])).not.toContain(55);
});

it('SMF_inactive_suffix_overrides_stay_stored_but_do_not_suppress_audible_inherited_state',()=>{
  const original=music(),staff=original.tracks[0].staves[0];for(const bar of staff.bars){const voice=new model.Voice(),beat=new model.Beat();beat.isEmpty=true;voice.addBeat(beat);bar.addVoice(voice);}
  staff.bars[2].voices.reverse();staff.bars[1].voices[0].beats[0].automations.push(automation(model.AutomationType.Instrument,30),automation(model.AutomationType.Bank,2));staff.bars[2].voices[0].beats[0].automations.push(automation(model.AutomationType.Instrument,42),automation(model.AutomationType.Bank,3));
  const score=rebuild(original),before=midiEvents(exportMidi(score,{tracks:[0],range:null}));expect(before.filter(event=>event.kind===192).map(event=>event.data[0])).not.toContain(42);
  applyMeasureEdit(score,{type:'removeMeasures',firstBar:1,lastBar:1});const copy=rebuild(score),after=midiEvents(exportMidi(copy,{tracks:[0],range:null}));
  expect(after.filter(event=>event.kind===192).map(event=>[event.tick,...event.data])).toContainEqual([3840,30]);expect(after.filter(event=>event.kind===176).map(event=>[event.tick,...event.data])).toContainEqual([3840,32,2]);expect(after.filter(event=>event.kind===192).map(event=>event.data[0])).not.toContain(42);
  expect(copy.tracks[0].staves[0].bars[1].voices[0].beats[0].automations.map(a=>[a.type,a.value])).toEqual([[model.AutomationType.Instrument,42],[model.AutomationType.Bank,3]]);
});
