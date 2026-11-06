import { describe, expect, it } from 'vitest';
import { model, Settings } from '@coderline/alphatab';
import { barCompletion } from './bar-completion';

function score(beats:readonly (readonly model.Duration[])[]):model.Score {
  const s=new model.Score(),master=new model.MasterBar();s.addMasterBar(master);
  const track=new model.Track();s.addTrack(track);const staff=new model.Staff();track.addStaff(staff);
  const bar=new model.Bar();staff.addBar(bar);
  for(const durations of beats){const voice=new model.Voice();bar.addVoice(voice);for(const duration of durations){const beat=new model.Beat();beat.duration=duration;voice.addBeat(beat);}}
  s.finish(new Settings());return s;
}

describe('barCompletion',()=>{
  it('marks a filled 4/4 bar complete',()=>{expect(barCompletion(score([[model.Duration.Whole]]),0,0,0)).toEqual({kind:'complete'});});
  it('names the first short or long voice',()=>{
    expect(barCompletion(score([[model.Duration.Half]]),0,0,0)).toEqual({kind:'short',voice:1});
    expect(barCompletion(score([[model.Duration.Whole],[model.Duration.Whole,model.Duration.Quarter]]),0,0,0)).toEqual({kind:'long',voice:2});
  });
  it('reports a bar with no beats as empty',()=>{expect(barCompletion(score([[]]),0,0,0)).toEqual({kind:'empty'});expect(barCompletion(score([[]]),0,0,5)).toEqual({kind:'empty'});});
});
