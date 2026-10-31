import { expect, it, vi } from 'vitest';
import { model, Settings } from '@coderline/alphatab';
import { prepareScoreTimers } from './timers';

const settings=new Settings();
function timedScore(tracks=1,staves=1) {
  const score=new model.Score();
  for(let i=0;i<4;i++)score.addMasterBar(new model.MasterBar());
  score.masterBars[0].tempoAutomations=[model.Automation.buildTempoAutomation(false,0,120,2)];
  for(let t=0;t<tracks;t++) {
    const track=new model.Track();track.playbackInfo.primaryChannel=t*2;track.playbackInfo.secondaryChannel=t*2+1;score.addTrack(track);
    for(let s=0;s<staves;s++) {
      const staff=new model.Staff();staff.stringTuning.tunings=[64,59,55,50,45,40];track.addStaff(staff);
      for(let b=0;b<4;b++) {
        const bar=new model.Bar();staff.addBar(bar);const voice=new model.Voice();bar.addVoice(voice);
        for(let i=0;i<4;i++) {
          const beat=new model.Beat();beat.duration=model.Duration.Quarter;beat.isEmpty=false;beat.showTimer=true;beat.timer=999999;voice.addBeat(beat);
          if(i!==1){const note=new model.Note();note.string=6;note.fret=3;beat.addNote(note);}
        }
      }
    }
  }
  score.finish(settings);return score;
}
const beats=(score:model.Score)=>score.tracks.flatMap(t=>t.staves.flatMap(s=>s.bars.flatMap(b=>b.voices.flatMap(v=>v.beats))));
const timers=(score:model.Score,track=0,staff=0)=>score.tracks[track].staves[staff].bars.map(b=>b.voices[0].beats.map(b=>b.timer));

it('timer_uses_first_performed_note_and_rest_times_after_tempo_changes_and_repeat',()=>{
  const score=timedScore();
  score.masterBars[0].isRepeatStart=true;score.masterBars[1].repeatCount=2;
  score.masterBars[0].tempoAutomations=[model.Automation.buildTempoAutomation(false,0,120,2),model.Automation.buildTempoAutomation(false,.5,60,2)];
  score.masterBars[1].tempoAutomations=[model.Automation.buildTempoAutomation(false,0,120,2)];
  score.masterBars[2].tempoAutomations=[model.Automation.buildTempoAutomation(false,0,60,2)];
  score.rebuildRepeatGroups();score.finish(settings);
  prepareScoreTimers(score);
  // Two beats at 120 BPM plus two at 60 BPM take 3s; the next bar takes 2s.
  // The repeated pair takes 10s before bar 3 is performed for the first time.
  expect(timers(score)).toEqual([[0,500,1000,2000],[3000,3500,4000,4500],[10000,11000,12000,13000],[14000,15000,16000,17000]]);
});

it('simultaneous_tracks_and_staves_have_identical_timers_without_mutating_music',()=>{
  const score=timedScore(2,2),original=beats(score),notes=original[0].notes;
  const destination=original[2].notes[0];notes[0].slurDestination=destination;destination.slurOrigin=notes[0];destination.isSlurDestination=true;
  notes[0].dynamics=model.DynamicValue.P;destination.dynamics=model.DynamicValue.FF;
  original[0].automations=[model.Automation.buildTempoAutomation(false,0,90,2)];
  original[3].showTimer=false;original[3].timer=456;
  const before=JSON.parse(model.JsonConverter.scoreToJson(score));
  prepareScoreTimers(score);
  for(let t=0;t<2;t++)for(let s=0;s<2;s++)expect(timers(score,t,s)).toEqual([
    t===0&&s===0?[0,500,1000,456]:[0,500,1000,1500],
    [2000,2500,3000,3500],[4000,4500,5000,5500],[6000,6500,7000,7500],
  ]);
  const after=JSON.parse(model.JsonConverter.scoreToJson(score));
  for(const json of [before,after])for(const t of json.tracks)for(const s of t.staves)for(const b of s.bars)for(const v of b.voices)for(const beat of v.beats)delete beat.timer;
  expect(after).toEqual(before);beats(score).forEach((beat,i)=>expect(beat).toBe(original[i]));
  expect(notes[0].slurDestination).toBe(destination);expect(destination.slurOrigin).toBe(notes[0]);
  expect(notes[0].dynamics).toBe(model.DynamicValue.P);expect(destination.dynamics).toBe(model.DynamicValue.FF);
});

it('integrates_tempo_changes_inside_notes_and_refreshes_the_same_score',()=>{
  const score=timedScore();
  score.masterBars[0].tempoAutomations=[model.Automation.buildTempoAutomation(false,0,120,2),model.Automation.buildTempoAutomation(false,.125,60,2)];
  prepareScoreTimers(score);
  expect(timers(score)[0]).toEqual([0,750,1750,2750]);
  expect(timers(score)[1]).toEqual([3750,4750,5750,6750]);
  score.masterBars[0].tempoAutomations=[model.Automation.buildTempoAutomation(false,0,60,2)];
  prepareScoreTimers(score);
  expect(timers(score)[0]).toEqual([0,1000,2000,3000]);
  expect(timers(score)[1]).toEqual([4000,5000,6000,7000]);
});

it('clears_stale_timer_for_an_empty_voice_the_performed_lookup_omits',()=>{
  const score=timedScore();
  for(const bar of score.tracks[0].staves[0].bars) {
    const voice=new model.Voice(),beat=new model.Beat();
    beat.isEmpty=true;beat.showTimer=true;beat.timer=999999;voice.addBeat(beat);bar.addVoice(voice);
  }
  score.finish(settings);const beat=score.tracks[0].staves[0].bars[0].voices[1].beats[0];
  prepareScoreTimers(score);
  expect(beat.timer).toBeNull();expect(timers(score)[0]).toEqual([0,500,1000,1500]);
});

it('does_no_work_or_change_cached_values_when_no_timer_is_shown',()=>{
  const score=timedScore();for(const beat of beats(score))beat.showTimer=false;
  const before=model.JsonConverter.scoreToJson(score);
  const serializer=vi.spyOn(model.JsonConverter,'scoreToJson').mockImplementation(()=>{throw new Error('inactive timer serialized score');});
  try {prepareScoreTimers(score);} finally {serializer.mockRestore();}
  expect(model.JsonConverter.scoreToJson(score)).toBe(before);
});
