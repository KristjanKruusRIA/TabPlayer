import {afterEach,expect,it,vi} from 'vitest';
import {model,Settings} from '@coderline/alphatab';
import {buildPlaybackPlan,buildPlaybackPlanFromJson} from './plan';

const settings=new Settings();
function authored(bars=2,tracks=2,staves=1,voices=1,beats=4){
  const score=new model.Score();for(let bar=0;bar<bars;bar++)score.addMasterBar(new model.MasterBar());score.masterBars[0].tempoAutomations=[model.Automation.buildTempoAutomation(false,0,120,2)];
  for(let t=0;t<tracks;t++){const track=new model.Track();track.name=`Authored ${t}`;track.playbackInfo.program=25+t;track.playbackInfo.primaryChannel=t*2;track.playbackInfo.secondaryChannel=t*2+1;score.addTrack(track);
    for(let s=0;s<staves;s++){const staff=new model.Staff();staff.stringTuning.tunings=[64,59,55,50,45,40];track.addStaff(staff);for(let b=0;b<bars;b++){const bar=new model.Bar();staff.addBar(bar);for(let v=0;v<voices;v++){const voice=new model.Voice();bar.addVoice(voice);for(let i=0;i<beats;i++){const beat=new model.Beat();beat.duration=beats===1?model.Duration.Whole:model.Duration.Quarter;beat.isEmpty=false;voice.addBeat(beat);}}}}
  }return score;
}
function note(score:model.Score,track:number,bar:number,beat:number,string=1,fret=3,staff=0,voice=0){const n=new model.Note();n.string=string;n.fret=fret;score.tracks[track].staves[staff].bars[bar].voices[voice].beats[beat].addNote(n);return n;}
function legacyCase(name:string){
  if(name==='indices'){
    const score=authored(2,3);note(score,2,0,0,1,7);note(score,0,1,0,2,2);score.finish(settings);return score;
  }
  if(name==='staves-voices-grace-links'){
    const score=authored(2,2,2,2),voice=score.tracks[0].staves[0].bars[0].voices[0],grace=new model.Beat();grace.duration=model.Duration.Eighth;grace.graceType=model.GraceType.BeforeBeat;grace.isEmpty=false;const g=new model.Note();g.string=1;g.fret=0;grace.addNote(g);grace.voice=voice;voice.beats.unshift(grace);
    const a=note(score,1,0,0,1,3,1,1),b=note(score,1,0,1,1,3,1,1),c=note(score,1,0,2,1,5,1,1),d=note(score,1,0,3,1,7,1,1);a.tieDestination=b;b.tieOrigin=a;b.isTieDestination=true;b.isHammerPullOrigin=true;b.hammerPullDestination=c;c.hammerPullOrigin=b;c.slideOutType=model.SlideOutType.Legato;c.slideTarget=d;d.slideOrigin=c;note(score,1,1,0,2,4,0,1).isPalmMute=true;score.finish(settings);return score;
  }
  if(name==='repeat-simile-bend-controller'){
    const score=authored(4);score.masterBars[0].isRepeatStart=true;score.masterBars[1].repeatCount=2;score.masterBars[2].tempoAutomations=[model.Automation.buildTempoAutomation(false,0,90,2)];score.tracks[0].staves[0].bars[2].simileMark=model.SimileMark.Simple;score.tracks[1].playbackInfo.primaryChannel=16;score.tracks[1].playbackInfo.secondaryChannel=17;note(score,0,0,0);note(score,0,1,0,1,5);const bent=note(score,1,0,0,2,5);bent.addBendPoint(new model.BendPoint(0,0));bent.addBendPoint(new model.BendPoint(60,4));const automation=new model.Automation();automation.type=model.AutomationType.Volume;automation.value=7;automation.ratioPosition=.5;bent.beat.automations.push(automation);note(score,1,3,0);score.rebuildRepeatGroups();score.finish(settings);return score;
  }
  if(name==='dead-brush-articulations-dynamics'){
    const score=authored();const picked=note(score,0,0,0),fingered=note(score,0,0,1),tapped=note(score,0,0,2),harmonic=note(score,0,0,3);picked.beat.pickStroke=model.PickStroke.Down;fingered.rightHandFinger=model.Fingers.IndexFinger;tapped.isLeftHandTapped=true;harmonic.harmonicType=model.HarmonicType.Natural;harmonic.harmonicValue=12;const a=note(score,1,1,0,1),b=note(score,1,1,0,6);a.isDead=b.isDead=true;a.beat.brushType=model.BrushType.BrushDown;a.beat.brushDuration=120;score.finish(settings);picked.dynamics=model.DynamicValue.PP;fingered.dynamics=model.DynamicValue.FFF;return score;
  }
  const score=authored(),a=note(score,0,0,0),b=note(score,1,0,1,1,5);score.finish(settings);a.slurDestination=b;b.slurOrigin=a;b.isSlurDestination=true;return score;
}
function tracksOf(value:unknown):{staves:{bars:unknown[]}[]}[]{return (value instanceof Map?value.get('tracks'):(value as {tracks:unknown}).tracks) as {staves:{bars:unknown[]}[]}[];}
const barsOf=(value:unknown)=>tracksOf(value).reduce((sum,track)=>sum+track.staves.reduce((total,staff)=>total+staff.bars.length,0),0);
afterEach(()=>vi.restoreAllMocks());

// Recorded with the pre-performance implementation before production edits; never update these to accept the optimized output.
it.each(['indices','staves-voices-grace-links','repeat-simile-bend-controller','dead-brush-articulations-dynamics','cross-track-slur'])('prepatch full-plan golden: %s',name=>{
  const score=legacyCase(name),json=model.JsonConverter.scoreToJson(score),ids=score.tracks.map((_,i)=>`added/${i+7}/stable-${i}`),plan=buildPlaybackPlanFromJson(json,ids,17);
  expect(plan).toMatchSnapshot();expect(model.JsonConverter.scoreToJson(score)).toBe(json);expect(plan.tracks.map(track=>track.id)).toEqual(ids);
});
it('deserializes 64 rather than 160 bars for four complete eight-bar single-lane tracks',()=>{
  const score=authored(8,4,1,1,1);for(let t=0;t<4;t++)for(let bar=0;bar<8;bar++)note(score,t,bar,0);score.finish(settings);const source=model.JsonConverter.scoreToJson(score),convert=vi.spyOn(model.JsonConverter,'jsObjectToScore'),plan=buildPlaybackPlan(score,17);
  expect(convert.mock.calls.reduce((sum,[value])=>sum+barsOf(value),0)).toBe(64);const lanes=convert.mock.calls.map(([value])=>value).filter(value=>barsOf(value)===8);expect(lanes).toHaveLength(4);for(const value of lanes)expect(tracksOf(value)).toHaveLength(4);expect(plan.notes).toHaveLength(32);expect(model.JsonConverter.scoreToJson(score)).toBe(source);
});
it('keeps full-score conversion for actual resolved cross-track slur links',()=>{
  const score=legacyCase('cross-track-slur'),a=score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0],b=score.tracks[1].staves[0].bars[0].voices[0].beats[1].notes[0],source=model.JsonConverter.scoreToJson(score);expect(a.slurDestination).toBe(b);expect(b.slurOrigin).toBe(a);
  const convert=vi.spyOn(model.JsonConverter,'jsObjectToScore');buildPlaybackPlan(score,17);expect(convert.mock.calls.map(([value])=>barsOf(value))).toEqual([4,4,4]);expect(a.slurDestination).toBe(b);expect(b.slurOrigin).toBe(a);expect(model.JsonConverter.scoreToJson(score)).toBe(source);
});
