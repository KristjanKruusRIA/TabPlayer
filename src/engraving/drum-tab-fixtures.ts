import { model,Settings } from '@coderline/alphatab';

export interface KitScoreOptions {
  /** Bar 2, beat 3 holds seven hits, one more than the six tab lines. */
  crowded?:boolean;
  /** The drum track gets a second percussion staff, which drum tab does not convert. */
  secondStaff?:boolean;
}

/** The kit pattern of bar 1; bar 2 repeats the crash tied from bar 1, a snare, and the toms (or, when crowded, seven hits). */
export const KIT_BAR_1=[[36,42],[38,42],[36,42,49],[91,53]];

/**
 * An authored score for the drum tab tests: track 0 "Guitar" is a six-string tab staff, track 1 "Drums" is one percussion staff
 * (or two). Two bars of four quarter beats. The crash (49) on bar 1 beat 3 is tied into bar 2 beat 1.
 * Track ids are `base/0` and `base/1`.
 */
export function kitScore(options:KitScoreOptions={}):{score:model.Score;ids:string[]} {
  const score=new model.Score();score.title='Kit';
  score.addMasterBar(new model.MasterBar());score.addMasterBar(new model.MasterBar());
  const guitar=new model.Track();guitar.name='Guitar';guitar.shortName='Gtr.';guitar.playbackInfo.program=25;guitar.playbackInfo.primaryChannel=0;guitar.playbackInfo.secondaryChannel=1;
  const lead=new model.Staff();lead.stringTuning.tunings=[64,59,55,50,45,40];lead.showStandardNotation=true;lead.showTablature=true;guitar.addStaff(lead);
  const drums=new model.Track();drums.name='Drums';drums.shortName='Dr.';drums.playbackInfo.primaryChannel=9;drums.playbackInfo.secondaryChannel=9;
  const bar2:number[][]=[[49],[38],options.crowded?[36,38,42,46,49,53,57]:[47,45],[36]];
  const kits=options.secondStaff?2:1;
  for(let staffIndex=0;staffIndex<kits;staffIndex++){const staff=new model.Staff();staff.isPercussion=true;staff.showStandardNotation=true;drums.addStaff(staff);}
  for(const [index,staff] of [lead,...drums.staves].entries()) {
    const percussion=index>0;
    [KIT_BAR_1,bar2].forEach((hits,barIndex)=>{
      const bar=new model.Bar(),voice=new model.Voice();staff.addBar(bar);bar.addVoice(voice);bar.clef=percussion?model.Clef.Neutral:model.Clef.G2;
      hits.forEach(group=>{
        const beat=new model.Beat();beat.duration=model.Duration.Quarter;beat.isEmpty=false;voice.addBeat(beat);
        if(!percussion){const note=new model.Note();note.string=1;note.fret=barIndex+3;beat.addNote(note);return;}
        for(const id of group){const note=new model.Note();note.percussionArticulation=id;beat.addNote(note);}
      });
    });
  }
  score.addTrack(guitar);score.addTrack(drums);
  score.finish(new Settings());
  // The crash of bar 1 beat 3 continues into bar 2 beat 1 as a tie.
  const staff=drums.staves[0],from=staff.bars[0].voices[0].beats[2].notes.find(note=>note.percussionArticulation===49)!,to=staff.bars[1].voices[0].beats[0].notes[0];
  from.tieDestination=to;to.tieOrigin=from;to.isTieDestination=true;
  return {score,ids:score.tracks.map((_,index)=>`base/${index}`)};
}
