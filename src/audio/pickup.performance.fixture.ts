import {model,Settings} from '@coderline/alphatab';

// Track B's longer silent pickup determines the global clock for Track A's tied bend.
export function unequalPickupScore():model.Score {
  const score=new model.Score();score.addMasterBar(new model.MasterBar());score.addMasterBar(new model.MasterBar());score.masterBars[0].isAnacrusis=true;score.masterBars[0].tempoAutomations=[model.Automation.buildTempoAutomation(false,0,120,2)];
  const notes:model.Note[]=[];
  for(let index=0;index<2;index++){
    const track=new model.Track(),staff=new model.Staff();track.name=index===0?'Bent pickup':'Longer silent pickup';track.playbackInfo.program=25;track.playbackInfo.primaryChannel=index*2;track.playbackInfo.secondaryChannel=index*2+1;staff.stringTuning.tunings=[64,59,55,50,45,40];track.addStaff(staff);score.addTrack(track);
    for(let barIndex=0;barIndex<2;barIndex++){
      const bar=new model.Bar(),voice=new model.Voice();staff.addBar(bar);bar.addVoice(voice);
      for(let beatIndex=0;beatIndex<(barIndex===0?1:4);beatIndex++){
        const beat=new model.Beat();beat.duration=barIndex===0&&index===1?model.Duration.Half:model.Duration.Quarter;beat.isEmpty=false;voice.addBeat(beat);
        if(index===0&&beatIndex===0){const note=new model.Note();note.string=1;note.fret=3;beat.addNote(note);notes.push(note);}
      }
    }
  }
  notes[0].addBendPoint(new model.BendPoint(0,0));notes[0].addBendPoint(new model.BendPoint(60,4));notes[0].tieDestination=notes[1];notes[1].tieOrigin=notes[0];notes[1].isTieDestination=true;score.finish(new Settings());return score;
}
