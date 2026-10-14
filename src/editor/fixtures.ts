import { model, Settings } from '@coderline/alphatab';

export const target={track:0,staff:0,bar:0,voice:0,beat:0};
export function music() {
  const score=new model.Score();
  const track=new model.Track();track.name='Guitar';track.playbackInfo.program=25;
  const staff=new model.Staff();staff.stringTuning.tunings=[64,59,55,50,45,40];track.addStaff(staff);score.addTrack(track);
  for(let i=0;i<4;i++) {
    score.addMasterBar(new model.MasterBar());const bar=new model.Bar();bar.clef=model.Clef.G2;
    const voice=new model.Voice();
    for(let b=0;b<4;b++) {const beat=new model.Beat();beat.duration=4;beat.isEmpty=false;const note=new model.Note();note.string=6;note.fret=3;beat.addNote(note);voice.addBeat(beat);}
    bar.addVoice(voice);staff.addBar(bar);
  }
  score.finish(new Settings());return score;
}
export const noteAt=(score:model.Score,bar=0,beat=0,voice=0)=>score.tracks[0].staves[0].bars[bar].voices[voice].beats[beat].notes[0];
export const reopened=(score:model.Score)=>model.JsonConverter.jsonToScore(model.JsonConverter.scoreToJson(score),new Settings());
