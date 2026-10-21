// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { describe,expect,it } from 'vitest';
import { midi,model,Settings } from '@coderline/alphatab';
import { strFromU8,strToU8 } from 'fflate';
import { loadInterchangeScore } from '../interchange/gp';
import { setLyricsSource } from '../editor/lyrics-source';
import { applyLyricsEdit,getTrackLyrics } from '../editor/lyrics';
import { exportMusicXml } from './musicxml';
import { buildPlaybackPlan } from '../audio/plan';

const settings=new Settings();
type NoteSpec={string?:number;fret?:number;octave?:number;tone?:number;tieDestination?:boolean};
type BeatSpec={duration:model.Duration;dots?:number;tuplet?:[number,number];notes?:NoteSpec[];empty?:boolean;grace?:model.GraceType};

// Scores are authored through the model API, independent of any importer.
function build(options:{copies?:number;strings?:number[];transpose?:number;bars:{numerator:number;denominator:number;key?:number;minor?:boolean;tempo?:[number,number][];voices:BeatSpec[][]}[]}){
  const score=new model.Score();score.title='Export & <study>';score.artist='Ann "Doe"';
  for(let copy=0;copy<(options.copies??1);copy++){
  const track=new model.Track();track.name='Guitar & Co';score.addTrack(track);track.ensureStaveCount(1);
  Object.assign(track.playbackInfo,{program:25,primaryChannel:copy*2,secondaryChannel:copy*2+1,volume:12,balance:4});
  const staff=track.staves[0];
  if(options.strings){staff.stringTuning.tunings=options.strings;staff.showTablature=true;staff.showStandardNotation=false;}
  staff.displayTranspositionPitch=options.transpose??0;
  for(const spec of options.bars){
    if(copy===0){
      const master=new model.MasterBar();master.timeSignatureNumerator=spec.numerator;master.timeSignatureDenominator=spec.denominator;score.addMasterBar(master);
      for(const [value,ratioPosition] of spec.tempo??[])master.tempoAutomations.push(Object.assign(new model.Automation(),{type:model.AutomationType.Tempo,value,ratioPosition}));
    }
    const bar=new model.Bar();staff.addBar(bar);bar.clef=model.Clef.G2;bar.clefOttava=model.Ottavia.Regular;
    bar.keySignature=(spec.key??0) as model.KeySignature;bar.keySignatureType=spec.minor?model.KeySignatureType.Minor:model.KeySignatureType.Major;
    for(const beats of spec.voices){
      const voice=new model.Voice();bar.addVoice(voice);
      for(const beatSpec of beats){
        const beat=new model.Beat();beat.duration=beatSpec.duration;beat.dots=beatSpec.dots??0;beat.isEmpty=!!beatSpec.empty;beat.graceType=beatSpec.grace??model.GraceType.None;
        if(beatSpec.tuplet){beat.tupletNumerator=beatSpec.tuplet[0];beat.tupletDenominator=beatSpec.tuplet[1];}
        voice.addBeat(beat);
        for(const noteSpec of beatSpec.notes??[]){
          const note=new model.Note();
          if(noteSpec.string!==undefined){note.string=noteSpec.string;note.fret=noteSpec.fret!;}else{note.octave=noteSpec.octave!;note.tone=noteSpec.tone!;}
          note.isTieDestination=!!noteSpec.tieDestination;beat.addNote(note);
        }
      }
    }
  }
  }
  score.finish(settings);return score;
}
const quarter=model.Duration.Quarter,eighth=model.Duration.Eighth,sixteenth=model.Duration.Sixteenth,half=model.Duration.Half;
// Standard guitar, sounding E2…E4 (alphaTab lists the highest string first); written an octave up.
const guitar=()=>build({strings:[64,59,55,50,45,40],transpose:-12,bars:[
  {numerator:4,denominator:4,tempo:[[120,0]],voices:[[
    {duration:quarter,notes:[{string:1,fret:0}]},
    {duration:eighth,dots:1,notes:[{string:2,fret:0}]},
    {duration:sixteenth,notes:[{string:2,fret:2}]},
    {duration:half,notes:[{string:1,fret:0},{string:2,fret:2},{string:3,fret:2}]},
  ]]},
  {numerator:3,denominator:4,key:2,tempo:[[90,1/3]],voices:[[
    {duration:quarter,notes:[{string:1,fret:0,tieDestination:true},{string:2,fret:2,tieDestination:true},{string:3,fret:2,tieDestination:true}]},
    {duration:eighth,tuplet:[3,2],notes:[{string:4,fret:0}]},
    {duration:eighth,tuplet:[3,2],notes:[{string:4,fret:0}]},
    {duration:eighth,tuplet:[3,2],notes:[{string:4,fret:0}]},
    {duration:quarter},
  ]]},
]});
const selectAll=(score:model.Score)=>({tracks:score.tracks.map((_,index)=>index),range:null});
const parse=(bytes:Uint8Array)=>{const doc=new DOMParser().parseFromString(strFromU8(bytes),'application/xml');expect(doc.querySelector('parsererror')).toBeNull();return doc;};
const texts=(doc:Document,selector:string)=>[...doc.querySelectorAll(selector)].map(node=>node.textContent);
// The musical content alphaTab reads back, for comparison with the source model.
function content(score:model.Score){
  return score.tracks.map(track=>track.staves.map(staff=>staff.bars.map(bar=>({
    time:[bar.masterBar.timeSignatureNumerator,bar.masterBar.timeSignatureDenominator],key:[bar.keySignature,bar.keySignatureType],
    tempo:bar.masterBar.tempoAutomations.map(change=>[change.value,Number(change.ratioPosition.toFixed(6))]),
    voices:bar.voices.filter(voice=>!voice.isEmpty).map(voice=>voice.beats.map(beat=>({
      duration:beat.duration,dots:beat.dots,tuplet:beat.hasTuplet?[beat.tupletNumerator,beat.tupletDenominator]:null,
      notes:beat.notes.map(note=>[note.realValue,note.isStringed?note.string:null,note.isStringed?note.fret:null,note.isTieDestination,note.isTieOrigin]).sort((a,b)=>Number(a[0])-Number(b[0])),
    }))),
  }))));
}

describe('MusicXML export',()=>{
  it('writes literal core notation for a TAB guitar part',()=>{
    const score=guitar(),before=JSON.stringify(model.JsonConverter.scoreToJson(score));
    const doc=parse(exportMusicXml(score,selectAll(score)));
    expect(JSON.stringify(model.JsonConverter.scoreToJson(score))).toBe(before);
    expect(doc.doctype?.publicId).toBe('-//Recordare//DTD MusicXML 4.0 Partwise//EN');
    expect(doc.documentElement.getAttribute('version')).toBe('4.0');
    expect(texts(doc,'work > work-title')).toEqual(['Export & <study>']);
    expect(texts(doc,'identification > creator[type="composer"]')).toEqual(['Ann "Doe"']);
    expect(texts(doc,'score-part > part-name')).toEqual(['Guitar & Co']);
    expect(['midi-channel','midi-program','volume','pan'].map(name=>doc.querySelector(`score-part > midi-instrument > ${name}`)?.textContent)).toEqual(['1','26','75','-45']);
    expect(texts(doc,'measure > attributes > divisions')).toEqual(['960']);
    expect(texts(doc,'note > duration')).toEqual(['960','720','240','1920','1920','1920','960','960','960','320','320','320','960']);
    expect(texts(doc,'note > type')).toEqual(['quarter','eighth','16th','half','half','half','quarter','quarter','quarter','eighth','eighth','eighth','quarter']);
    expect(doc.querySelectorAll('note > dot').length).toBe(1);
    expect([...doc.querySelectorAll('note > time-modification')].map(node=>[node.querySelector('actual-notes')?.textContent,node.querySelector('normal-notes')?.textContent])).toEqual([['3','2'],['3','2'],['3','2']]);
    expect(doc.querySelectorAll('note > chord').length).toBe(4);
    expect(doc.querySelectorAll('note > rest').length).toBe(1);
    // Written pitch is an octave above sounding: E3 for the open low E (MIDI 40).
    expect([...doc.querySelectorAll('note > pitch')].slice(0,3).map(node=>`${node.querySelector('step')?.textContent}${node.querySelector('alter')?.textContent??''}${node.querySelector('octave')?.textContent}`)).toEqual(['E3','A3','B3']);
    expect(['octave-change','chromatic'].map(name=>doc.querySelector(`attributes > transpose > ${name}`)?.textContent)).toEqual(['-1','0']);
    expect(texts(doc,'staff-details > staff-lines')).toEqual(['6']);
    expect([...doc.querySelectorAll('staff-details > staff-tuning')].map(node=>`${node.getAttribute('line')}:${node.querySelector('tuning-step')?.textContent}${node.querySelector('tuning-octave')?.textContent}`)).toEqual(['1:E2','2:A2','3:D3','4:G3','5:B3','6:E4']);
    expect([...doc.querySelectorAll('technical')].map(node=>`${node.querySelector('string')?.textContent}/${node.querySelector('fret')?.textContent}`).slice(0,4)).toEqual(['6/0','5/0','5/2','6/0']);
    expect([...doc.querySelectorAll('note > tie')].map(node=>node.getAttribute('type'))).toEqual(['start','start','start','stop','stop','stop']);
    // Simultaneous chord ties carry distinct levels so readers pair them unambiguously.
    expect([...doc.querySelectorAll('notations > tied')].map(node=>`${node.getAttribute('type')}${node.getAttribute('number')}`)).toEqual(['start1','start2','start3','stop1','stop2','stop3']);
    expect(['sign','line'].map(name=>doc.querySelector(`attributes > clef > ${name}`)?.textContent)).toEqual(['TAB','5']);
    const second=doc.querySelectorAll('measure')[1];
    expect(['beats','beat-type'].map(name=>second.querySelector(`attributes > time > ${name}`)?.textContent)).toEqual(['3','4']);
    expect(second.querySelector('attributes > key > fifths')?.textContent).toBe('2');
    expect([...doc.querySelectorAll('direction')].map(node=>[node.querySelector('metronome > per-minute')?.textContent,node.querySelector('sound')?.getAttribute('tempo'),node.querySelector('offset')?.textContent??null,node.querySelector('offset')?.getAttribute('sound')??null])).toEqual([['120','120',null,null],['90','90','960','yes']]);
  });

  // alphaTab draws one stringed staff as notation and TAB; MusicXML needs two staves.
  const notationAndTab=()=>{const score=guitar(),staff=score.tracks[0].staves[0];staff.showStandardNotation=true;for(const bar of staff.bars)bar.clefOttava=model.Ottavia._8vb;return score;};
  it('writes a notation + TAB guitar as one part with two staves',()=>{
    const doc=parse(exportMusicXml(notationAndTab(),selectAll(notationAndTab())));
    expect(texts(doc,'attributes > staves')).toEqual(['2']);
    expect([...doc.querySelectorAll('attributes > clef')].map(node=>`${node.getAttribute('number')}:${node.querySelector('sign')?.textContent}${node.querySelector('line')?.textContent}${node.querySelector('clef-octave-change')?.textContent??''}`)).toEqual(['1:G2-1','2:TAB5']);
    expect([...doc.querySelectorAll('attributes > staff-details')].map(node=>`${node.getAttribute('number')}:${node.firstElementChild?.localName}=${node.querySelector('staff-type')?.textContent}:${node.querySelector('staff-lines')?.textContent}`)).toEqual(['2:staff-type=alternate:6']);
    const notes=[...doc.querySelectorAll('note')];
    expect(notes.length).toBe(26);
    // Each measure: the staff-1 voice, a backup to the bar start, then the staff-2 copy.
    expect(notes.map(note=>`${note.querySelector('staff')?.textContent}/${note.querySelector('voice')?.textContent}`)).toEqual([...Array(6).fill('1/1'),...Array(6).fill('2/5'),...Array(7).fill('1/1'),...Array(7).fill('2/5')]);
    expect(texts(doc,'backup > duration')).toEqual(['3840','2880']);
    expect(notes.filter(note=>note.querySelector('technical')).every(note=>note.querySelector('staff')?.textContent==='2')).toBe(true);
    expect(notes.filter(note=>note.querySelector('technical')).length).toBe(12);
    expect(notes.map(note=>[...note.querySelectorAll('tied')].map(tie=>`${tie.getAttribute('type')}${tie.getAttribute('number')}`).join()).filter(Boolean)).toEqual(['start1','start3','start5','start2','start4','start6','stop1','stop3','stop5','stop2','stop4','stop6']);
  });

  it('refuses a fifth voice on a notation + TAB staff',()=>{
    const whole=(fret:number)=>[{duration:model.Duration.Whole,notes:[{string:1,fret}]}];
    const score=build({strings:[64,59,55,50,45,40],bars:[{numerator:4,denominator:4,voices:[0,1,2,3,4].map(whole)}]});
    score.tracks[0].staves[0].showStandardNotation=true;
    expect(()=>exportMusicXml(score,selectAll(score))).toThrow(/more than four voices/);
  });

  it('round-trips a notation + TAB guitar into one staff shown both ways',()=>{
    const score=notationAndTab(),back=loadInterchangeScore(exportMusicXml(score,selectAll(score)),settings);
    const music=(staff:model.Staff,stringed:boolean)=>staff.bars.map(bar=>bar.voices.filter(voice=>!voice.isEmpty).map(voice=>voice.beats.map(beat=>[beat.displayDuration,...beat.notes.map(note=>[note.realValue,stringed?`${note.string}/${note.fret}`:null,note.isTieDestination]).sort((a,b)=>Number(a[0])-Number(b[0]))])));
    // The import folds the alternate TAB staff back into alphaTab's single stringed staff.
    const staff=back.tracks[0].staves[0];
    expect(back.tracks[0].staves.length).toBe(1);expect([staff.showStandardNotation,staff.showTablature]).toEqual([true,true]);
    expect(music(staff,true)).toEqual(music(score.tracks[0].staves[0],true));
  });

  it('writes tempo text, dynamics changes, forced accidentals and mix points',()=>{
    const score=piano(),voice=score.tracks[0].staves[0].bars[0].voices[0];
    score.masterBars[0].tempoAutomations[0].text='Moderate';
    // B♭4 forced sharp is A♯4; the F4 gets a courtesy natural and is played piano.
    voice.beats[0].notes[0].accidentalMode=model.NoteAccidentalMode.ForceSharp;
    voice.beats[1].notes[0].accidentalMode=model.NoteAccidentalMode.ForceNatural;
    voice.beats[1].dynamics=model.DynamicValue.P;voice.beats[1].notes[0].dynamics=model.DynamicValue.P;
    voice.beats[0].automations.push(Object.assign(new model.Automation(),{type:model.AutomationType.Volume,value:8,ratioPosition:.5}));
    const doc=parse(exportMusicXml(score,selectAll(score)));
    expect([...doc.querySelectorAll('direction')].map(node=>[...node.querySelectorAll('direction-type > *')].map(type=>type.localName==='dynamics'?type.firstElementChild?.localName:type.localName).join('+'))).toEqual(['words+metronome','words','p','f']);
    expect(doc.querySelector('direction words')?.textContent).toBe('Moderate');
    const mix=[...doc.querySelectorAll('direction')].find(node=>node.querySelector('midi-instrument'))!;
    expect([mix.querySelector('offset')?.textContent,mix.querySelector('offset')?.getAttribute('sound'),mix.querySelector('midi-instrument')?.getAttribute('id'),mix.querySelector('volume')?.textContent]).toEqual(['1920','yes','P1-I1','50']);
    expect([...doc.querySelectorAll('note')].map(note=>`${note.querySelector('step')?.textContent}${note.querySelector('alter')?.textContent??''}:${note.querySelector('accidental')?.textContent??''}`)).toEqual(['A1:sharp','F:natural','F:']);
    const back=loadInterchangeScore(exportMusicXml(score,selectAll(score)),settings),beats=back.tracks[0].staves[0].bars[0].voices[0].beats;
    expect(beats.map(beat=>[beat.dynamics,beat.notes[0].realValue,beat.notes[0].accidentalMode])).toEqual([[model.DynamicValue.F,70,model.NoteAccidentalMode.ForceSharp],[model.DynamicValue.P,65,model.NoteAccidentalMode.ForceNatural]]);
    // alphaTab re-imports tempo <words> as beat text, not tempo text.
    expect(back.tracks[0].staves[0].bars[0].voices[0].beats[0].text).toBe('Moderate');
    expect(back.tracks[0].staves[0].bars[0].voices[0].beats[0].automations.filter(a=>a.type===model.AutomationType.Volume).map(a=>[a.value,a.ratioPosition])).toEqual([[8,.5]]);
  });

  it('writes the opening dynamic of every part',()=>{
    const score=build({copies:2,bars:[{numerator:4,denominator:4,voices:[[{duration:half,notes:[{octave:5,tone:0}]},{duration:half,notes:[{octave:5,tone:2}]}]]}]});
    for(const track of score.tracks)for(const beat of track.staves[0].bars[0].voices[0].beats){beat.dynamics=model.DynamicValue.P;beat.notes[0].dynamics=model.DynamicValue.P;}
    const doc=parse(exportMusicXml(score,{tracks:[0,1],range:null}));
    // Dynamics belong to their part in MusicXML: each part states its opening dynamic.
    expect([...doc.querySelectorAll('part')].map(part=>part.querySelectorAll('dynamics').length)).toEqual([1,1]);
    expect(loadInterchangeScore(exportMusicXml(score,{tracks:[0,1],range:null}),settings).tracks.map(track=>track.staves[0].bars[0].voices[0].beats.map(beat=>beat.dynamics))).toEqual([[model.DynamicValue.P,model.DynamicValue.P],[model.DynamicValue.P,model.DynamicValue.P]]);
  });

  // Real Guitar Pro files, as used by the compatibility suite.
  const gp=(name:string)=>loadInterchangeScore(new Uint8Array(readFileSync(`${process.cwd()}/.analysis/compatibility/${name}`)),settings);
  it.each(['guitarpro3-notes.gp3','guitarpro4-notes.gp4','guitarpro5-notes.gp5','guitarpro6-notes.gpx','guitarpro7-notes.gp','guitarpro8-beat-tempo-change.gp'])('exports and re-imports %s',name=>{
    const score=gp(name),back=loadInterchangeScore(exportMusicXml(score,selectAll(score)),settings);
    const music=(value:model.Score)=>value.tracks[0].staves[0].bars.map(bar=>bar.voices.filter(voice=>!voice.isEmpty).map(voice=>voice.beats.map(beat=>[beat.displayDuration,beat.dynamics,...beat.notes.map(note=>note.realValue).sort()])));
    expect(music(back)).toEqual(music(score));
    // GP files may repeat a tempo at one position; the importer keeps one. Tempo text
    // is written as <words>, which alphaTab reads back as beat text.
    const tempos=(value:model.Score)=>value.masterBars.map(bar=>[...new Set(bar.tempoAutomations.map(change=>`${change.value}@${change.ratioPosition}`))]);
    expect(tempos(back)).toEqual(tempos(score));
    const texts=score.masterBars.flatMap(bar=>bar.tempoAutomations.map(change=>change.text).filter(Boolean));
    expect([...parse(exportMusicXml(score,selectAll(score))).querySelectorAll('direction words')].map(node=>node.textContent).filter(Boolean)).toEqual(texts);
  });

  // Bend curves as distinct quarter-tone values; alphaTab's import respaces offsets evenly.
  const bendValues=(note:model.Note)=>note.bendPoints?.map(point=>point.value).filter((value,index,all)=>!index||value!==all[index-1])??[];
  it.each([
    // alphaTab's Note.finish drops a hold point from a 3-point bend: 0→4 over the note.
    ['a bend',[[0,0],[30,4],[60,4]],[['2','0','100','']],[0,4]],
    ['a bend and release',[[0,0],[15,4],[45,4],[60,0]],[['2','0','25',''],['-2','75','100','release']],[0,4,0]],
    ['a pre-bend',[[0,4],[60,4]],[['-2',null,null,'pre-bend']],[4]],
    ['a pre-bend and release',[[0,4],[30,4],[60,0]],[['-2',null,null,'pre-bend'],['-2','0','100','release']],[4,0]],
    ['a half-step bend',[[0,0],[60,2]],[['1','0','100','']],[0,2]],
  ] as [string,number[][],(string|null)[][],number[]][])('writes %s as MusicXML bends',(_name,points,bends,values)=>{
    const score=guitar(),note=score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0];
    for(const [offset,value] of points)note.addBendPoint(new model.BendPoint(offset,value));
    const doc=parse(exportMusicXml(score,selectAll(score)));
    expect([...doc.querySelectorAll('note')][0].querySelectorAll('technical > bend').length).toBe(bends.length);
    expect([...[...doc.querySelectorAll('note')][0].querySelectorAll('technical > bend')].map(bend=>[bend.querySelector('bend-alter')?.textContent??null,bend.getAttribute('first-beat'),bend.getAttribute('last-beat'),bend.querySelector('pre-bend,release')?.localName??''])).toEqual(bends);
    const back=loadInterchangeScore(exportMusicXml(score,selectAll(score)),settings);
    expect(bendValues(back.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0])).toEqual(values);
  });

  it('exports the Guitar Pro bend fixture with its bend shapes',()=>{
    const score=gp('guitarpro7-bends.gp'),back=loadInterchangeScore(exportMusicXml(score,selectAll(score)),settings);
    const shapes=(value:model.Score)=>value.tracks[0].staves[0].bars.flatMap(bar=>bar.voices[0].beats.flatMap(beat=>beat.notes.map(note=>[note.realValue,bendValues(note)])));
    expect(shapes(back)).toEqual(shapes(score));
  });

  it('refuses bend styles',()=>{
    const styled=guitar(),note=styled.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0];
    note.addBendPoint(new model.BendPoint(0,0));note.addBendPoint(new model.BendPoint(60,4));note.bendStyle=model.BendStyle.Fast;
    expect(()=>exportMusicXml(styled,selectAll(styled))).toThrow(/note bendstyle|bend style/);
  });

  // The guitar's bar-1 chord ties into bar 2: bend its low E, then hold or release over the tie.
  const continued=(destination:number[][])=>{
    const score=guitar(),origin=score.tracks[0].staves[0].bars[0].voices[0].beats[3].notes.find(note=>note.string===1)!,tied=score.tracks[0].staves[0].bars[1].voices[0].beats[0].notes.find(note=>note.string===1)!;
    origin.addBendPoint(new model.BendPoint(0,0));origin.addBendPoint(new model.BendPoint(60,4));
    for(const [offset,value] of destination)tied.addBendPoint(new model.BendPoint(offset,value));
    return score;
  };
  const lowE=(doc:Document)=>[...doc.querySelectorAll('note')].filter(note=>note.querySelector('string')?.textContent==='6'&&note.querySelector('tied'));
  it.each([
    ['a hold',[[0,4],[60,4]],[],[4]],
    ['a release',[[0,4],[60,0]],[['-2','0','100','release']],[4,0]],
  ] as [string,number[][],string[][],number[]][])('writes %s continued over a tie relative to the bent pitch',(_name,destination,written,values)=>{
    const score=continued(destination),doc=parse(exportMusicXml(score,selectAll(score)));
    const [start,stop]=lowE(doc);
    expect(start.querySelectorAll('bend').length).toBe(1);
    expect([...stop.querySelectorAll('bend')].map(bend=>[bend.querySelector('bend-alter')?.textContent??'',bend.getAttribute('first-beat')??'',bend.getAttribute('last-beat')??'',bend.querySelector('pre-bend,release')?.localName??''])).toEqual(written);
    const back=loadInterchangeScore(exportMusicXml(score,selectAll(score)),settings);
    const tied=back.tracks[0].staves[0].bars[1].voices[0].beats[0].notes.find(note=>note.string===1)!;
    expect([tied.isTieDestination,bendValues(tied)]).toEqual([true,values]);
  });

  // The pitch-bend stream alphaTab plays, for comparing a source with its re-import.
  const pitchBends=(score:model.Score)=>{
    const file=new midi.MidiFile();new midi.MidiFileGenerator(score,new Settings(),new midi.AlphaSynthMidiFileHandler(file,true)).generate();
    return file.tracks.flatMap(track=>track.events).filter(event=>event instanceof midi.PitchBendEvent).map(event=>[event.tick,(event as midi.PitchBendEvent).value]);
  };
  it('plays a bend held over a tie at the same pitch after re-import',()=>{
    const score=continued([[0,4],[60,4]]);score.finish(settings);
    expect(pitchBends(loadInterchangeScore(exportMusicXml(score,selectAll(score)),settings))).toEqual(pitchBends(score));
  });

  it('refuses a bend that continues into a tied note without its own bend',()=>{
    const score=continued([]);
    expect(()=>exportMusicXml(score,selectAll(score))).toThrow(/continues into a tied note without its own bend/);
  });

  it.each([
    ['a bend cut from its unbent tied note',[[0,0],[60,4]],{first:0,last:0},/cuts a bend from its tied note/],
    ['an unbent tied note cut from its bend',[[0,0],[60,4]],{first:1,last:1},/cuts a tied note from its bend/],
    ['an unbent tied note cut from its pre-bend',[[0,4],[60,4]],{first:1,last:1},/cuts a tied note from its bend/],
  ] as [string,number[][],{first:number;last:number},RegExp][])('refuses a range with %s',(_name,bend,range,error)=>{
    const score=guitar(),origin=score.tracks[0].staves[0].bars[0].voices[0].beats[3].notes.find(note=>note.string===1)!;
    for(const [offset,value] of bend)origin.addBendPoint(new model.BendPoint(offset,value));score.finish(settings);
    expect(()=>exportMusicXml(score,{tracks:[0],range})).toThrow(error);
  });

  it('refuses a range that cuts an unbent tie chain from its bend',()=>{
    const score=build({strings:[64,59,55,50,45,40],bars:[0,1,2].map(index=>({numerator:4,denominator:4,voices:[[{duration:model.Duration.Whole,notes:[{string:1,fret:0,tieDestination:index>0}]}]]}))});
    const first=score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0];
    first.addBendPoint(new model.BendPoint(0,4));first.addBendPoint(new model.BendPoint(60,4));score.finish(settings);
    expect(()=>exportMusicXml(score,{tracks:[0],range:{first:2,last:2}})).toThrow(/cuts a tied note from its bend/);
  });

  it('ignores cut bends on staves the excerpt leaves out',()=>{
    const json=JSON.parse(String(model.JsonConverter.scoreToJson(guitar())));
    json.tracks[0].staves.push(JSON.parse(JSON.stringify(json.tracks[0].staves[0])));
    const score=model.JsonConverter.jsonToScore(JSON.stringify(json),settings);
    const origin=score.tracks[0].staves[1].bars[0].voices[0].beats[3].notes.find(note=>note.string===1)!;
    origin.addBendPoint(new model.BendPoint(0,0));origin.addBendPoint(new model.BendPoint(60,4));score.finish(settings);
    expect(()=>exportMusicXml(score,{tracks:[0],range:{first:0,last:0},staves:{0:[1]}})).toThrow(/cuts a bend from its tied note/);
    expect(()=>exportMusicXml(score,{tracks:[0],range:{first:0,last:0},staves:{0:[0]}})).not.toThrow();
  });

  it('keeps a range that cuts a pre-bend from its unbent tied note',()=>{
    const score=guitar(),origin=score.tracks[0].staves[0].bars[0].voices[0].beats[3].notes.find(note=>note.string===1)!;
    origin.addBendPoint(new model.BendPoint(0,4));origin.addBendPoint(new model.BendPoint(60,4));score.finish(settings);
    expect(()=>exportMusicXml(score,{tracks:[0],range:{first:0,last:0}})).not.toThrow();
  });

  // A guitar bar with grace groups before beat 1 and beat 3.
  const graced=(type:model.GraceType,{first=1,third=0,chord=false}:{first?:number;third?:number;chord?:boolean}={})=>{
    const grace=(fret:number):BeatSpec=>({duration:eighth,grace:type,notes:[{string:2,fret},...chord?[{string:3,fret:fret+1}]:[]]});
    const main=(fret:number):BeatSpec=>({duration:quarter,notes:[{string:2,fret}]});
    return build({strings:[64,59,55,50,45,40],bars:[{numerator:4,denominator:4,voices:[[
      ...Array.from({length:first},(_,at)=>grace(2+at)),main(5),main(7),...Array.from({length:third},(_,at)=>grace(4+at)),main(8),main(10),
    ]]}]});
  };
  const graces=(score:model.Score)=>score.tracks[0].staves[0].bars[0].voices[0].beats.map(beat=>[beat.graceType,beat.duration,beat.notes.map(note=>note.realValue).sort()]);
  const played=(score:model.Score)=>buildPlaybackPlan(score,1).notes.map(note=>[note.startTick,note.endTick,note.key]);
  it.each([
    ['a before-beat grace',model.GraceType.BeforeBeat,{},'<grace slash="yes"/>',['eighth']],
    ['an on-beat grace',model.GraceType.OnBeat,{},'<grace/>',['eighth']],
    ['two-grace groups',model.GraceType.BeforeBeat,{first:2,third:2},'<grace slash="yes"/>',['16th','16th','16th','16th']],
    ['a three-grace group',model.GraceType.OnBeat,{first:3},'<grace/>',['32nd','32nd','32nd']],
    ['a grace chord',model.GraceType.BeforeBeat,{chord:true},'<grace slash="yes"/>',['eighth','eighth']],
  ] as [string,model.GraceType,{first?:number;third?:number;chord?:boolean},string,string[]][])('writes %s and reads it back with the same playback',(_name,type,shape,markup,types)=>{
    const score=graced(type,shape),doc=parse(exportMusicXml(score,selectAll(score)));
    const notes=[...doc.querySelectorAll('note')].filter(note=>note.querySelector('grace'));
    expect(notes.map(note=>note.querySelector('type')?.textContent)).toEqual(types);
    for(const note of notes){
      // MusicXML's note content puts <grace> before <chord>.
      expect(note.firstElementChild?.localName).toBe('grace');
      expect(new XMLSerializer().serializeToString(note.querySelector('grace')!)).toBe(markup);
      expect(note.querySelector('duration')).toBeNull();
    }
    const back=loadInterchangeScore(exportMusicXml(score,selectAll(score)),settings);
    expect(graces(back)).toEqual(graces(score));
    expect(played(back)).toEqual(played(score));
  });

  it('keeps mix changes when a before-beat grace takes time from the previous bar',()=>{
    const main=(fret:number):BeatSpec=>({duration:quarter,notes:[{string:2,fret}]});
    const score=build({strings:[64,59,55,50,45,40],bars:[
      {numerator:4,denominator:4,voices:[[main(1),main(2),main(3),main(4)]]},
      {numerator:4,denominator:4,voices:[[{duration:eighth,grace:model.GraceType.BeforeBeat,notes:[{string:2,fret:6}]},main(5),main(7),main(8),main(10)]]},
    ]});
    score.tracks[0].staves[0].bars[0].voices[0].beats[0].automations.push(Object.assign(new model.Automation(),{type:model.AutomationType.Volume,value:8,ratioPosition:.5}));score.finish(settings);
    const back=loadInterchangeScore(exportMusicXml(score,selectAll(score)),settings);
    expect(back.tracks[0].staves[0].bars[0].voices[0].beats[0].automations.filter(a=>a.type===model.AutomationType.Volume).map(a=>[a.value,a.ratioPosition])).toEqual([[8,.5]]);
    expect(played(back)).toEqual(played(score));
  });

  it('round-trips graces on a notation + TAB guitar',()=>{
    const score=graced(model.GraceType.BeforeBeat,{first:2,third:1}),staff=score.tracks[0].staves[0];
    staff.showStandardNotation=true;for(const bar of staff.bars)bar.clefOttava=model.Ottavia._8vb;score.finish(settings);
    const back=loadInterchangeScore(exportMusicXml(score,selectAll(score)),settings);
    expect(back.tracks[0].staves.length).toBe(1);
    expect(graces(back)).toEqual(graces(score));
    expect(played(back)).toEqual(played(score));
  });

  it.each([
    ['a bend grace',/bend grace/,(score:model.Score)=>{score.tracks[0].staves[0].bars[0].voices[0].beats[0].graceType=model.GraceType.BendGrace;score.finish(settings);}],
    ['a grace with no main beat after it',/grace note without a following beat/,(score:model.Score)=>{const voice=score.tracks[0].staves[0].bars[0].voices[0];voice.beats[4].graceType=model.GraceType.BeforeBeat;score.finish(settings);}],
    ['a tied grace',/tied grace note/,(score:model.Score)=>{const voice=score.tracks[0].staves[0].bars[0].voices[0];voice.beats[1].notes[0].fret=2;voice.beats[1].notes[0].isTieDestination=true;score.finish(settings);}],
    ['a bent grace',/bent grace note/,(score:model.Score)=>{const note=score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0];note.addBendPoint(new model.BendPoint(0,0));note.addBendPoint(new model.BendPoint(60,2));score.finish(settings);}],
  ] as [string,RegExp,(score:model.Score)=>void][])('refuses %s',(_name,error,change)=>{
    const score=graced(model.GraceType.BeforeBeat);change(score);
    expect(()=>exportMusicXml(score,selectAll(score))).toThrow(error);
  });

  // Each beat's syllables on staff 0, voice 0, without trailing empty lines.
  const syllables=(score:model.Score)=>score.tracks[0].staves[0].bars.flatMap(bar=>bar.voices[0].beats.map(beat=>{const lines=[...beat.lyrics??[]];while(lines.length&&!lines.at(-1))lines.pop();return lines;}));
  const sung=(score:model.Score,lines:{startBar:number;text:string}[])=>{applyLyricsEdit(score,{type:'setTrackLyrics',track:0,visible:true,lines});return score;};
  it.each([
    ['hyphens and joined words',[{startBar:0,text:'Hel-lo world a+b'},{startBar:1,text:'la la'}]],
    ['a second line that starts first',[{startBar:1,text:'x y'},{startBar:0,text:'a b c'}]],
  ] as [string,{startBar:number;text:string}[]][])('round-trips lyrics with %s',(_name,lines)=>{
    const score=sung(guitar(),lines),back=loadInterchangeScore(exportMusicXml(score,selectAll(score)),settings);
    expect(syllables(back)).toEqual(syllables(score));
    expect(getTrackLyrics(back,0).lines).toEqual(lines);
  });

  it('writes syllabic lyrics on the first note of each beat',()=>{
    const score=sung(guitar(),[{startBar:0,text:'Hel-lo world a+b'}]),doc=parse(exportMusicXml(score,selectAll(score)));
    expect([...doc.querySelectorAll('lyric')].map(lyric=>[lyric.getAttribute('number'),lyric.querySelector('syllabic')?.textContent,lyric.querySelector('text')?.textContent])).toEqual([['1','begin','Hel'],['1','end','lo'],['1','single','world'],['1','single','a b']]);
    for(const lyric of doc.querySelectorAll('lyric'))expect(lyric.parentElement?.querySelector('chord')).toBeNull();
  });

  it('round-trips lyrics on a notation + TAB guitar',()=>{
    const score=sung(notationAndTab(),[{startBar:0,text:'Hel-lo world'}]),back=loadInterchangeScore(exportMusicXml(score,selectAll(score)),settings);
    expect(back.tracks[0].staves.length).toBe(1);
    expect(syllables(back)).toEqual(syllables(score));
  });

  it('leaves lyrics out with a staff the excerpt does not export',()=>{
    const json=JSON.parse(String(model.JsonConverter.scoreToJson(guitar())));
    json.tracks[0].staves.push(JSON.parse(JSON.stringify(json.tracks[0].staves[0])));
    const score=sung(model.JsonConverter.jsonToScore(JSON.stringify(json),settings),[{startBar:0,text:'Hel-lo world'}]);
    expect(parse(exportMusicXml(score,{tracks:[0],range:null,staves:{0:[1]}})).querySelector('lyric')).toBeNull();
  });

  it.each([
    ['a syllable with an edge space',/empty or has edge spaces/,(score:model.Score)=>sung(score,[{startBar:0,text:'Hel-lo wor-ld a+ b'}])],
    ['a syllable ending in two hyphens',/ending in a hyphen/,(score:model.Score)=>{score.tracks[0].staves[0].bars[0].voices[0].beats[0].lyrics=['a--'];}],
    ['a bare hyphen syllable',/empty or has edge spaces/,(score:model.Score)=>{score.tracks[0].staves[0].bars[0].voices[0].beats[0].lyrics=['-'];}],
    ['lyrics longer than the notes',/more syllables than notes/,(score:model.Score)=>sung(score,[{startBar:0,text:'Hel-lo wor-ld-y a b c d'}])],
    ['lyric comments',/lyric comments/,(score:model.Score)=>sung(score,[{startBar:0,text:'[verse] la la'}])],
    ['lyrics on a rest',/lyrics on a rest/,(score:model.Score)=>{score.tracks[0].staves[0].bars[1].voices[0].beats[4].lyrics=['la'];}],
    ['lyrics outside the first voice',/lyrics outside the first voice/,(score:model.Score)=>{
      const voice=new model.Voice(),bar=score.tracks[0].staves[0].bars[0];bar.addVoice(voice);
      const beat=new model.Beat();beat.duration=model.Duration.Whole;voice.addBeat(beat);const note=new model.Note();note.string=4;note.fret=2;beat.addNote(note);
      for(const other of score.tracks[0].staves[0].bars.slice(1)){const empty=new model.Voice();other.addVoice(empty);const rest=new model.Beat();rest.isEmpty=true;empty.addBeat(rest);}
      score.finish(settings);beat.lyrics=['la'];
    }],
  ] as [string,RegExp,(score:model.Score)=>void][])('refuses %s',(_name,error,change)=>{
    const score=guitar();change(score);
    expect(()=>exportMusicXml(score,selectAll(score))).toThrow(error);
  });

  // A technique on the first beat's note (a beat-level one on its beat), its MusicXML path, and how to read it back.
  type Technique=[string,(note:model.Note)=>void,string,(note:model.Note)=>unknown];
  const techniques:Technique[]=[
    ['an accent',note=>{note.accentuated=model.AccentuationType.Normal;},'articulations > accent',note=>note.accentuated],
    ['a heavy accent',note=>{note.accentuated=model.AccentuationType.Heavy;},'articulations > strong-accent',note=>note.accentuated],
    ['a tenuto',note=>{note.accentuated=model.AccentuationType.Tenuto;},'articulations > tenuto',note=>note.accentuated],
    ['a staccato',note=>{note.isStaccato=true;},'articulations > staccato',note=>note.isStaccato],
    ['a slight vibrato',note=>{note.vibrato=model.VibratoType.Slight;},'ornaments > wavy-line',note=>note.vibrato],
    ['a turn',note=>{note.ornament=model.NoteOrnament.Turn;},'ornaments > turn',note=>note.ornament],
    ['an inverted turn',note=>{note.ornament=model.NoteOrnament.InvertedTurn;},'ornaments > inverted-turn',note=>note.ornament],
    ['a lower mordent',note=>{note.ornament=model.NoteOrnament.LowerMordent;},'ornaments > mordent',note=>note.ornament],
    ['an upper mordent',note=>{note.ornament=model.NoteOrnament.UpperMordent;},'ornaments > inverted-mordent',note=>note.ornament],
    ['an up pick stroke',note=>{note.beat.pickStroke=model.PickStroke.Up;},'technical > up-bow',note=>note.beat.pickStroke],
    ['a down pick stroke',note=>{note.beat.pickStroke=model.PickStroke.Down;},'technical > down-bow',note=>note.beat.pickStroke],
    ['a tap',note=>{note.beat.tap=true;},'technical > tap',note=>note.beat.tap],
  ];
  const marked=(score:model.Score,set:(note:model.Note)=>void)=>{set(score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0]);score.finish(settings);return score;};
  const firstNote=(score:model.Score)=>score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0];
  it.each(techniques)('writes %s and reads it back',(_name,set,path,read)=>{
    const score=marked(guitar(),set),doc=parse(exportMusicXml(score,selectAll(score)));
    expect(doc.querySelector('note')!.querySelectorAll(`notations > ${path}`).length).toBeGreaterThan(0);
    expect([...doc.querySelectorAll('note')].slice(1).some(note=>note.querySelector(`notations > ${path}`))).toBe(false);
    const back=loadInterchangeScore(exportMusicXml(score,selectAll(score)),settings);
    expect(read(firstNote(back))).toEqual(read(firstNote(score)));
    expect(played(back)).toEqual(played(score));
  });

  it.each(techniques)('keeps %s on a notation + TAB guitar',(_name,set,path,read)=>{
    const score=marked(notationAndTab(),set),doc=parse(exportMusicXml(score,selectAll(score)));
    expect([...doc.querySelectorAll("note")].filter(note=>note.querySelector(`notations > ${path}`)).length).toBe(2);
    const back=loadInterchangeScore(exportMusicXml(score,selectAll(score)),settings);
    expect(back.tracks[0].staves.length).toBe(1);
    expect(read(firstNote(back))).toEqual(read(firstNote(score)));
  });

  it.each([
    ['a pick stroke on a rest',/pick stroke or tap on a rest/,()=>{const score=guitar();score.tracks[0].staves[0].bars[1].voices[0].beats[4].pickStroke=model.PickStroke.Up;return score;}],
    ['a tap on a rest',/pick stroke or tap on a rest/,()=>{const score=guitar();score.tracks[0].staves[0].bars[1].voices[0].beats[4].tap=true;return score;}],
    ['vibrato on a bend held over a tie',/vibrato on a bend held over a tie/,()=>{const score=continued([[0,4],[60,4]]);score.tracks[0].staves[0].bars[1].voices[0].beats[0].notes.find(note=>note.string===1)!.vibrato=model.VibratoType.Slight;return score;}],
    ['vibrato in an unbent tie chain after a bend',/vibrato in an unbent tie chain after a bend/,()=>{
      const score=build({strings:[64,59,55,50,45,40],bars:[0,1,2].map(index=>({numerator:4,denominator:4,voices:[[{duration:model.Duration.Whole,notes:[{string:1,fret:0,tieDestination:index>0}]}]]}))});
      const notes=score.tracks[0].staves[0].bars.map(bar=>bar.voices[0].beats[0].notes[0]);
      notes[0].addBendPoint(new model.BendPoint(0,4));notes[0].addBendPoint(new model.BendPoint(60,4));notes[2].vibrato=model.VibratoType.Slight;score.finish(settings);return score;}],
    ['vibrato on a bend tied into an unbent note',/vibrato on a bend tied into an unbent note/,()=>{
      const score=guitar(),origin=score.tracks[0].staves[0].bars[0].voices[0].beats[3].notes.find(note=>note.string===1)!;
      origin.addBendPoint(new model.BendPoint(0,4));origin.addBendPoint(new model.BendPoint(60,4));origin.vibrato=model.VibratoType.Slight;return score;}],
  ] as [string,RegExp,()=>model.Score][])('refuses %s',(_name,error,make)=>{
    const score=make();
    expect(()=>exportMusicXml(score,selectAll(score))).toThrow(error);
  });

  it('refuses a wide vibrato',()=>{
    const score=marked(guitar(),note=>{note.vibrato=model.VibratoType.Wide;});
    expect(()=>exportMusicXml(score,selectAll(score))).toThrow(/wide vibrato/);
  });

  it('refuses a continued bend that does not start at the bent pitch',()=>{
    const score=continued([[0,2],[60,0]]);
    expect(()=>exportMusicXml(score,selectAll(score))).toThrow(/continued bend that does not start/);
  });

  it.each([
    ['a partial release',[[0,4],[60,2]]],
    ['a bend further up',[[0,4],[60,6]]],
  ] as [string,number[][]][])('refuses %s continued over a tie until the import reads it back',(_name,destination)=>{
    const score=continued(destination);
    expect(()=>exportMusicXml(score,selectAll(score))).toThrow(/does not first release fully/);
  });

  it('refuses a continued release and re-bend that reads back without its dip',()=>{
    const score=continued([[0,4],[15,4],[30,0],[45,0],[60,2]]);
    expect(()=>exportMusicXml(score,selectAll(score))).toThrow(/exactly two changes/);
  });

  it.each([
    ['a re-bend',[[0,0],[60,4]],[['2','']],[0,4]],
    ['a re-bend and release',[[0,0],[30,4],[60,0]],[['2',''],['-2','release']],[0,4,0]],
  ] as [string,number[][],string[][],number[]][])('writes %s from 0 continued over a released tie',(_name,destination,written,values)=>{
    const score=guitar(),origin=score.tracks[0].staves[0].bars[0].voices[0].beats[3].notes.find(note=>note.string===1)!,tied=score.tracks[0].staves[0].bars[1].voices[0].beats[0].notes.find(note=>note.string===1)!;
    origin.addBendPoint(new model.BendPoint(0,4));origin.addBendPoint(new model.BendPoint(60,0));
    for(const [offset,value] of destination)tied.addBendPoint(new model.BendPoint(offset,value));
    const doc=parse(exportMusicXml(score,selectAll(score)));
    expect([...lowE(doc)[1].querySelectorAll('bend')].map(bend=>[bend.querySelector('bend-alter')?.textContent,bend.querySelector('pre-bend,release')?.localName??''])).toEqual(written);
    const back=loadInterchangeScore(exportMusicXml(score,selectAll(score)),settings);
    expect(bendValues(back.tracks[0].staves[0].bars[1].voices[0].beats[0].notes.find(note=>note.string===1)!)).toEqual(values);
  });

  it('round-trips the guitar part through the importer',()=>{
    const score=guitar(),back=loadInterchangeScore(exportMusicXml(score,selectAll(score)),settings);
    expect(content(back)).toEqual(content(score));
  });

  // Piano, two voices in F major: flats, backup and voice numbers.
  const piano=()=>build({bars:[{numerator:4,denominator:4,key:-1,tempo:[[120,0]],voices:[
    [{duration:half,notes:[{octave:5,tone:10}]},{duration:half,notes:[{octave:5,tone:5}]}],
    [{duration:model.Duration.Whole,notes:[{octave:4,tone:5}]}],
  ]}]});
  it('writes voices with backup and flat spelling',()=>{
    const score=piano(),doc=parse(exportMusicXml(score,selectAll(score)));
    expect(texts(doc,'note > voice')).toEqual(['1','1','2']);
    expect(texts(doc,'backup > duration')).toEqual(['3840']);
    expect([...doc.querySelectorAll('note > pitch')].map(node=>`${node.querySelector('step')?.textContent}${node.querySelector('alter')?.textContent??''}${node.querySelector('octave')?.textContent}`)).toEqual(['B-14','F4','F3']);
    expect(doc.querySelector('attributes > transpose')).toBeNull();
    expect(doc.querySelector('staff-details')).toBeNull();
    expect(content(loadInterchangeScore(exportMusicXml(score,selectAll(score)),settings))).toEqual(content(score));
  });

  it('excerpts a written-bar range and carries the inherited tempo',()=>{
    const score=guitar(),doc=parse(exportMusicXml(score,{tracks:[0],range:{first:1,last:1}}));
    expect(doc.querySelectorAll('measure').length).toBe(1);
    expect([...doc.querySelectorAll('direction sound')].map(node=>node.getAttribute('tempo'))).toEqual(['120','90']);
    expect(doc.querySelector('measure > attributes > time > beats')?.textContent).toBe('3');
  });

  it.each([
    ['a note effect',/note isghost/,(score:model.Score)=>{score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].isGhost=true;}],
    ['a beat effect',/beat text/,(score:model.Score)=>{score.tracks[0].staves[0].bars[0].voices[0].beats[0].text='Intro';}],
    ['a second staff',/more than one staff/,(score:model.Score)=>{score.tracks[0].ensureStaveCount(2);}],
    ['a percussion staff',/percussion|staff ispercussion/,(score:model.Score)=>{score.tracks[0].staves[0].isPercussion=true;}],
    ['alternate endings',/master alternateendings/,(score:model.Score)=>{score.masterBars[1].alternateEndings=1;}],
    ['a section',/master section/,(score:model.Score)=>{score.masterBars[0].section=Object.assign(new model.Section(),{text:'Verse',marker:'A'});}],
    ['a sounding transposition',/sounding transposition|staff transpositionpitch/,(score:model.Score)=>{score.tracks[0].staves[0].transpositionPitch=2;}],
    ['a later instrument change',/beat automations/,(score:model.Score)=>{score.tracks[0].staves[0].bars[0].voices[0].beats[1].automations.push(Object.assign(new model.Automation(),{type:model.AutomationType.Instrument,value:30}));}],
    ['a gradual mix change',/gradual mix/,(score:model.Score)=>{score.tracks[0].staves[0].bars[0].voices[0].beats[1].automations.push(Object.assign(new model.Automation(),{type:model.AutomationType.Volume,value:8,isLinear:true}));}],
    ['a stringed staff shown only as standard notation',/stringed staff shown only as standard notation/,(score:model.Score)=>{score.tracks[0].staves[0].showStandardNotation=true;score.tracks[0].staves[0].showTablature=false;}],
    ['a hidden accidental',/this accidental mode/,(score:model.Score)=>{score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].accidentalMode=model.NoteAccidentalMode.ForceNone;}],
    ['a forced accidental the pitch cannot take',/forced accidental this pitch cannot take/,(score:model.Score)=>{score.tracks[0].staves[0].bars[0].voices[0].beats[2].notes[0].accidentalMode=model.NoteAccidentalMode.ForceSharp;}],
    ['note dynamics differing from the beat',/note dynamics differing/,(score:model.Score)=>{score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].dynamics=model.DynamicValue.PP;}],
    ['a gradual tempo change',/gradual tempo/,(score:model.Score)=>{score.masterBars[1].tempoAutomations[0].isLinear=true;}],
    ['a MIDI bank',/playback bank/,(score:model.Score)=>{score.tracks[0].playbackInfo.bank=1;}],
    ['a MIDI channel above 16',/MIDI channels above 16/,(score:model.Score)=>{score.tracks[0].playbackInfo.primaryChannel=16;}],
    ['hidden lyrics',/hidden lyrics/,(score:model.Score)=>{setLyricsSource(score.tracks[0],{visible:false,lines:[{startBar:0,text:'la la'}]},false);}],
    ['an unrepresentable tuning',/tuning outside octaves/,(score:model.Score)=>{score.tracks[0].staves[0].stringTuning.tunings=[64,59,55,50,45,-5];}],
    ['a control character in the title',/control characters/,(score:model.Score)=>{score.title='Bad\u0001title';}],
  ])('fails closed for %s',(_name,message,change)=>{
    const score=guitar();change(score);
    expect(()=>exportMusicXml(score,selectAll(score))).toThrow(message);
  });

  it('writes a lone whole rest as a measure rest in any meter',()=>{
    const score=build({bars:[{numerator:3,denominator:4,voices:[[{duration:model.Duration.Whole}]]}]}),doc=parse(exportMusicXml(score,selectAll(score)));
    expect(doc.querySelector('note > rest')?.getAttribute('measure')).toBe('yes');expect(texts(doc,'note > duration')).toEqual(['2880']);
  });

  it('refuses beats whose stored length differs from their note value',()=>{
    // alphaTab fills a voice that starts late with a gap rest of its own length.
    const xml=`<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>whole</type></note><backup><duration>4</duration></backup><forward><duration>1</duration><voice>2</voice></forward><note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>2</voice><type>quarter</type></note></measure></part></score-partwise>`;
    const score=loadInterchangeScore(strToU8(xml),settings);
    expect(()=>exportMusicXml(score,selectAll(score))).toThrow(/a beat whose length differs from its note value|an empty beat inside a voice/);
    // The length guard itself: a stored length that disagrees with the written value.
    const stretched=piano();stretched.tracks[0].staves[0].bars[0].voices[0].beats[0].overrideDisplayDuration=1440;
    expect(()=>exportMusicXml(stretched,selectAll(stretched))).toThrow(/a beat whose length differs from its note value/);
  });

  it('re-exports its own imported output identically',()=>{
    for(const source of [guitar(),piano()]){
      const first=exportMusicXml(source,selectAll(source)),imported=loadInterchangeScore(first,settings);
      // alphaTab's importer turns display-text spaces into non-breaking spaces.
      expect(strFromU8(exportMusicXml(imported,selectAll(imported))).replace(/\u00a0/g,' ')).toBe(strFromU8(first));
    }
  });

  it('ignores per-track stylesheet maps emptied for unexported tracks',()=>{
    const score=build({copies:2,bars:[{numerator:4,denominator:4,voices:[[{duration:model.Duration.Whole,notes:[{octave:5,tone:0}]}]]}]});
    score.stylesheet.perTrackDisplayTuning=new Map([[1,false]]);score.stylesheet.perTrackMultiBarRest=new Set([1]);
    expect(()=>exportMusicXml(score,{tracks:[0],range:null})).not.toThrow();
    // Stylesheet display choices are presentation and are not written.
    expect(()=>exportMusicXml(score,{tracks:[1],range:null})).not.toThrow();
  });

  it('refuses notes in an empty voice and empty beats inside a voice',()=>{
    const hidden=build({bars:[{numerator:4,denominator:4,voices:[[{duration:model.Duration.Whole,notes:[{octave:5,tone:0}]}],[{duration:model.Duration.Whole,empty:true,notes:[{octave:5,tone:4}]}]]}]});
    expect(()=>exportMusicXml(hidden,selectAll(hidden))).toThrow(/notes in an empty voice/);
    const gap=build({bars:[{numerator:4,denominator:4,voices:[[{duration:half,notes:[{octave:5,tone:0}]},{duration:half,empty:true}]]}]});
    expect(()=>exportMusicXml(gap,selectAll(gap))).toThrow(/an empty beat inside a voice/);
  });

  it('checks empty voices and keeps voice numbers',()=>{
    const score=build({bars:[{numerator:4,denominator:4,voices:[[{duration:model.Duration.Whole,empty:true}],[{duration:model.Duration.Whole,notes:[{octave:5,tone:0}]}]]}]});
    const doc=parse(exportMusicXml(score,selectAll(score)));
    expect(texts(doc,'note > voice')).toEqual(['2']);
    score.tracks[0].staves[0].bars[0].voices[0].beats[0].automations.push(Object.assign(new model.Automation(),{type:model.AutomationType.Instrument,value:30}));
    expect(()=>exportMusicXml(score,selectAll(score))).toThrow(/beat automations/);
  });

  it('spells scale degrees by key and rejects pitches below octave 0',()=>{
    // F♯ major: MIDI 65 is E♯4, not F4. G♭ major: MIDI 59 is C♭4, not B3.
    const sharp=build({bars:[{numerator:4,denominator:4,key:6,voices:[[{duration:model.Duration.Whole,notes:[{octave:5,tone:5}]}]]}]});
    expect([...parse(exportMusicXml(sharp,selectAll(sharp))).querySelectorAll('pitch')].map(node=>node.textContent)).toEqual(['E14']);
    const flat=build({bars:[{numerator:4,denominator:4,key:-6,voices:[[{duration:model.Duration.Whole,notes:[{octave:4,tone:11}]}]]}]});
    expect([...parse(exportMusicXml(flat,selectAll(flat))).querySelectorAll('pitch')].map(node=>node.textContent)).toEqual(['C-14']);
    const low=build({bars:[{numerator:4,denominator:4,voices:[[{duration:model.Duration.Whole,notes:[{octave:0,tone:5}]}]]}]});
    expect(()=>exportMusicXml(low,selectAll(low))).toThrow(/pitch outside octaves/);
    // A written pitch below MIDI 0 (sounding 0 with a +12 display transposition) fails closed, not with a TypeError.
    const below=build({transpose:12,bars:[{numerator:4,denominator:4,voices:[[{duration:model.Duration.Whole,notes:[{octave:0,tone:5}]}]]}]});
    expect(()=>exportMusicXml(below,selectAll(below))).toThrow(/pitch outside octaves/);
  });

  it('writes clef octave changes',()=>{
    const score=piano();score.tracks[0].staves[0].bars[0].clefOttava=model.Ottavia._8vb;
    expect(['sign','line','clef-octave-change'].map(name=>parse(exportMusicXml(score,selectAll(score))).querySelector(`clef > ${name}`)?.textContent)).toEqual(['G','2','-1']);
  });

  it('writes the common-time symbol, hidden tempos, repeat counts and one tempo track',()=>{
    const score=build({copies:2,strings:[64,59,55,50,45,40],transpose:-12,bars:[{numerator:4,denominator:4,tempo:[[120,0]],voices:[[{duration:model.Duration.Whole,notes:[{string:1,fret:0}]}]]},{numerator:4,denominator:4,tempo:[[90,.5]],voices:[[{duration:model.Duration.Whole,notes:[{string:1,fret:0}]}]]}]});score.masterBars[0].timeSignatureCommon=true;score.masterBars[1].tempoAutomations[0].isVisible=false;
    score.masterBars[0].isRepeatStart=true;score.masterBars[0].repeatCount=2;score.masterBars[1].repeatCount=3;
    const doc=parse(exportMusicXml(score,{tracks:[0,1],range:null}));
    expect(doc.querySelector('time')?.getAttribute('symbol')).toBe('common');
    expect([...doc.querySelectorAll('metronome')].map(node=>node.getAttribute('print-object'))).toEqual([null,'no']);
    expect([...doc.querySelectorAll('part')].map(part=>part.querySelectorAll('direction').length)).toEqual([2,0]);
    expect([...doc.querySelectorAll('part')][0].querySelectorAll('repeat').length).toBe(3);
    expect([...[...doc.querySelectorAll('part')][0].querySelectorAll('repeat[direction="backward"]')].map(node=>node.getAttribute('times'))).toEqual([null,'3']);
  });
});
