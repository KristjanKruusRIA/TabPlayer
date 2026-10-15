import {afterEach,expect,it,vi} from 'vitest';
import {model,Settings} from '@coderline/alphatab';
import {scoreFromJson} from './model-clone';

afterEach(()=>vi.restoreAllMocks());
it('parses one score JSON once while preserving distinct note dynamics and its source',()=>{
  const score=new model.Score(),track=new model.Track(),staff=new model.Staff(),bar=new model.Bar(),voice=new model.Voice(),beat=new model.Beat();score.addMasterBar(new model.MasterBar());staff.stringTuning.tunings=[64,59,55,50,45,40];score.addTrack(track);track.addStaff(staff);staff.addBar(bar);bar.addVoice(voice);voice.addBeat(beat);beat.duration=model.Duration.Whole;beat.isEmpty=false;
  for(const string of [1,2]){const note=new model.Note();note.string=string;note.fret=3;beat.addNote(note);}score.finish(new Settings());beat.notes[0].dynamics=model.DynamicValue.PP;beat.notes[1].dynamics=model.DynamicValue.FFF;
  const json=model.JsonConverter.scoreToJson(score),parse=vi.spyOn(JSON,'parse'),copy=scoreFromJson(json,new Settings());
  expect(parse.mock.calls.filter(([input])=>input===json)).toHaveLength(1);expect(copy.tracks[0].staves[0].bars[0].voices[0].beats[0].notes.map(note=>note.dynamics)).toEqual([model.DynamicValue.PP,model.DynamicValue.FFF]);expect(model.JsonConverter.scoreToJson(score)).toBe(json);expect(copy).not.toBe(score);
});
