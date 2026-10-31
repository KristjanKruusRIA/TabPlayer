import { existsSync,readFileSync,readdirSync } from 'node:fs';
import { describe,expect,it } from 'vitest';
import { Environment,io,model,Settings } from '@coderline/alphatab';
import { exportGp5,gp5Warning,previewGp5,Gp5Refusal } from './gp5';
import { loadInterchangeScore } from '../interchange/gp';
import { music } from '../editor/fixtures';
import { setLyricsSource } from '../editor/lyrics-source';
import { setBanjoDrone } from '../editor/banjo-drone';
import { setPartialCapo } from '../editor/partial-capo';

/** alphaTab's own GP3-5 reader, run to the end of the data: it must use every byte and need none more. */
function readBack(bytes:Uint8Array):model.Score {
  const reader=Environment.buildImporters()[0] as unknown as {init(data:unknown,settings:unknown):void;readScore():model.Score;data:{position:number;length:number}};
  // Guitar Pro 5 text is in the Windows Western codepage.
  const decoding=new Settings();decoding.importer.encoding='windows-1252';
  reader.init(io.ByteBuffer.fromBuffer(bytes),decoding);
  const score=reader.readScore();
  expect(reader.data.position).toBe(reader.data.length);
  return score;
}
const everything=(score:model.Score)=>({tracks:score.tracks.map((_,index)=>index),range:null});
const settings=new Settings();

/** The bar whose notes sound, resolving simile marks the way the writer does. */
function sounding(bar:model.Bar):model.Bar {
  const back=bar.simileMark===model.SimileMark.Simple?1:bar.simileMark===model.SimileMark.None?0:2;
  let source:model.Bar|null=bar;for(let i=0;i<back&&source;i++)source=source.previousBar;
  return source&&source!==bar?sounding(source):bar;
}
const spoken=(beat:model.Beat)=>beat.notes.length>0||!beat.isEmpty;
const mainBeats=(voice:model.Voice|undefined)=>(voice?.beats??[]).filter(beat=>beat.graceType===model.GraceType.None&&spoken(beat));

/** Everything about the music a reader can compare: rhythm, pitches and the techniques the format holds. */
function rhythm(score:model.Score) {
  return score.tracks.map(track=>track.staves[0].bars.map(bar=>[0,1].map(v=>mainBeats(sounding(bar).voices[v]).map(beat=>({
    rest:beat.isRest,duration:beat.duration,dots:beat.dots,tuplet:beat.hasTuplet?`${beat.tupletNumerator}:${beat.tupletDenominator}`:'',start:beat.playbackStart,absolute:bar.masterBar.start+beat.playbackStart,length:beat.playbackDuration,
    pitches:beat.notes.map(note=>note.realValue).sort((a,b)=>a-b),
  })))));
}
function notes(score:model.Score) {
  return score.tracks.map(track=>track.staves[0].bars.map(bar=>[0,1].map(v=>mainBeats(sounding(bar).voices[v]).map(beat=>({
    dynamics:beat.notes.length?beat.dynamics:undefined,text:beat.text,chord:beat.hasChord?beat.chord?.name:undefined,
    notes:beat.notes.map(note=>({
      string:note.string,fret:note.isTieDestination&&note.tieOrigin?note.tieOrigin.fret:note.fret,dead:note.isDead,ghost:note.isGhost,tie:note.isTieDestination,accent:note.accentuated,
      bend:note.bendPoints?.map(point=>[point.offset,point.value]),hammer:note.isHammerPullOrigin,letRing:note.isLetRing,palmMute:note.isPalmMute,staccato:note.isStaccato,vibrato:note.vibrato,
      slideIn:note.slideInType,slideOut:note.slideOutType,harmonic:note.harmonicType,harmonicValue:note.harmonicType===model.HarmonicType.None?0:Math.round(note.harmonicValue),
      trill:note.isTrill?[note.trillValue,note.trillSpeed]:null,fingers:[note.leftHandFinger,note.rightHandFinger],
    })).sort((a,b)=>a.string-b.string),
  })))));
}
function roundTrip(score:model.Score,selection=everything(score)) {
  const result=exportGp5(score,selection),back=readBack(result.bytes);
  return {...result,back};
}
/** Rhythm and pitch of what was exported, from the source, for the selected tracks and measures. */
function expectSameMusic(source:model.Score,back:model.Score,tracks=source.tracks.map((_,index)=>index),first=0,last=source.masterBars.length-1) {
  // Absolute ticks count from the start of the exported measures, so a pickup or a mis-sized measure shifts everything after it.
  const origin=source.masterBars[first].start;
  const slice=(value:ReturnType<typeof rhythm>)=>tracks.map(track=>value[track].slice(first,last+1).map(bar=>bar.map(voice=>voice.map(beat=>({...beat,absolute:beat.absolute-origin})))));
  expect(back.tracks.length).toBe(tracks.length);
  expect(rhythm(back)).toEqual(slice(rhythm(source)));
}

type Spec={d?:model.Duration;n?:[number,number][];dots?:number;tuplet?:[number,number];grace?:{fret:number;string?:number;onBeat?:boolean}};
function fill(bar:model.Bar,specs:Spec[]):void {
  const voice=new model.Voice();
  if(!specs.length){const beat=new model.Beat();beat.isEmpty=true;voice.addBeat(beat);}
  for(const spec of specs){
    const beat=new model.Beat();beat.duration=spec.d??model.Duration.Quarter;beat.dots=spec.dots??0;beat.isEmpty=false;
    if(spec.tuplet){beat.tupletNumerator=spec.tuplet[0];beat.tupletDenominator=spec.tuplet[1];}
    for(const [string,fret] of spec.n??[]){const note=new model.Note();note.string=string;note.fret=fret;beat.addNote(note);}
    voice.addBeat(beat);
    if(spec.grace){
      const grace=new model.Beat(),note=new model.Note();grace.isEmpty=false;grace.duration=model.Duration.ThirtySecond;grace.graceType=spec.grace.onBeat?model.GraceType.OnBeat:model.GraceType.BeforeBeat;
      note.string=spec.grace.string??beat.notes[0].string;note.fret=spec.grace.fret;grace.addNote(note);voice.addGraceBeat(grace);
    }
  }
  bar.addVoice(voice);
}
/** Tracks of one stringed staff each, one voice per bar (a second voice per bar when `second` is given). A note is [string, fret], counting strings from the lowest. */
function build(bars:Spec[][],tuning=[64,59,55,50,45,40],tracks=1,second?:Spec[][]):model.Score {
  const score=new model.Score();
  for(let t=0;t<tracks;t++){
    const track=new model.Track(),staff=new model.Staff();
    track.name=tracks>1?`Guitar ${t+1}`:'Guitar';track.playbackInfo.program=25+t;staff.stringTuning.tunings=tuning;staff.displayTranspositionPitch=-12;track.addStaff(staff);score.addTrack(track);
  }
  bars.forEach((specs,index)=>{
    score.addMasterBar(new model.MasterBar());
    for(const track of score.tracks){const bar=new model.Bar();bar.clef=model.Clef.G2;fill(bar,specs);if(second?.[index])fill(bar,second[index]);track.staves[0].addBar(bar);}
  });
  score.finish(settings);return score;
}
const beatOf=(score:model.Score,bar=0,index=0,voice=0,track=0)=>score.tracks[track].staves[0].bars[bar].voices[voice].beats[index];
const noteOf=(score:model.Score,bar=0,index=0,voice=0,track=0)=>beatOf(score,bar,index,voice,track).notes[0];
const D=model.Duration;

const corpus='.analysis/compatibility';
describe.skipIf(!existsSync(corpus))('Guitar Pro 5 export against the compatibility corpus',()=>{
  const sample=`${corpus}/guitarpro5-notes.gp5`;
  it.skipIf(!existsSync(sample))('writes a real Guitar Pro 5.10 file back byte for byte, apart from the unused tail of its version field',()=>{
    const original=new Uint8Array(readFileSync(sample)),score=loadInterchangeScore(original,settings),written=exportGp5(score,everything(score)).bytes;
    expect(written.length).toBe(original.length);
    // The version field holds 24 characters in a 30-byte field; the real file leaves the spare bytes unset.
    expect(Array.from(written.subarray(0,25))).toEqual(Array.from(original.subarray(0,25)));
    expect(Array.from(written.subarray(31))).toEqual(Array.from(original.subarray(31)));
  });
  it.each(existsSync(corpus)?readdirSync(corpus).filter(name=>/\.(gp|gpx|gp[3-8])$/.test(name)):[])('reads %s back through alphaTab with the same rhythm and pitches',name=>{
    const score=loadInterchangeScore(new Uint8Array(readFileSync(`${corpus}/${name}`)),settings),{back}=roundTrip(score);
    expectSameMusic(score,back);
    expect(notes(back)).toEqual(notes(score));
    expect(back.masterBars.map(bar=>[bar.timeSignatureNumerator,bar.timeSignatureDenominator,bar.keySignature])).toEqual(score.masterBars.map(bar=>[bar.timeSignatureNumerator,bar.timeSignatureDenominator,bar.keySignature]));
    expect(back.tracks.map(track=>track.staves[0].tuning)).toEqual(score.tracks.map(track=>track.staves[0].tuning));
  });
});

describe('Guitar Pro 5 writer',()=>{
  it('keeps pitches, durations and bar lengths of a plain score, with a header alphaTab reads',()=>{
    const score=build([[{n:[[6,3]]},{n:[[5,2],[1,0]],d:D.Eighth},{d:D.Eighth},{n:[[4,5]],d:D.Half}],[{d:D.Whole,n:[[3,7]]}]]);
    score.title='Etude';score.artist='Someone';
    const {back,losses}=roundTrip(score);
    expect(losses).toEqual([]);
    expectSameMusic(score,back);
    expect([back.title,back.artist]).toEqual(['Etude','Someone']);
    expect(back.tempo).toBe(score.tempo);
    expect(back.tracks[0].staves[0].tuning).toEqual([64,59,55,50,45,40]);
  });
  it('writes text in the Windows Western codepage, reports what that cannot hold, and cuts fields at their size',()=>{
    const score=build([[{n:[[6,3]]}]]);score.title='Für Elise – “Étude” €5';score.artist='練習';score.tracks[0].name='Ü'.repeat(45);
    const {bytes,back,losses}=roundTrip(score);
    expect(back.title).toBe('Für Elise – “Étude” €5');
    // The file holds one byte for ü, as Guitar Pro 5 does; read as UTF-8 it is not a letter.
    expect(Array.from(bytes).includes(0xfc)).toBe(true);
    expect(back.tracks[0].name).toBe('Ü'.repeat(40));
    expect(back.artist).toBe('??');
    expect(losses).toEqual(['Characters outside Western European text, which Guitar Pro 5 cannot store, become question marks (2)','Text longer than Guitar Pro 5 allows is shortened']);
  });
  it('keeps the tempo, a tempo change on a beat, repeats, endings, sections, keys, time signatures and swing',()=>{
    const four=[{n:[[6,3]] as [number,number][]},{n:[[6,5]] as [number,number][]},{n:[[6,7]] as [number,number][]},{n:[[6,8]] as [number,number][]}];
    const score=build([four,four,four.slice(0,3),four.slice(0,3)]),bars=score.masterBars;
    const tempo=(value:number,ratioPosition:number)=>Object.assign(new model.Automation(),{type:model.AutomationType.Tempo,value,ratioPosition});
    bars[0].tempoAutomations.push(tempo(96,0));bars[1].tempoAutomations.push(tempo(140,.5));
    bars[0].section=Object.assign(new model.Section(),{text:'Verse'});bars[0].isRepeatStart=true;bars[1].repeatCount=3;
    bars[2].timeSignatureNumerator=3;bars[3].timeSignatureNumerator=3;bars[2].alternateEndings=1;bars[3].alternateEndings=2;
    bars[2].keySignature=model.KeySignature.D;bars[3].keySignature=model.KeySignature.D;bars[2].tripletFeel=model.TripletFeel.Triplet8th;bars[3].isDoubleBar=true;
    score.finish(settings);
    const {back,losses}=roundTrip(score);
    expect(losses).toEqual([]);
    expect(back.tempo).toBe(96);
    expect(back.masterBars[1].tempoAutomations.map(change=>[change.value,change.ratioPosition])).toEqual([[140,.5]]);
    const marks=(value:model.Score)=>value.masterBars.map(bar=>[bar.isRepeatStart,bar.repeatCount,bar.alternateEndings,bar.timeSignatureNumerator,bar.timeSignatureDenominator,bar.keySignature,bar.tripletFeel,bar.isDoubleBar,bar.section?.text??'']);
    expect(marks(back)).toEqual(marks(score));
    expectSameMusic(score,back);
  });
});

/** Beat-level effects, which sit in the beat record rather than a note. */
function effects(score:model.Score) {
  return score.tracks.map(track=>track.staves[0].bars.map(bar=>mainBeats(sounding(bar).voices[0]).map(beat=>({
    tremolo:beat.isTremolo?beat.tremoloPicking?.marks:0,brush:[beat.brushType,beat.brushDuration],pick:beat.pickStroke,slap:[beat.tap,beat.slap,beat.pop],fade:beat.fade,vibrato:beat.vibrato,
    whammy:beat.whammyBarPoints?.map(point=>[point.offset,point.value])??null,ottava:beat.ottava,rasgueado:beat.rasgueado,
  }))));
}
/** A one-bar track of four quarter notes on the lowest string (frets 3, 5, 7, 8); `change` marks it up before the score is finished. */
function marked(change:(score:model.Score)=>void,bars=1) {
  const bar=[{n:[[6,3]] as [number,number][]},{n:[[6,5]] as [number,number][]},{n:[[6,7]] as [number,number][]},{n:[[6,8]] as [number,number][]}];
  const score=build(Array.from({length:bars},()=>bar));change(score);score.finish(settings);return score;
}
function expectKept(score:model.Score,losses:string[]=[]) {
  const result=roundTrip(score);
  expect(result.losses).toEqual(losses);
  expectSameMusic(score,result.back);
  expect(notes(result.back)).toEqual(notes(score));
  expect(effects(result.back)).toEqual(effects(score));
  return result;
}
const bend=(note:model.Note,type:model.BendType,...points:[number,number][])=>{note.bendType=type;for(const [offset,value] of points)note.addBendPoint(new model.BendPoint(offset,value));};

describe('Guitar Pro 5 techniques',()=>{
  it('keeps bends, releases and prebends with their points',()=>{
    expectKept(marked(score=>{
      bend(noteOf(score,0,0),model.BendType.Bend,[0,0],[60,4]);
      bend(noteOf(score,0,1),model.BendType.BendRelease,[0,0],[20,4],[40,4],[60,0]);
      bend(noteOf(score,0,2),model.BendType.Prebend,[0,4],[60,4]);
      bend(noteOf(score,0,3),model.BendType.Release,[0,4],[60,0]);
    }));
  });
  it('keeps hammer-ons, slides, ghost, dead, accent, let ring, palm mute, staccato and vibrato notes',()=>{
    expectKept(marked(score=>{
      noteOf(score,0,0).isHammerPullOrigin=true;noteOf(score,0,1).slideOutType=model.SlideOutType.Shift;noteOf(score,0,2).slideOutType=model.SlideOutType.Legato;
      noteOf(score,0,3).slideInType=model.SlideInType.IntoFromBelow;noteOf(score,0,3).slideOutType=model.SlideOutType.OutDown;
    },2));
    expectKept(marked(score=>{
      noteOf(score,0,0).isGhost=true;noteOf(score,0,1).isDead=true;noteOf(score,0,2).accentuated=model.AccentuationType.Heavy;noteOf(score,0,3).accentuated=model.AccentuationType.Normal;
      noteOf(score,1,0).isLetRing=true;noteOf(score,1,1).isPalmMute=true;noteOf(score,1,2).isStaccato=true;noteOf(score,1,3).vibrato=model.VibratoType.Slight;
    },2));
  });
  it('keeps natural, artificial, tap, pinch and semi harmonics',()=>{
    expectKept(marked(score=>{
      const natural=noteOf(score,0,0);natural.fret=12;natural.harmonicType=model.HarmonicType.Natural;natural.harmonicValue=12;
      const artificial=noteOf(score,0,1);artificial.harmonicType=model.HarmonicType.Artificial;artificial.harmonicValue=12;
      const tap=noteOf(score,0,2);tap.harmonicType=model.HarmonicType.Tap;tap.harmonicValue=12;
      const pinch=noteOf(score,0,3);pinch.harmonicType=model.HarmonicType.Pinch;pinch.harmonicValue=12;
    }));
    const seventh=marked(score=>{const note=noteOf(score,0,0);note.fret=2;note.harmonicType=model.HarmonicType.Artificial;note.harmonicValue=7;noteOf(score,0,1).harmonicType=model.HarmonicType.Semi;noteOf(score,0,1).harmonicValue=12;});
    const {back}=expectKept(seventh);
    expect(noteOf(back,0,0).harmonicPitch).toBe(noteOf(seventh,0,0).harmonicPitch);
  });
  it('keeps trills, tremolo picking, whammy bar, strokes, slaps, fades and vibrato on beats',()=>{
    expectKept(marked(score=>{
      const trill=noteOf(score,0,0);trill.trillValue=trill.stringTuning+trill.fret+2;trill.trillSpeed=model.Duration.Sixteenth;
      beatOf(score,0,1).tremoloPicking=Object.assign(new model.TremoloPickingEffect(),{marks:2});
      beatOf(score,0,2).whammyBarType=model.WhammyType.Dive;for(const point of [new model.BendPoint(0,0),new model.BendPoint(30,-8),new model.BendPoint(60,-8)])beatOf(score,0,2).addWhammyBarPoint(point);
      beatOf(score,0,3).brushType=model.BrushType.BrushDown;beatOf(score,0,3).brushDuration=120;
    }));
    expectKept(marked(score=>{
      beatOf(score,0,0).pickStroke=model.PickStroke.Down;beatOf(score,0,1).pickStroke=model.PickStroke.Up;beatOf(score,0,2).slap=true;beatOf(score,0,3).pop=true;
      beatOf(score,1,0).tap=true;beatOf(score,1,1).fade=model.FadeType.FadeIn;beatOf(score,1,2).vibrato=model.VibratoType.Slight;beatOf(score,1,3).brushType=model.BrushType.BrushUp;beatOf(score,1,3).brushDuration=60;
    },2));
  });
  it('keeps fingering, note length, octave marks and beat text',()=>{
    const result=expectKept(marked(score=>{
      noteOf(score,0,0).leftHandFinger=model.Fingers.IndexFinger;noteOf(score,0,0).rightHandFinger=model.Fingers.Thumb;
      noteOf(score,0,1).durationPercent=.5;beatOf(score,0,2).ottava=model.Ottavia._8va;beatOf(score,0,3).text='riff';
    }));
    expect(noteOf(result.back,0,1).durationPercent).toBe(.5);expect(beatOf(result.back,0,2).ottava).toBe(model.Ottavia._8va);
  });
  it('keeps ties by writing the tied fret',()=>{
    const score=marked(change=>{const first=noteOf(change,0,0),second=noteOf(change,0,1);second.isTieDestination=true;second.fret=first.fret;first.tieDestination=second;second.tieOrigin=first;});
    const {back}=roundTrip(score);
    expect(noteOf(back,0,1).isTieDestination).toBe(true);expect(noteOf(back,0,1).realValue).toBe(noteOf(score,0,0).realValue);
    expectSameMusic(score,back);
  });
  it('keeps a dynamic until it changes, including a return to forte',()=>{
    const score=marked(change=>{beatOf(change,0,0).dynamics=model.DynamicValue.P;beatOf(change,0,1).dynamics=model.DynamicValue.P;beatOf(change,0,2).dynamics=model.DynamicValue.F;beatOf(change,0,3).dynamics=model.DynamicValue.FFF;},2);
    const {back}=expectKept(score);
    expect(notes(back)[0][0][0].map(beat=>beat.dynamics)).toEqual([model.DynamicValue.P,model.DynamicValue.P,model.DynamicValue.F,model.DynamicValue.FFF]);
    expect(notes(back)[0][1][0].map(beat=>beat.dynamics)).toEqual([model.DynamicValue.F,model.DynamicValue.F,model.DynamicValue.F,model.DynamicValue.F]);
  });
});

const q=(string:number,fret:number,more:Partial<Spec>={}):Spec=>({n:[[string,fret]],...more});
describe('Guitar Pro 5 rhythm and structure',()=>{
  it('keeps dotted notes and every tuplet the format has, with the same bar lengths',()=>{
    const e=D.Eighth,s16=D.Sixteenth;
    const score=build([
      [q(6,1,{d:D.Quarter,dots:1}),q(6,2,{d:e}),q(6,3,{d:D.Half})],
      [q(6,3,{d:e,tuplet:[3,2]}),q(6,5,{d:e,tuplet:[3,2]}),q(6,7,{d:e,tuplet:[3,2]}),q(6,1,{d:D.Half,dots:1})],
      [...[1,2,3,4,5].map(f=>q(6,f,{d:s16,tuplet:[5,4]})),...[1,2,3,4,5,6].map(f=>q(6,f,{d:s16,tuplet:[6,4]})),...[1,2,3,4,5,6,7].map(f=>q(6,f,{d:s16,tuplet:[7,4]}))],
      [...[1,2,3,4,5,6,7,8,9].map(f=>q(6,f,{d:s16,tuplet:[9,8]})),...[1,2,3,4,5,6,7,8,9,10].map(f=>q(6,f,{d:s16,tuplet:[10,8]}))],
    ]);
    const {back}=roundTrip(score);
    expectSameMusic(score,back);
    expect(rhythm(back)[0][2][0].map(beat=>beat.tuplet).slice(0,6)).toEqual(['5:4','5:4','5:4','5:4','5:4','6:4']);
  });
  it('keeps rests, empty measures and a second voice',()=>{
    const score=build([[q(6,3),{},q(6,5),{d:D.Half,n:[]}],[{d:D.Whole,n:[]}]],undefined,1,[[{d:D.Whole,n:[[4,2]]}],[]]);
    // The second voice of the first measure is a held note; the second measure's second voice is missing and comes back empty.
    const {back}=roundTrip(score);
    expectSameMusic(score,back);
    expect(back.tracks[0].staves[0].bars[0].voices[1].beats[0].notes[0].fret).toBe(2);
    expect(rhythm(back)[0][0][0].map(beat=>beat.rest)).toEqual([false,true,false,true]);
  });
  it('keeps grace notes before and on the beat, with their string and fret',()=>{
    const score=build([[q(6,5,{grace:{fret:3}}),q(6,7,{grace:{fret:5,onBeat:true}}),q(6,8),q(6,10)]]);
    const {back,losses}=roundTrip(score);
    expect(losses).toEqual([]);
    const graces=back.tracks[0].staves[0].bars[0].voices[0].beats.filter(beat=>beat.graceType!==model.GraceType.None);
    expect(graces.map(beat=>[beat.graceType,beat.notes[0].string,beat.notes[0].fret])).toEqual([[model.GraceType.BeforeBeat,6,3],[model.GraceType.OnBeat,6,5]]);
    expectSameMusic(score,back);
  });
  it('writes a simile measure out as the notes it repeats',()=>{
    const score=build([[q(6,3),q(6,5),q(6,7),q(6,8)],[{d:D.Whole,n:[]}]]);
    score.tracks[0].staves[0].bars[1].simileMark=model.SimileMark.Simple;score.finish(settings);
    const {back,losses}=roundTrip(score);
    expect(losses).toEqual([]);
    expect(back.tracks[0].staves[0].bars[1].voices[0].beats.map(beat=>beat.notes[0].fret)).toEqual([3,5,7,8]);
    expectSameMusic(score,back);
  });
  it('keeps a seven-string tuning, a capo and chord diagrams and text',()=>{
    const score=build([[q(7,0),q(1,3),q(3,2),q(5,1)]],[64,59,55,50,45,40,35]);
    score.tracks[0].staves[0].capo=2;
    const chord=Object.assign(new model.Chord(),{name:'Am7',firstFret:1,strings:[0,1,0,2,0,-1,-1],barreFrets:[]});
    chord.staff=score.tracks[0].staves[0];score.tracks[0].staves[0].addChord('c1',chord);beatOf(score,0,0).chordId='c1';beatOf(score,0,1).text='Verse riff';
    score.finish(settings);
    const {back}=roundTrip(score);
    const staff=back.tracks[0].staves[0];
    expect(staff.tuning).toEqual([64,59,55,50,45,40,35]);expect(staff.capo).toBe(2);
    expect(beatOf(back,0,0).chord).toMatchObject({name:'Am7',firstFret:1,strings:[0,1,0,2,0,-1,-1]});
    expect(beatOf(back,0,1).text).toBe('Verse riff');
    expectSameMusic(score,back);
  });
  it('keeps directions, once each, and leaves out a repeated one saying so',()=>{
    const score=build([[q(6,3)],[q(6,3)],[q(6,3)],[q(6,3)]]);
    score.masterBars[0].addDirection(model.Direction.TargetSegno);score.masterBars[2].addDirection(model.Direction.JumpDalSegno);score.masterBars[3].addDirection(model.Direction.JumpDalSegno);score.masterBars[1].addDirection(model.Direction.TargetFine);
    const {back,losses}=roundTrip(score);
    expect(back.masterBars.map(bar=>[...(bar.directions??[])])).toEqual([[model.Direction.TargetSegno],[model.Direction.TargetFine],[model.Direction.JumpDalSegno],[]]);
    expect(losses).toEqual(['A direction used again in another measure is kept in the first only']);
  });
  it('keeps lyrics on the first track that has them, and says which are left out',()=>{
    const score=build([[q(6,3),q(6,5),q(6,7),q(6,8)],[q(6,3),q(6,5),q(6,7),q(6,8)]],undefined,2);
    setLyricsSource(score.tracks[1],{visible:true,lines:[{startBar:0,text:'Hel-lo wor-ld again for you'}]},true);
    setLyricsSource(score.tracks[0],{visible:true,lines:[]},true);
    const {back,losses}=roundTrip(score);
    expect(losses).toEqual([]);
    expect(back.tracks[1].staves[0].bars[0].voices[0].beats.map(beat=>beat.lyrics?.[0])).toEqual(['Hel-','lo','wor-','ld']);
  });
  it('keeps the tracks, their instruments, mixer settings, mute and solo, and gives percussion its channel',()=>{
    const score=build([[q(6,3),q(6,5)]],undefined,3);
    const [first,second,third]=score.tracks;
    first.playbackInfo.volume=9;first.playbackInfo.balance=4;first.playbackInfo.bank=1;second.playbackInfo.isMute=true;second.playbackInfo.program=33;third.playbackInfo.isSolo=true;third.name='Bass';third.color=new model.Color(10,20,30);
    third.staves[0].stringTuning.tunings=[52,47,43,38,33,28];
    const {back}=roundTrip(score);
    expect(back.tracks.map(track=>track.name)).toEqual(['Guitar 1','Guitar 2','Bass']);
    const mixer=(value:model.Score)=>value.tracks.map(track=>[track.playbackInfo.program,track.playbackInfo.volume,track.playbackInfo.balance,track.playbackInfo.bank,track.playbackInfo.isMute,track.playbackInfo.isSolo]);
    expect(mixer(back)).toEqual(mixer(score));expect(mixer(back)[0]).toEqual([25,9,4,1,false,false]);
    expect(back.tracks[2].color.rgba).toBe(new model.Color(10,20,30).rgba);
    expect(new Set(back.tracks.map(track=>track.playbackInfo.secondaryChannel)).size).toBe(3);
  });
});

describe('Guitar Pro 5 reporting and refusals',()=>{
  const refuse=(score:model.Score,pattern:RegExp)=>{
    expect(()=>exportGp5(score,everything(score))).toThrow(Gp5Refusal);
    expect(previewGp5(score,everything(score))).toEqual({refusal:expect.stringMatching(pattern)});
  };
  it('exports only the chosen tracks and measures',()=>{
    const score=build([[q(6,1),q(6,2)],[q(6,3),q(6,4)],[q(6,5),q(6,6)]],undefined,2);
    const result=exportGp5(score,{tracks:[1],range:{first:1,last:2}}),back=readBack(result.bytes);
    expect(back.tracks.map(track=>track.name)).toEqual(['Guitar 2']);
    expectSameMusic(score,back,[1],1,2);
    expect(result.losses).toEqual([]);
  });
  it('lists backing audio, extra staves, slurs and layout-free marks as left out, never silently',()=>{
    const score=build([[q(6,1),q(6,2)]]);
    const staff=new model.Staff();staff.stringTuning.tunings=[64,59,55,50,45,40];score.tracks[0].addStaff(staff);
    const bar=new model.Bar();bar.clef=model.Clef.G2;fill(bar,[q(6,1)]);staff.addBar(bar);
    score.masterBars[0].addFermata(0,Object.assign(new model.Fermata(),{type:model.FermataType.Medium,length:1}));score.finish(settings);
    const result=exportGp5(score,everything(score),{backing:true});
    expect(result.losses).toEqual(expect.arrayContaining(['Backing audio and its synchronization are left out','Staves after the first of a track are left out','Fermatas are left out']));
    expect(gp5Warning(result.losses).message).toContain('Backing audio and its synchronization are left out');
    expect(gp5Warning(result.losses).message).toContain('not stored in a Guitar Pro 5 file');
    expect(gp5Warning([]).message).toContain('Everything in this selection');
  });
  it('writes a banjo drone staff with the same sounding pitches as a plain staff and says so',()=>{
    const score=build([[q(5,0),q(5,7),q(5,9),q(1,0)]],[62,59,55,50,67]);
    setBanjoDrone(score.tracks[0].staves[0],5);
    const sounding=score.tracks[0].staves[0].bars[0].voices[0].beats.map(beat=>beat.notes[0].realValue);
    const {back,losses}=roundTrip(score);
    expect(losses).toEqual(['Banjo drone staves are written as plain 5-string staves with the same pitches']);
    expect(back.tracks[0].staves[0].bars[0].voices[0].beats.map(beat=>beat.notes[0].realValue)).toEqual(sounding);
  });
  it('refuses what it could only write with changed pitches or rhythm',()=>{
    const partial=build([[q(6,1)]]);setPartialCapo(partial.tracks[0].staves[0],{fret:2,strings:[1,2]});refuse(partial,/partial capo/);
    const transposing=build([[q(6,1)]]);transposing.tracks[0].staves[0].displayTranspositionPitch=0;transposing.tracks[0].staves[0].transpositionPitch=-12;refuse(transposing,/transposing/);
    refuse(build([[q(6,1,{tuplet:[4,3]})]]),/4:3 tuplet/);
    refuse(build([[q(6,1,{dots:2})]]),/double-dotted/);
    refuse(build([[q(6,1)]],[64,59,55,50,45,40,35,30]),/8 strings/);
    refuse(build(Array.from({length:1001},()=>[q(6,1)])),/1000 measures/);
    refuse(build([[q(6,1)]],undefined,29),/at most/);
  });
  it('refuses when nothing is selected and leaves other exports untouched',()=>{
    const score=build([[q(6,1)]]);
    expect(()=>exportGp5(score,{tracks:[],range:null})).toThrow();
  });
  it('gives each percussion hit its drum key on the percussion channel',()=>{
    const score=build([[q(6,0),q(6,0)]]);
    const staff=score.tracks[0].staves[0];staff.isPercussion=true;
    score.tracks[0].staves[0].bars[0].voices[0].beats.forEach((beat,index)=>{beat.notes[0].percussionArticulation=index?38:36;});
    score.finish(settings);
    const {back}=roundTrip(score);
    expect(back.tracks[0].staves[0].isPercussion).toBe(true);
    expect(back.tracks[0].staves[0].bars[0].voices[0].beats.map(beat=>beat.notes[0].percussionArticulation)).toEqual([36,38]);
    expect(back.tracks[0].playbackInfo.primaryChannel).toBe(9);
  });
});

describe('Guitar Pro 5 accidentals',()=>{
  it('is not troubled by a natural sign on a natural note, but reports a spelling it cannot keep',()=>{
    const score=build([[q(6,3),q(6,5)]]);
    noteOf(score,0,0).accidentalMode=model.NoteAccidentalMode.ForceNatural;noteOf(score,0,1).accidentalMode=model.NoteAccidentalMode.ForceNatural;
    expect(exportGp5(score,everything(score)).losses).toEqual([]);
    const tuned=build([[q(6,2)]]);noteOf(tuned,0,0).accidentalMode=model.NoteAccidentalMode.ForceNatural;
    expect(exportGp5(tuned,everything(tuned)).losses).toEqual(['Accidental spellings other than sharp and flat are left out']);
  });
});

describe('Guitar Pro 5 timing and placement',()=>{
  const four=()=>[q(6,3),q(6,5),q(6,7),q(6,8)];
  it('writes a pickup measure with a signature of its own length, so every later note keeps its absolute tick',()=>{
    const score=build([[q(1,0)],four(),four()]);
    score.masterBars[0].isAnacrusis=true;score.finish(settings);
    expect(score.masterBars[1].start).toBe(960);
    const {back,losses}=roundTrip(score);
    expectSameMusic(score,back);
    expect(back.masterBars.map(bar=>[bar.start,bar.timeSignatureNumerator,bar.timeSignatureDenominator])).toEqual([[0,1,4],[960,4,4],[4800,4,4]]);
    expect(losses).toEqual(['A pickup measure is written as a measure with a time signature of its own length']);
  });
  it('refuses a pickup whose length no signature can say, before anything is saved',()=>{
    const score=build([[q(1,0,{tuplet:[3,2]})],four()]);
    score.masterBars[0].isAnacrusis=true;score.finish(settings);
    expect(previewGp5(score,everything(score))).toEqual({refusal:expect.stringMatching(/pickup/)});
  });
  it('refuses signatures with a numerator above 127 or a denominator that is not a power of two',()=>{
    const wide=build([[q(6,1)]]);wide.masterBars[0].timeSignatureNumerator=200;wide.finish(settings);
    expect(previewGp5(wide,everything(wide))).toEqual({refusal:expect.stringMatching(/time signature/)});
    const odd=build([[q(6,1)]]);odd.masterBars[0].timeSignatureDenominator=3;odd.finish(settings);
    expect(previewGp5(odd,everything(odd))).toEqual({refusal:expect.stringMatching(/time signature/)});
  });
  it('writes a tempo change once, on the first voice, and not again on the second voice of its measure',()=>{
    const eighths=[1,2,3,4,5,6,7,8].map(fret=>({d:D.Eighth,n:[[1,fret]] as [number,number][]}));
    const withTempo=(second?:Spec[][])=>{
      const score=build([four(),four()],undefined,1,second);
      score.masterBars[1].tempoAutomations.push(Object.assign(new model.Automation(),{type:model.AutomationType.Tempo,value:200,ratioPosition:.5}));score.finish(settings);
      return score;
    };
    // The tempo is a 32-bit 200 in the mixer table of its beat; count them in the file.
    const count=(bytes:Uint8Array)=>Array.from(bytes).filter((value,index)=>value===200&&bytes[index+1]===0&&bytes[index+2]===0&&bytes[index+3]===0&&bytes[index-1]!==200).length;
    const plain=withTempo(),twoVoices=withTempo([[{d:D.Whole,n:[[1,0]]}],eighths]);
    const {back,losses,bytes}=roundTrip(twoVoices);
    expect(losses).toEqual([]);
    expect(back.masterBars[1].tempoAutomations.map(change=>[change.value,change.ratioPosition])).toEqual([[200,.5]]);
    expect(count(bytes)).toBe(count(exportGp5(plain,everything(plain)).bytes));
  });
  it('keeps a mixer change on a voice that has no notes, and reports a sound bank change it cannot hold',()=>{
    const score=build([four()],undefined,1,[[]]);
    const empty=score.tracks[0].staves[0].bars[0].voices[1].beats[0];
    empty.automations.push(Object.assign(new model.Automation(),{type:model.AutomationType.Volume,value:9,ratioPosition:0}));
    const {back,losses}=roundTrip(score);
    expect(losses).toEqual([]);
    expect(back.tracks[0].staves[0].bars[0].voices[1].beats[0].automations.map(change=>[change.type,change.value])).toEqual([[model.AutomationType.Volume,9]]);
    noteOf(score).beat.automations.push(Object.assign(new model.Automation(),{type:model.AutomationType.Bank,value:3,ratioPosition:0}));
    expect(exportGp5(score,everything(score)).losses).toEqual(['Sound bank changes are left out']);
  });
});

describe('Guitar Pro 5 dynamics, grace notes, whammy and ties',()=>{
  const DV=model.DynamicValue;
  const nearest:Record<string,number>={PPPP:DV.PPP,PPPPP:DV.PPP,PPPPPP:DV.PPP,N:DV.PPP,FFFF:DV.FFF,FFFFF:DV.FFF,FFFFFF:DV.FFF,SF:DV.FFF,SFZ:DV.FFF,SFFZ:DV.FFF,FZ:DV.FFF,RF:DV.FFF,RFZ:DV.FFF,SFP:DV.FF,SFPP:DV.FF,SFZP:DV.FF,FP:DV.F,PF:DV.MF};
  const names=Object.keys(DV).filter(name=>Number.isNaN(Number(name)));
  it('maps every dynamic value to the nearest of ppp to fff and says so for the ones it changes',()=>{
    const basic=['PPP','PP','P','MP','MF','F','FF','FFF'];
    expect(names.filter(name=>!basic.includes(name)).sort()).toEqual(Object.keys(nearest).sort());
    for(const name of names){
      const value=DV[name as keyof typeof DV];
      const score=build([[q(6,1)]]);beatOf(score,0,0).dynamics=value;
      const {back,losses}=roundTrip(score);
      expect(beatOf(back,0,0).dynamics,name).toBe(basic.includes(name)?value:nearest[name]);
      expect(losses,name).toEqual(basic.includes(name)?[]:['Dynamics outside ppp to fff are changed to the nearest']);
    }
  });
  it('keeps a grace chord, one grace note on each string the main chord plays',()=>{
    const score=build([[{n:[[6,5],[5,7]],grace:{fret:3,string:6}},q(6,7),q(6,8),q(6,10)]]);
    const grace=beatOf(score,0,0).voice.beats.find(beat=>beat.graceType!==model.GraceType.None)!;
    const second=new model.Note();second.string=5;second.fret=4;grace.addNote(second);
    const {back,losses}=roundTrip(score);
    expect(losses).toEqual([]);
    const written=back.tracks[0].staves[0].bars[0].voices[0].beats.filter(beat=>beat.graceType!==model.GraceType.None).flatMap(beat=>beat.notes.map(note=>[note.string,note.fret]));
    expect(written.sort()).toEqual([[5,4],[6,3]]);
  });
  it('reports a bend grace note instead of dropping it',()=>{
    const score=build([[q(6,5),q(6,7),q(6,8),q(6,10)]]);
    const voice=score.tracks[0].staves[0].bars[0].voices[0],grace=new model.Beat(),note=new model.Note();
    grace.isEmpty=false;grace.graceType=model.GraceType.BendGrace;grace.duration=D.ThirtySecond;note.string=6;note.fret=5;note.bendType=model.BendType.Bend;note.addBendPoint(new model.BendPoint(0,0));note.addBendPoint(new model.BendPoint(60,4));grace.addNote(note);voice.addGraceBeat(grace);
    expect(exportGp5(score,everything(score)).losses).toEqual(['Bend grace notes are left out']);
  });
  it('writes a whammy bar with the dip or dive type byte of the format',()=>{
    const typeByte=(type:model.WhammyType)=>{
      const score=build([[q(6,5),q(6,7)]]),beat=beatOf(score,0,0);
      beat.whammyBarType=type;beat.whammyBarPoints=[new model.BendPoint(0,0),new model.BendPoint(30,-4),new model.BendPoint(60,0)];
      const bytes=exportGp5(score,everything(score)).bytes;
      // The type byte sits right before the int holding the highest point (4 steps, 100 in the file) and the count of 3 points.
      for(let i=1;i<bytes.length-8;i++)if(bytes[i+1]===100&&bytes[i+2]===0&&bytes[i+3]===0&&bytes[i+4]===0&&bytes[i+5]===3&&bytes[i+6]===0&&bytes[i+7]===0&&bytes[i+8]===0)return bytes[i];
      return -1;
    };
    expect(typeByte(model.WhammyType.Dip)).toBe(6);
    expect(typeByte(model.WhammyType.Dive)).toBe(7);
  });
  it('rewrites a tie into a repeated measure as a new note unless the measure before ends on that note',()=>{
    const score=build([[q(5,5),q(5,7),q(5,5),q(5,7)],[q(5,7),q(5,5),q(5,7),q(5,5)],[q(6,0),q(6,0),q(6,0),q(6,0)]]);
    noteOf(score,1,0).isTieDestination=true;noteOf(score,1,0).tieOrigin=noteOf(score,0,3);noteOf(score,0,3).tieDestination=noteOf(score,1,0);
    score.tracks[0].staves[0].bars[2].simileMark=model.SimileMark.Simple;score.finish(settings);
    const {back,losses}=roundTrip(score);
    expect(losses).toEqual(['Notes tied into a repeated measure are written as new notes']);
    expect(noteOf(back,2,0).isTieDestination).toBe(false);
    expect(noteOf(back,2,0).fret).toBe(7);
    expect(noteOf(back,1,0).isTieDestination).toBe(true);
  });
});

/**
 * Everything the model keeps that a Guitar Pro 5 file does not, one scenario each. The export dialog says "nothing is left out"
 * when the list is empty, so every kind of loss must put a line in the list, and a field alphaTab adds must be classified here.
 */
describe('Guitar Pro 5 never claims nothing is left out when something is',()=>{
  type Change=(score:model.Score)=>void;
  const bars=()=>[[q(6,3),q(6,5),q(6,7),q(6,8)],[q(6,3),q(6,5),q(6,7),q(6,8)]];
  const first=(score:model.Score,bar=0,index=0)=>beatOf(score,bar,index);
  const bend=(note:model.Note)=>{note.bendType=model.BendType.Bend;note.addBendPoint(new model.BendPoint(0,0));note.addBendPoint(new model.BendPoint(60,4));};
  const scenarios:Record<string,[Change,RegExp,{backing?:boolean;bars?:Spec[][]}?]>={
    'Beat.fermata':[score=>score.masterBars[0].addFermata(0,Object.assign(new model.Fermata(),{type:model.FermataType.Medium,length:1})),/Fermatas/],
    'Beat.slashed':[score=>{first(score).slashed=true;},/Slashed/],
    'Beat.deadSlapped':[score=>{first(score).deadSlapped=true;},/dead-slap/],
    'Beat.golpe':[score=>{first(score).golpe=model.GolpeType.Thumb;},/Golpe/],
    'Beat.crescendo':[score=>{first(score).crescendo=model.CrescendoType.Crescendo;},/Crescendo/],
    'Beat.wahPedal':[score=>{first(score).wahPedal=model.WahPedal.Open;},/Wah/],
    'Beat.showTimer':[score=>{first(score).showTimer=true;first(score).timer=12;},/Timers/],
    'Beat.barreShape':[score=>{first(score).barreShape=model.BarreShape.Full;first(score).barreFret=3;},/Barre marks/],
    'Beat.whammyStyle':[score=>{first(score).whammyBarPoints=[new model.BendPoint(0,0),new model.BendPoint(60,-4)];first(score).whammyStyle=model.BendStyle.Gradual;},/Whammy bar styles/],
    'Beat.tremoloPicking':[score=>{first(score).tremoloPicking=Object.assign(new model.TremoloPickingEffect(),{marks:5});},/Tremolo picking with more than three/],
    'Note.isVisible':[score=>{noteOf(score).isVisible=false;},/Hidden notes/],
    'Note.bendStyle':[score=>{const note=noteOf(score);bend(note);note.bendStyle=model.BendStyle.Gradual;},/Bend styles/],
    'Note.isLeftHandTapped':[score=>{noteOf(score).isLeftHandTapped=true;},/Left-hand tap/],
    'Note.ornament':[score=>{noteOf(score).ornament=model.NoteOrnament.Turn;},/Turns and mordents/],
    'Note.accentuated':[score=>{noteOf(score).accentuated=model.AccentuationType.Tenuto;},/Tenuto/],
    'Note.accidentalMode':[score=>{noteOf(score,0,1).accidentalMode=model.NoteAccidentalMode.ForceDoubleSharp;},/Accidental spellings/],
    'Note.slurDestination':[score=>{const [from,to]=[noteOf(score,0,0),noteOf(score,0,1)];from.slurDestination=to;to.slurOrigin=from;},/Slurs/],
    'Bar.clefOttava':[score=>{score.tracks[0].staves[0].bars[0].clefOttava=model.Ottavia._8va;},/Clef octave/],
    'Bar.barLineRight':[score=>{score.tracks[0].staves[0].bars[0].barLineRight=model.BarLineStyle.Dotted;},/Barline styles/],
    'Bar.barLineLeft':[score=>{score.tracks[0].staves[0].bars[1].barLineLeft=model.BarLineStyle.Heavy;},/Barline styles/],
    'Bar.sustainPedals':[score=>{score.tracks[0].staves[0].bars[0].sustainPedals.push(new model.SustainPedalMarker());},/Sustain pedal/],
    'MasterBar.alternateEndings':[score=>{score.masterBars[1].alternateEndings=256;},/Endings above the eighth/],
    'MasterBar.repeatCount':[score=>{score.masterBars[1].repeatCount=200;},/Repeat counts above 127/],
    'MasterBar.timeSignatureCommon':[score=>{score.masterBars[0].timeSignatureCommon=true;},/Common-time/],
    'MasterBar.isFreeTime':[score=>{score.masterBars[0].isFreeTime=true;},/Free-time/],
    'MasterBar.tripletFeel':[score=>{score.masterBars[0].tripletFeel=model.TripletFeel.Dotted16th;},/Swing feels/],
    'MasterBar.section':[score=>{score.masterBars[0].section=Object.assign(new model.Section(),{marker:'A',text:'Intro'});},/letter of a section marker/],
    'MasterBar.syncPoints':[()=>{},/Backing audio/,{backing:true}],
    'MasterBar.isAnacrusis':[score=>{score.masterBars[0].isAnacrusis=true;},/pickup measure is written/,{bars:[[q(6,3)],bars()[0]]}],
    'Staff.showSlash':[score=>{score.tracks[0].staves[0].showSlash=true;},/Slash and numbered/],
    'Staff.showNumbered':[score=>{score.tracks[0].staves[0].showNumbered=true;},/Slash and numbered/],
    'Staff.displayTranspositionPitch':[score=>{score.tracks[0].staves[0].displayTranspositionPitch=12;},/Display transposition/],
    'Track.staves':[score=>{const staff=new model.Staff();staff.stringTuning.tunings=[64,59,55,50,45,40];score.tracks[0].addStaff(staff);for(let i=0;i<2;i++){const bar=new model.Bar();bar.clef=model.Clef.G2;fill(bar,[q(6,1)]);staff.addBar(bar);}},/Staves after the first/],
    'Score.backingTrack':[()=>{},/Backing audio/,{backing:true}],
    'Voice.hidden lyrics':[score=>setLyricsSource(score.tracks[0],{visible:false,lines:[{startBar:0,text:'La la'}]},true),/Hidden lyrics/],
    'Automation.isLinear':[score=>{score.masterBars[1].tempoAutomations.push(Object.assign(new model.Automation(),{type:model.AutomationType.Tempo,value:150,ratioPosition:.5,isLinear:true}));},/Gradual tempo/],
    'TremoloPickingEffect.style':[score=>{first(score).tremoloPicking=Object.assign(new model.TremoloPickingEffect(),{marks:2,style:model.TremoloPickingStyle.BuzzRoll});},/Buzz-roll/],
    'Chord.showName':[score=>{
      const chord=Object.assign(new model.Chord(),{name:'Am',firstFret:1,strings:[0,1,2,2,0,-1],barreFrets:[],showName:false});
      chord.staff=score.tracks[0].staves[0];score.tracks[0].staves[0].addChord('c1',chord);first(score).chordId='c1';
    },/hidden name, diagram or fingering/],
    'Beat.graceType.BendGrace':[score=>{
      const voice=score.tracks[0].staves[0].bars[0].voices[0],grace=new model.Beat(),note=new model.Note();
      grace.isEmpty=false;grace.graceType=model.GraceType.BendGrace;grace.duration=D.ThirtySecond;note.string=6;note.fret=3;bend(note);grace.addNote(note);voice.addGraceBeat(grace);
    },/Bend grace/],
  };
  it.each(Object.entries(scenarios))('lists %s as left out or changed',(_name,[change,pattern,options])=>{
    const score=build(options?.bars??bars());change(score);score.finish(settings);
    const result=previewGp5(score,everything(score),options&&{backing:options.backing});
    expect(result).toHaveProperty('losses');
    expect((result as {losses:string[]}).losses.join('|')).toMatch(pattern);
  });
  it('lists a jump whose target the selection cut off',()=>{
    const score=build([[q(6,1)],[q(6,2)],[q(6,3)]]);
    score.masterBars[0].addDirection(model.Direction.TargetSegno);score.masterBars[2].addDirection(model.Direction.JumpDalSegno);
    expect(exportGp5(score,everything(score)).losses).toEqual([]);
    expect(exportGp5(score,{tracks:[0],range:{first:1,last:2}}).losses).toEqual(['A jump whose target is not in the selection is kept, but has nowhere to go']);
  });
  it('has a plain score report nothing, so the claim of nothing left out is true only then',()=>{
    const score=build(bars());
    expect(previewGp5(score,everything(score))).toEqual({losses:[]});
  });
  it('classifies every field of the model, so a field a later alphaTab adds is noticed',()=>{
    const written='written to the file',derived='worked out from other fields',styling='page layout or styling, which the file does not hold and the dialog always says so',lost='listed in the scenarios above';
    const classes:Record<string,[object,Record<string,string>]>={
      Beat:[new model.Beat(),{...Object.fromEntries('notes isEmpty ottava duration dots fade lyrics pop slap tap text brushType brushDuration tupletDenominator tupletNumerator whammyBarType whammyBarPoints vibrato chordId graceType pickStroke tremoloPicking dynamics preferredBeamDirection beamingMode rasgueado automations'.split(' ').map(key=>[key,written])),
        ...Object.fromEntries('id index previousBeat nextBeat voice noteStringLookup noteValueLookup isLegatoOrigin minNote maxNote maxStringNote minStringNote isLetRing isPalmMute tupletGroup isContinuedWhammy maxWhammyPoint minWhammyPoint graceGroup graceIndex displayStart playbackStart displayDuration playbackDuration overrideDisplayDuration isEffectSlurOrigin effectSlurOrigin effectSlurDestination'.split(' ').map(key=>[key,derived])),
        ...Object.fromEntries('invertBeamDirection style'.split(' ').map(key=>[key,styling])),
        ...Object.fromEntries('whammyStyle fermata slashed deadSlapped golpe crescendo wahPedal barreFret barreShape showTimer timer'.split(' ').map(key=>[key,lost]))}],
      Note:[new model.Note(),{...Object.fromEntries('bendType bendPoints fret string percussionArticulation isHammerPullOrigin harmonicType harmonicValue isGhost isLetRing isPalmMute isDead isStaccato slideInType slideOutType slideTarget vibrato tieOrigin tieDestination isTieDestination leftHandFinger rightHandFinger trillValue trillSpeed durationPercent dynamics'.split(' ').map(key=>[key,written])),
        ...Object.fromEntries('id index maxBendPoint bendOrigin isContinuedBend octave tone hammerPullOrigin hammerPullDestination slideOrigin letRingDestination palmMuteDestination beat isEffectSlurOrigin hasEffectSlur effectSlurOrigin effectSlurDestination effectSlur _noteIdBag'.split(' ').map(key=>[key,derived])),
        ...Object.fromEntries('showStringNumber style'.split(' ').map(key=>[key,styling])),
        ...Object.fromEntries('accentuated bendStyle isVisible isLeftHandTapped isSlurDestination slurOrigin slurDestination accidentalMode ornament'.split(' ').map(key=>[key,lost]))}],
      Bar:[new model.Bar(),{...Object.fromEntries('clef voices simileMark keySignature keySignatureType'.split(' ').map(key=>[key,written])),
        ...Object.fromEntries('id index nextBar previousBar staff _filledVoices _isEmpty _isRestOnly shortestDuration'.split(' ').map(key=>[key,derived])),
        ...Object.fromEntries('displayScale displayWidth barNumberDisplay style'.split(' ').map(key=>[key,styling])),
        ...Object.fromEntries('clefOttava sustainPedals barLineLeft barLineRight'.split(' ').map(key=>[key,lost]))}],
      MasterBar:[new model.MasterBar(),{...Object.fromEntries('isDoubleBar isRepeatStart timeSignatureNumerator timeSignatureDenominator section tempoAutomations directions'.split(' ').map(key=>[key,written])),
        ...Object.fromEntries('nextMasterBar previousMasterBar index repeatGroup score start'.split(' ').map(key=>[key,derived])),
        ...Object.fromEntries('beamingRules actualBeamingRules displayScale displayWidth'.split(' ').map(key=>[key,styling])),
        ...Object.fromEntries('alternateEndings repeatCount timeSignatureCommon isFreeTime tripletFeel syncPoints fermata isAnacrusis'.split(' ').map(key=>[key,lost]))}],
      Staff:[new model.Staff(),{...Object.fromEntries('chords capo transpositionPitch stringTuning showTablature showStandardNotation isPercussion'.split(' ').map(key=>[key,written])),
        ...Object.fromEntries('index track bars _filledVoices'.split(' ').map(key=>[key,derived])),
        ...Object.fromEntries('standardNotationLineCount'.split(' ').map(key=>[key,styling])),
        ...Object.fromEntries('displayTranspositionPitch showSlash showNumbered'.split(' ').map(key=>[key,lost]))}],
      Track:[new model.Track(),{...Object.fromEntries('playbackInfo color name isVisibleOnMultiTrack percussionArticulations'.split(' ').map(key=>[key,written])),
        ...Object.fromEntries('index score'.split(' ').map(key=>[key,derived])),
        ...Object.fromEntries('shortName defaultSystemsLayout systemsLayout lineBreaks style'.split(' ').map(key=>[key,styling])),
        ...Object.fromEntries('staves'.split(' ').map(key=>[key,lost]))}],
      Automation:[new model.Automation(),{...Object.fromEntries('type value ratioPosition text'.split(' ').map(key=>[key,written])),
        ...Object.fromEntries('isVisible'.split(' ').map(key=>[key,styling])),
        ...Object.fromEntries('isLinear syncPointValue'.split(' ').map(key=>[key,lost]))}],
      TremoloPickingEffect:[new model.TremoloPickingEffect(),{marks:written,style:lost}],
      Chord:[new model.Chord(),{...Object.fromEntries('name firstFret strings barreFrets'.split(' ').map(key=>[key,written])),staff:derived,...Object.fromEntries('showName showDiagram showFingering'.split(' ').map(key=>[key,lost]))}],
      Score:[new model.Score(),{...Object.fromEntries('album artist copyright instructions music notices subTitle title words tab masterBars tracks'.split(' ').map(key=>[key,written])),
        ...Object.fromEntries('_currentRepeatGroup _openedRepeatGroups _properlyOpenedRepeatGroups'.split(' ').map(key=>[key,derived])),
        ...Object.fromEntries('defaultSystemsLayout systemsLayout stylesheet style'.split(' ').map(key=>[key,styling])),
        ...Object.fromEntries('backingTrack'.split(' ').map(key=>[key,lost]))}],
    };
    for(const [name,[instance,known]] of Object.entries(classes)){
      const unknown=Object.keys(instance).filter(key=>!(key in known));
      expect(unknown,`${name} fields not yet classified for Guitar Pro 5 export`).toEqual([]);
      const alias:Record<string,string>={'Chord.showDiagram':'Chord.showName','Chord.showFingering':'Chord.showName','Automation.syncPointValue':'MasterBar.syncPoints','Beat.barreFret':'Beat.barreShape','Beat.timer':'Beat.showTimer','Note.isSlurDestination':'Note.slurDestination','Note.slurOrigin':'Note.slurDestination','MasterBar.fermata':'Beat.fermata'};
      const untested=Object.entries(known).filter(([,kind])=>kind===lost).map(([key])=>`${name}.${key}`).filter(field=>!(field in scenarios)&&!(alias[field] in scenarios));
      expect(untested,`${name} fields that are lost and have no scenario`).toEqual([]);
    }
  });
});

describe('Guitar Pro 5 channels and neck',()=>{
  it('gives every track its own channel and effect channel, and percussion an effect channel no pitched track uses',()=>{
    const score=build([[q(6,3)]],undefined,3);
    const drums=score.tracks[2];drums.staves[0].isPercussion=true;drums.staves[0].stringTuning.tunings=[];noteOf(score,0,0,0,2).percussionArticulation=36;
    score.tracks[0].playbackInfo.volume=9;
    const {back,bytes}=roundTrip(score);
    const channels=back.tracks.slice(0,2).flatMap(track=>[track.playbackInfo.primaryChannel,track.playbackInfo.secondaryChannel]);
    expect(new Set(channels).size).toBe(channels.length);
    // The percussion track is channel 10 (index 9) with channel 9 for its effects; the pitched tracks never take channel 9 or 10.
    const has=(pattern:number[])=>Array.from(bytes).some((_,index)=>pattern.every((value,offset)=>bytes[index+offset]===value));
    expect(has([1,0,0,0,10,0,0,0,9,0,0,0])).toBe(true);
    expect(has([1,0,0,0,9,0,0,0])).toBe(false);
  });
  it('raises the fret count of a track above the usual 24 when its music goes higher',()=>{
    const score=build([[q(1,30),q(1,3)]]);
    const bytes=exportGp5(score,everything(score)).bytes;
    // port 1, channel 1, effect channel 2, then the fret count.
    const fretCount=(want:number)=>{
      const pattern=[1,0,0,0,1,0,0,0,2,0,0,0,want,0,0,0];
      return Array.from(bytes).some((_,index)=>pattern.every((value,offset)=>bytes[index+offset]===value));
    };
    expect(fretCount(30)).toBe(true);
    const plain=build([[q(1,3)]]),plainBytes=exportGp5(plain,everything(plain)).bytes;
    expect(Array.from(plainBytes).some((_,index)=>[1,0,0,0,1,0,0,0,2,0,0,0,24,0,0,0].every((value,offset)=>plainBytes[index+offset]===value))).toBe(true);
    expectSameMusic(score,readBack(bytes));
  });
});

describe('Guitar Pro 5 pickups measured on the whole score',()=>{
  /** One list of measures per track (a measure with no specs is an empty one), with the first measure marked as a pickup. */
  function pickupScore(perTrack:Spec[][][],pickup=true):model.Score {
    const score=new model.Score();
    perTrack.forEach((measures,t)=>{
      const track=new model.Track(),staff=new model.Staff();track.name=`Guitar ${t+1}`;track.playbackInfo.program=25;staff.stringTuning.tunings=[64,59,55,50,45,40];staff.displayTranspositionPitch=-12;track.addStaff(staff);score.addTrack(track);
      measures.forEach((specs,index)=>{
        if(t===0)score.addMasterBar(new model.MasterBar());
        const bar=new model.Bar();bar.clef=model.Clef.G2;staff.addBar(bar);fill(bar,specs);
      });
    });
    score.masterBars[0].isAnacrusis=pickup;score.finish(settings);return score;
  }
  const four=[q(6,3),q(6,5),q(6,7),q(6,8)];
  const absolute=(score:model.Score,track:number)=>score.tracks[track].staves[0].bars.flatMap(bar=>bar.voices[0].beats.filter(beat=>beat.notes.length).map(beat=>[bar.masterBar.start+beat.playbackStart,beat.notes[0].realValue]));
  it('keeps the bar starts of the whole score when only a track with an empty pickup bar is exported',()=>{
    const score=pickupScore([[[q(1,0)],four,four],[[],four,four]]);
    expect(score.masterBars.map(bar=>bar.start)).toEqual([0,960,4800]);
    const result=exportGp5(score,{tracks:[1],range:null}),back=readBack(result.bytes);
    expect(back.masterBars.map(bar=>bar.start)).toEqual([0,960,4800]);
    expect(absolute(back,0)).toEqual(absolute(score,1));
    expect(result.losses).toEqual(['A pickup measure is written as a measure with a time signature of its own length']);
  });
  it('uses the longest bar of any track, exported or not',()=>{
    const score=pickupScore([[[q(1,0),q(1,2)],four,four],[[q(1,0)],four,four]]);
    expect(score.masterBars.map(bar=>bar.start)).toEqual([0,1920,5760]);
    const back=readBack(exportGp5(score,{tracks:[1],range:null}).bytes);
    expect(back.masterBars.map(bar=>bar.start)).toEqual([0,1920,5760]);
    expect(back.masterBars[0].timeSignatureNumerator).toBe(2);
    expect(absolute(back,0)).toEqual(absolute(score,1));
  });
  it('keeps the bar starts when the exported measures begin after the pickup, and when they begin with it',()=>{
    const score=pickupScore([[[q(1,0)],four,four],[[],four,four]]);
    const later=readBack(exportGp5(score,{tracks:[1],range:{first:1,last:2}}).bytes);
    expect(later.masterBars.map(bar=>bar.start)).toEqual([0,3840]);
    const from=readBack(exportGp5(score,{tracks:[1],range:{first:0,last:1}}).bytes);
    expect(from.masterBars.map(bar=>bar.start)).toEqual([0,960]);
  });
  it('refuses a pickup that has no music in any track',()=>{
    const score=new model.Score();
    for(let t=0;t<2;t++){const track=new model.Track(),staff=new model.Staff();staff.stringTuning.tunings=[64,59,55,50,45,40];track.addStaff(staff);score.addTrack(track);}
    for(const measure of [0,1]){score.addMasterBar(new model.MasterBar());for(const track of score.tracks){const bar=new model.Bar();bar.clef=model.Clef.G2;track.staves[0].addBar(bar);if(measure===1)fill(bar,four);}}
    score.masterBars[0].isAnacrusis=true;score.finish(settings);
    expect(score.masterBars[0].calculateDuration(true)).toBe(0);
    expect(previewGp5(score,{tracks:[0],range:null})).toEqual({refusal:expect.stringMatching(/pickup that is empty/)});
  });
});

describe('Guitar Pro 5 second review fixes',()=>{
  const has=(bytes:Uint8Array,pattern:number[])=>Array.from(bytes).some((_,index)=>pattern.every((value,offset)=>bytes[index+offset]===value));
  const automation=(type:model.AutomationType,value:number,more:Partial<model.Automation>={})=>Object.assign(new model.Automation(),{type,value,ratioPosition:0,...more});
  it('reports a sound bank change on a voice with no notes',()=>{
    const score=build([[q(6,3),q(6,5)]],undefined,1,[[]]);
    score.tracks[0].staves[0].bars[0].voices[1].beats[0].automations.push(automation(model.AutomationType.Bank,3));
    expect(exportGp5(score,everything(score)).losses).toEqual(['Sound bank changes are left out']);
  });
  it('lists the mixer changes of a measure repeated with a simile mark, which the file cannot keep',()=>{
    const score=build([[q(6,3),q(6,5),q(6,7),q(6,8)],[{d:D.Whole,n:[]}]]);
    score.tracks[0].staves[0].bars[1].simileMark=model.SimileMark.Simple;
    score.tracks[0].staves[0].bars[1].voices[0].beats[0].automations.push(automation(model.AutomationType.Volume,9));
    score.finish(settings);
    expect(exportGp5(score,everything(score)).losses).toEqual(['Mixer changes on a measure repeated with a simile mark are left out']);
  });
  it('writes a percussion grace note as its drum key, not a fret',()=>{
    const score=build([[q(6,0,{grace:{fret:0}}),q(6,0),q(6,0),q(6,0)]]);
    score.tracks[0].staves[0].isPercussion=true;score.tracks[0].staves[0].stringTuning.tunings=[];
    const beats=beatOf(score,0,0).voice.beats,grace=beats.find(beat=>beat.graceType!==model.GraceType.None)!;
    grace.notes[0].fret=-1;grace.notes[0].percussionArticulation=38;for(const beat of beats)if(beat!==grace)beat.notes[0].percussionArticulation=36;
    const bytes=exportGp5(score,everything(score)).bytes;
    // key, dynamic (forte), transition, length, flags
    expect(has(bytes,[38,6,0,3,0])).toBe(true);
    expect(has(bytes,[0,6,0,3,0])).toBe(false);
  });
  it('writes the length of a grace note from its group: one is the usual grace note, a run of two is shorter',()=>{
    const bytesFor=(graces:number)=>{
      const score=build([[q(6,5,{d:D.Whole,grace:{fret:3}})]]);
      const voice=beatOf(score,0,0).voice;
      for(let i=1;i<graces;i++){const grace=new model.Beat(),note=new model.Note();grace.isEmpty=false;grace.graceType=model.GraceType.BeforeBeat;note.string=6;note.fret=4;grace.addNote(note);voice.addGraceBeat(grace);}
      score.finish(settings);
      return exportGp5(score,everything(score)).bytes;
    };
    expect(has(bytesFor(1),[3,6,0,3,0])).toBe(true);
    expect(has(bytesFor(2),[4,6,0,1,0])).toBe(true);
    expect(has(bytesFor(2),[4,6,0,3,0])).toBe(false);
  });
  it('writes the text of a tempo change into the name field of its mixer table',()=>{
    const score=build([[q(6,3),q(6,5),q(6,7),q(6,8)],[q(6,3),q(6,5),q(6,7),q(6,8)]]);
    score.masterBars[1].tempoAutomations.push(automation(model.AutomationType.Tempo,150,{ratioPosition:.5,text:'Allegro'}));score.finish(settings);
    const bytes=exportGp5(score,everything(score)).bytes;
    // length+1 as an int, the length, then the characters.
    expect(has(bytes,[8,0,0,0,7,...Array.from('Allegro').map(char=>char.charCodeAt(0))])).toBe(true);
  });
  it('normalises text to composed letters and writes the sharp and flat signs as # and b',()=>{
    const score=build([[q(6,3)]]);score.title='Cafe\u0301 F\u266F B\u266D';
    const {back,losses}=roundTrip(score);
    expect(back.title).toBe('Café F# Bb');
    expect(losses).toEqual([]);
  });
});
