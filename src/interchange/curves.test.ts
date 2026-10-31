// @vitest-environment jsdom
import { afterEach,describe,expect,it,vi } from 'vitest';
import { exporter,importer,model,Settings } from '@coderline/alphatab';
import { strFromU8,strToU8,unzipSync,zipSync } from 'fflate';
import { music } from '../editor/fixtures';
import { exportGpInterchange,loadInterchangeScore } from './gp';

const settings=new Settings();
afterEach(()=>vi.restoreAllMocks());
const points=(...values:number[][])=>values.map(([offset,value])=>new model.BendPoint(offset,value));
function bend(note:model.Note,type:model.BendType,style:model.BendStyle,...values:number[][]) {
  note.bendType=type;note.bendStyle=style;for(const point of points(...values))note.addBendPoint(point);
}
function whammy(beat:model.Beat,type:model.WhammyType,style:model.BendStyle,...values:number[][]) {
  beat.whammyBarType=type;beat.whammyStyle=style;for(const point of points(...values))beat.addWhammyBarPoint(point);
}
const beatsOf=(score:model.Score,bar:number,voice=0,track=0)=>score.tracks[track].staves[0].bars[bar].voices[voice].beats;
function link(from:model.Note,to:model.Note) {from.slurDestination=to;to.slurOrigin=from;to.isSlurDestination=true;}
/** Bends of every length and style, fractional quarter tones, three whammy shapes and a slur that skips a beat and changes string. */
function authored() {
  const score=music(),bar0=beatsOf(score,0),bar1=beatsOf(score,1);
  bar0[2].notes[0].string=4;bar0[2].notes[0].fret=7;bar0[1].notes[0].string=5;bar0[1].notes[0].fret=5;
  bend(bar0[1].notes[0],model.BendType.Custom,model.BendStyle.Fast,[0,0],[10,2],[20,4],[30,4],[45,1.5],[60,0]);
  bend(bar0[3].notes[0],model.BendType.PrebendRelease,model.BendStyle.Gradual,[0,4],[30,0],[60,3]);
  link(bar0[0].notes[0],bar0[2].notes[0]);
  whammy(bar1[0],model.WhammyType.Custom,model.BendStyle.Gradual,[0,0],[10,-3],[25,-5.5],[40,-0.5],[60,1.5]);
  whammy(bar1[1],model.WhammyType.Hold,model.BendStyle.Fast,[0,-2],[60,-2]);
  whammy(bar1[2],model.WhammyType.Dip,model.BendStyle.Default,[0,0],[20,-4],[40,0],[60,0]);
  score.finish(settings);return score;
}
const pointsOf=(list:model.BendPoint[]|null)=>list?.map(point=>[point.offset,point.value])??null;
/** Everything these rows are about, as plain data. */
function state(score:model.Score) {
  return score.tracks.map(track=>track.staves.map(staff=>staff.bars.map(bar=>bar.voices.map(voice=>voice.beats.map(beat=>({
    whammy:beat.hasWhammyBar?[beat.whammyBarType,beat.whammyStyle,pointsOf(beat.whammyBarPoints)]:null,
    notes:beat.notes.map(note=>({
      string:note.string,fret:note.fret,bend:note.hasBend?[note.bendType,note.bendStyle,pointsOf(note.bendPoints)]:null,
      slur:note.slurDestination?[note.slurDestination.beat.voice.bar.index,note.slurDestination.beat.index,note.slurDestination.string]:null,
      slurIn:!!note.slurOrigin&&note.isSlurDestination,
    })),
  }))))));
}
const roundTrip=(score:model.Score)=>loadInterchangeScore(exportGpInterchange(score,settings),settings);
function edit(bytes:Uint8Array,change:(xml:string)=>string) {
  const entries=unzipSync(bytes);entries['Content/score.gpif']=strToU8(change(strFromU8(entries['Content/score.gpif'])));return zipSync(entries);
}
const warnings=()=>vi.spyOn(console,'warn').mockImplementation(()=>undefined);

describe('GP curves and slurs',()=>{
  it('records what alphaTab alone cannot carry, which is why the property exists',()=>{
    const stock=importer.ScoreLoader.loadScoreFromBytes(new exporter.Gp7Exporter().export(authored(),settings),settings),before=state(authored()),after=state(stock);
    expect(after[0][0][0][0][1].notes[0].bend).toBeNull();// six points: the writer omits the bend
    expect(after[0][0][0][0][0].notes[0].slur).toBeNull();// no note-to-note slur exists in GPIF
    expect(after[0][0][1][0][0].whammy).not.toEqual(before[0][0][1][0][0].whammy);// five points become four, -5.5 becomes -3 and the style goes
    expect(after[0][0][1][0][1].whammy).not.toEqual(before[0][0][1][0][1].whammy);// the two-point hold becomes four points and the style is gone
  });
  it('round trips long bends, whammy bars, quarter tones, styles and a cross-string slur without loss',()=>{
    const score=authored(),expected=state(score),loaded=roundTrip(score);
    expect(state(loaded)).toEqual(expected);
    // A second pass is the same: nothing drifts once restored.
    expect(state(roundTrip(loaded))).toEqual(expected);
    expect(expected[0][0][0][0][1].notes[0].bend).toEqual([model.BendType.Custom,model.BendStyle.Fast,[[0,0],[10,2],[20,4],[30,4],[45,1.5],[60,0]]]);
    expect(expected[0][0][1][0][0].whammy).toEqual([model.WhammyType.Custom,model.BendStyle.Gradual,[[0,0],[10,-3],[25,-5.5],[40,-0.5],[60,1.5]]]);
  });
  it('keeps maxima and continuation consistent with the restored curves',()=>{
    const loaded=roundTrip(authored()),note=beatsOf(loaded,0)[1].notes[0],beat=beatsOf(loaded,1)[0];
    expect(note.maxBendPoint?.value).toBe(4);
    expect(beat.maxWhammyPoint?.value).toBe(1.5);expect(beat.minWhammyPoint?.value).toBe(-5.5);
    expect(beatsOf(loaded,1)[1].isContinuedWhammy).toBe(true);
  });
  it('adds one staff property to a file that otherwise reads as before',()=>{
    const xml=strFromU8(unzipSync(exportGpInterchange(authored(),settings))['Content/score.gpif']);
    expect(xml.match(/name="TabPlayerCurves"/g)).toHaveLength(1);expect(xml).toContain('<Whammy destinationOffset=');
  });
  it('writes no property for a score without curves or slurs',()=>{
    const xml=strFromU8(unzipSync(exportGpInterchange(music(),settings))['Content/score.gpif']);
    expect(xml).not.toContain('TabPlayerCurves');
  });
  it('restores music in a second voice beside an empty first voice',()=>{
    const score=music(),staff=score.tracks[0].staves[0];
    const second=new model.Voice();for(let index=0;index<4;index++){const beat=new model.Beat();beat.duration=4;beat.isEmpty=false;const note=new model.Note();note.string=3;note.fret=2;beat.addNote(note);second.addBeat(beat);}
    staff.bars[0].addVoice(second);staff.bars[0].voices[0].beats.forEach(beat=>{beat.notes=[];beat.isEmpty=true;});
    for(const bar of staff.bars.slice(1)){const quiet=new model.Voice(),beat=new model.Beat();beat.duration=4;beat.isEmpty=true;quiet.addBeat(beat);bar.addVoice(quiet);}
    bend(second.beats[1].notes[0],model.BendType.Bend,model.BendStyle.Fast,[0,0],[15,1],[30,2],[45,3],[60,4]);
    whammy(second.beats[2],model.WhammyType.Dive,model.BendStyle.Gradual,[0,0],[30,-1.5],[60,-3]);link(second.beats[0].notes[0],second.beats[3].notes[0]);
    score.finish(settings);
    const loaded=roundTrip(score),voice=loaded.tracks[0].staves[0].bars[0].voices[1].beats;
    expect(voice[1].notes[0].bendPoints).toHaveLength(5);expect(voice[2].whammyBarPoints?.[1].value).toBe(-1.5);
    expect(voice[0].notes[0].slurDestination).toBe(voice[3].notes[0]);expect(loaded.tracks[0].staves[0].bars[0].voices[0].isEmpty).toBe(true);
  });
  it('keeps curves on the right track',()=>{
    const score=authored(),other=model.JsonConverter.jsonToScore(model.JsonConverter.scoreToJson(music()),settings).tracks[0];other.name='Second';score.addTrack(other);
    whammy(beatsOf(score,2,0,1)[0],model.WhammyType.Dive,model.BendStyle.Fast,[0,0],[20,-1],[40,-2],[50,-2.5],[60,-3]);score.finish(settings);
    const loaded=roundTrip(score);
    expect(state(loaded)).toEqual(state(score));expect(beatsOf(loaded,2,0,1)[0].whammyBarPoints).toHaveLength(5);expect(beatsOf(loaded,2,0,0)[0].hasWhammyBar).toBe(false);
  });
  it('re-derives a tied continuation from a bend alphaTab cannot write',()=>{
    const score=music(),beats=beatsOf(score,0),origin=beats[0].notes[0],destination=beats[1].notes[0];
    bend(origin,model.BendType.Bend,model.BendStyle.Default,[0,0],[15,2],[30,3],[45,3.5],[60,4]);
    origin.tieDestination=destination;destination.tieOrigin=origin;destination.isTieDestination=true;score.finish(settings);
    const loaded=roundTrip(score),a=beatsOf(loaded,0)[0].notes[0],b=beatsOf(loaded,0)[1].notes[0];
    expect(a.bendPoints).toHaveLength(5);expect(b.bendOrigin).toBe(a);
  });
  it('does not override ordinary GPIF fields that were edited after the property was written',()=>{
    warnings();
    // The first whammy alphaTab wrote is the two-point hold: its destination is edited, the longer curves are not.
    const loaded=loadInterchangeScore(edit(exportGpInterchange(authored(),settings),xml=>xml.replace(/destinationValue="-?[\d.]+"/,'destinationValue="-300"')),settings),hold=beatsOf(loaded,1)[1];
    expect(hold.whammyBarPoints).toHaveLength(4);expect(hold.whammyBarPoints?.at(-1)?.value).toBe(-12);
    expect(pointsOf(beatsOf(loaded,1)[0].whammyBarPoints)).toEqual([[0,0],[10,-3],[25,-5.5],[40,-0.5],[60,1.5]]);
    expect(beatsOf(loaded,0)[1].notes[0].bendPoints).toHaveLength(6);
  });
  it('skips a slur whose notes were edited, and a malformed item, without refusing the file',()=>{
    const warn=warnings();
    const loaded=loadInterchangeScore(edit(exportGpInterchange(authored(),settings),xml=>xml.replace(/<Slur ([^>]*?)fret="3"/,'<Slur $1fret="9"').replace(/(<Whammy [^>]*><Point offset=")[^"]+/,'$1oops')),settings);
    expect(beatsOf(loaded,0)[0].notes[0].slurDestination).toBeNull();
    expect(beatsOf(loaded,1)[0].hasWhammyBar).toBe(false);
    expect(beatsOf(loaded,0)[1].notes[0].bendPoints).toHaveLength(6);
    expect(pointsOf(beatsOf(loaded,1)[2].whammyBarPoints)).toEqual([[0,0],[20,-4],[40,0],[60,0]]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('malformed curve'));
  });
  it('ignores an item that refers to music the file no longer holds',()=>{
    const warn=warnings(),loaded=loadInterchangeScore(edit(exportGpInterchange(authored(),settings),xml=>xml.replaceAll('<Bend bar="0"','<Bend bar="40"')),settings);
    expect(beatsOf(loaded,0)[1].notes[0].hasBend).toBe(false);expect(warn).toHaveBeenCalled();
  });
});
