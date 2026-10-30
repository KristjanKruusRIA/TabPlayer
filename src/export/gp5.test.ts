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
  reader.init(io.ByteBuffer.fromBuffer(bytes),new Settings());
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
    rest:beat.isRest,duration:beat.duration,dots:beat.dots,tuplet:beat.hasTuplet?`${beat.tupletNumerator}:${beat.tupletDenominator}`:'',start:beat.playbackStart,length:beat.playbackDuration,
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
  const slice=(value:ReturnType<typeof rhythm>)=>tracks.map(track=>value[track].slice(first,last+1));
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
    track.name=tracks>1?`Guitar ${t+1}`:'Guitar';track.playbackInfo.program=25+t;staff.stringTuning.tunings=tuning;track.addStaff(staff);score.addTrack(track);
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
  it('writes text as UTF-8 and cuts fields the format limits at a character boundary, saying so',()=>{
    const score=build([[{n:[[6,3]]}]]);score.title='Étude – 練習';score.tracks[0].name='Ü'.repeat(30);
    const {back,losses}=roundTrip(score);
    expect(back.title).toBe('Étude – 練習');
    expect(back.tracks[0].name).toBe('Ü'.repeat(20));
    expect(losses).toEqual(['Text longer than Guitar Pro 5 allows is shortened']);
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
