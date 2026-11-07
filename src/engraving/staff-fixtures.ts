import { model,Settings } from '@coderline/alphatab';

export interface ThreeTrackOptions {bars?:number;names?:[string,string,string];shortNames?:[string,string,string]}

/**
 * Shared, deterministic score for the staff group and staff gap tests (Tasks 3, 4, 5, 6 and 8).
 *
 * - Track 0 "Guitar6": one staff showing standard notation and tablature, Drop D tuning.
 * - Track 1 "Grand Piano": two standard-notation staves (treble and bass), so alphaTab draws a brace.
 * - Track 2 "Drums": one percussion staff.
 * - Short names Gtr., Pno., Dr.; ids are `base/0`, `base/1` and `base/2`.
 * - 12 bars by default, laid out through the model layout (`systemsLayout`, as the desktop engraving
 *   fixture does) as systems of 2, 2, 4, 2 and 2 bars. Other bar counts follow the same pattern, then two bars each.
 * - Multi-track names show on the first system only unless a test overrides the policy.
 * - Every bar of every staff holds four quarter beats with a note on beats 1 and 3, so nothing is random
 *   and every staff has visible content.
 */
export function threeTrackScore(options:ThreeTrackOptions={}):{score:model.Score;ids:string[]} {
  const bars=options.bars??12,names=options.names??['Guitar6','Grand Piano','Drums'],shortNames=options.shortNames??['Gtr.','Pno.','Dr.'];
  const score=new model.Score();
  const pattern=[2,2,4,2,2],layout:number[]=[];let remaining=bars;
  for(const size of pattern){if(remaining<=0)break;layout.push(Math.min(size,remaining));remaining-=layout[layout.length-1];}
  while(remaining>0){layout.push(Math.min(2,remaining));remaining-=2;}
  score.defaultSystemsLayout=2;score.systemsLayout=layout;
  score.stylesheet.multiTrackTrackNamePolicy=model.TrackNamePolicy.FirstSystem;
  for(let i=0;i<bars;i++)score.addMasterBar(new model.MasterBar());
  const dropD=[64,59,55,50,45,38];
  const kinds=[
    {staves:1,tuning:dropD,percussion:false,channel:[0,1],program:25},
    {staves:2,tuning:[] as number[],percussion:false,channel:[2,3],program:0},
    {staves:1,tuning:[] as number[],percussion:true,channel:[9,9],program:0},
  ];
  kinds.forEach((kind,trackIndex)=>{
    const track=new model.Track();track.name=names[trackIndex];track.shortName=shortNames[trackIndex];
    track.playbackInfo.program=kind.program;track.playbackInfo.primaryChannel=kind.channel[0];track.playbackInfo.secondaryChannel=kind.channel[1];
    track.defaultSystemsLayout=2;track.systemsLayout=[...layout];
    for(let staffIndex=0;staffIndex<kind.staves;staffIndex++){
      const staff=new model.Staff();staff.stringTuning.tunings=[...kind.tuning];staff.stringTuning.name=trackIndex===0?'Drop D':'';
      staff.isPercussion=kind.percussion;staff.showStandardNotation=true;staff.showTablature=trackIndex===0;
      track.addStaff(staff);
      for(let barIndex=0;barIndex<bars;barIndex++){
        const bar=new model.Bar(),voice=new model.Voice();staff.addBar(bar);bar.addVoice(voice);
        bar.clef=kind.percussion?model.Clef.Neutral:trackIndex===1&&staffIndex===1?model.Clef.F4:model.Clef.G2;
        for(let beatIndex=0;beatIndex<4;beatIndex++){
          const beat=new model.Beat();beat.duration=model.Duration.Quarter;beat.isEmpty=false;voice.addBeat(beat);
          if(beatIndex%2)continue;
          const note=new model.Note();
          if(trackIndex===0){note.string=6;note.fret=beatIndex?3:0;}
          else if(kind.percussion)note.percussionArticulation=beatIndex?38:36;
          else{note.octave=staffIndex===0?5:3;note.tone=beatIndex?7:0;}
          beat.addNote(note);
        }
      }
    }
    score.addTrack(track);
  });
  score.finish(new Settings());
  return {score,ids:score.tracks.map((_,index)=>`base/${index}`)};
}
