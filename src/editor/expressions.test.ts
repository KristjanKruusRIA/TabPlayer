import { expect,it } from 'vitest';
import { model,Settings } from '@coderline/alphatab';
import { music,target } from './fixtures';
import { searchCommands,shortcutModifier,type PaletteContext } from './command-palette';
import { buildScore,previewEdit } from '../engine';
import { blankProject,type Project } from '../project';

const context=(patch:Partial<PaletteContext>={}):PaletteContext=>({score:music(),target,string:6,canUndo:true,canRedo:false,...patch});
const first=(query:string,patch?:Partial<PaletteContext>)=>searchCommands(query,context(patch))[0];
const measure=(numerator:number,denominator:number,section='')=>({numerator,denominator,pickup:false,freeTime:false,repeatStart:false,repeatCount:0,endings:[],section,tempos:[]});

it('reads prefix-free expressions before commands',()=>{
  expect(first('ff')).toMatchObject({title:'Dynamic ff on the note',action:{kind:'edit',command:{type:'setNoteTechniquesByIndex',target,noteIndex:0,patch:{dynamics:model.DynamicValue.FF}}}});
  expect(first('mp')).toMatchObject({action:{command:{patch:{dynamics:model.DynamicValue.MP}}}});
  expect(first('2/2')).toMatchObject({title:'Time signature 2/2 for measure 1',action:{kind:'edit',command:{type:'setMeasureSettings',bar:0,...measure(2,2)}}});
  expect(first(' 8 / 8 ')).toMatchObject({action:{command:{numerator:8,denominator:8}}});
  expect(first('Eb major')).toMatchObject({title:'Key E♭ major for measure 1 of this staff',action:{kind:'edit',command:{type:'setBarNotation',track:0,staff:0,bar:0,keySignature:-3,keyMode:model.KeySignatureType.Major,clef:model.Clef.G2}}});
  expect(first('f# minor')).toMatchObject({title:'Key F♯ minor for measure 1 of this staff',action:{command:{keySignature:3,keyMode:model.KeySignatureType.Minor}}});
  expect(first('bass')).toMatchObject({title:'Bass clef for measure 1 of this staff',action:{command:{type:'setBarNotation',keySignature:0,clef:model.Clef.F4}}});
  expect(first('D.S. al Coda')).toMatchObject({title:'D.S. al Coda at measure 1',action:{kind:'edit',command:{type:'setDirections',bar:0,directions:[model.Direction.JumpDalSegnoAlCoda]}}});
  expect(first('segno')).toMatchObject({action:{command:{directions:[model.Direction.TargetSegno]}}});
  expect(first('[Chorus]')).toMatchObject({title:'Section “Chorus” at measure 1',action:{kind:'edit',command:{type:'setMeasureSettings',bar:0,...measure(4,4,'Chorus')}}});
  const chord=first('Am7');
  expect(chord).toMatchObject({title:'Chord Am7 on the beat',action:{kind:'edit',command:{type:'setHarmonyChord',target,fillEmptyBeat:false,chord:{name:'Am7',nameMode:'theory',showName:true,showDiagram:true}}}});
  expect(first('G/B')).toMatchObject({action:{command:{chord:{name:'G/B'}}}});
  // Ordinary command words are still commands.
  expect(first('fret 5')?.title).toBe('Set fret');expect(first('redo')?.title).toBe('Redo');
});

it('explains expressions that cannot apply',()=>{
  const cases:[string,string][]=[
    ['33/4','Type a time signature such as 3/4, with up to 32 beats of 1, 2, 4, 8, 16, 32 or 64.'],['3/5','Type a time signature such as 3/4, with up to 32 beats of 1, 2, 4, 8, 16, 32 or 64.'],
    ['4/4','Measure 1 is already in 4/4.'],['3/4','Measure 1 holds more music than 3/4 allows; shorten or remove beats first.'],['treble','Measure 1 already has a treble clef.'],['C major','Measure 1 is already in C major.'],
    ['Fb major','Fb major needs more than seven flats; try E major.'],['[]','Type a section name between the brackets.'],
  ];
  for(const [query,error] of cases){expect(first(query),query).toMatchObject({error});expect(first(query)?.action,query).toBeUndefined();}
  const rest=music();rest.tracks[0].staves[0].bars[0].voices[0].beats[0].notes.splice(0);rest.finish(new Settings());
  expect(first('ff',{score:rest})).toMatchObject({error:'A dynamic needs a note on the beat.'});
  const segno=music();segno.masterBars[0].directions=new Set([model.Direction.TargetSegno]);
  expect(first('segno',{score:segno})).toMatchObject({error:'Measure 1 already has Segno.'});
  expect(first('coda',{score:segno})).toMatchObject({action:{command:{directions:[model.Direction.TargetSegno,model.Direction.TargetCoda]}}});
  expect(first('[Verse]',{score:(()=>{const score=music();score.masterBars[0].section=Object.assign(new model.Section(),{text:'Verse',marker:'Verse'});return score;})()})).toMatchObject({error:'Measure 1 already starts the section “Verse”.'});
});

it('applies every expression through the engine on a real document',()=>{
  let project:Project=blankProject();
  for(const query of ['fret 5','mf','2/2','G major','bass','D.C. al Fine','[Intro]','C']){
    const match=first(query,{score:buildScore(project),string:1});
    expect(match?.action?.kind,query).toBe('edit');
    if(match?.action?.kind!=='edit')continue;
    project=previewEdit(project,match.action.command).project;
  }
  expect(project.edits.map(edit=>edit.type)).toEqual(['setNote','setNoteTechniquesByIndex','setMeasureSettings','setBarNotation','setBarNotation','setDirections','setMeasureSettings','setHarmonyChord']);
  const score=buildScore(project),bar=score.tracks[0].staves[0].bars[0],beat=bar.voices[0].beats[0];
  expect([score.masterBars[0].timeSignatureNumerator,bar.keySignature,bar.clef,[...score.masterBars[0].directions??[]],score.masterBars[0].section?.text,beat.notes[0].dynamics,beat.chord?.name])
    .toEqual([2,1,model.Clef.F4,[model.Direction.JumpDaCapoAlFine],'Intro',model.DynamicValue.MF,'C']);
});

it('names the shortcut modifier Cmd on Apple platforms and Ctrl elsewhere',()=>{
  expect(shortcutModifier('MacIntel')).toBe('Cmd');expect(shortcutModifier('iPad')).toBe('Cmd');
  expect(shortcutModifier('Win32')).toBe('Ctrl');expect(shortcutModifier('Linux x86_64')).toBe('Ctrl');expect(shortcutModifier(undefined)).toBe('Ctrl');
});

it('lists keyboard shortcuts beside the commands that have them',()=>{
  const keys=Object.fromEntries(searchCommands('',context()).map(match=>[match.title,match.keys]));
  // The labels follow the machine running the test: Cmd on macOS, Ctrl elsewhere.
  const mod=shortcutModifier(typeof navigator!=='undefined'?navigator.platform:undefined);
  expect(keys).toMatchObject({Undo:`${mod}+Z`,Redo:`${mod}+Shift+Z`,'Play or pause':'Space','New score':`${mod}+N`,'Open score':`${mod}+O`,Save:`${mod}+S`,'Save As':`${mod}+Shift+S`,'Help topics':'F1'});
  expect(keys['Go to measure']).toBeUndefined();
});

it('sets the dynamic of the note at the edit target, as the inspector does, and keeps it through a rebuild',()=>{
  let project:Project=blankProject();
  project=previewEdit(project,{type:'setNote',target,string:1,fret:5}).project;project=previewEdit(project,{type:'setNote',target,string:3,fret:2}).project;
  // In a chord, the edit target's string picks the note; other notes keep their own dynamics.
  expect(first('ff',{score:buildScore(project),string:4})).toMatchObject({error:'Move the edit target to a note on this beat.'});
  const match=first('ff',{score:buildScore(project),string:3});if(match?.action?.kind!=='edit')throw new Error('ff');
  const after=previewEdit(project,match.action.command).project;
  const rebuilt=buildScore(JSON.parse(JSON.stringify(after))).tracks[0].staves[0].bars[0].voices[0].beats[0];
  expect(rebuilt.notes.map(note=>[note.string,note.dynamics]).sort()).toEqual([[1,model.DynamicValue.F],[3,model.DynamicValue.FF]]);
});

it('keeps commands whose title holds the typed word ahead of an expression',()=>{
  expect(searchCommands('p',context()).slice(0,2).map(match=>match.title)).toEqual(['Play or pause','Dynamic p on the note']);
  expect(first('f')?.title).toBe('Set fret');
  expect(first('a')?.title).not.toMatch(/^Chord/);
  expect(first('ff')?.title).toBe('Dynamic ff on the note');
});

it('reads common chord spellings and prefers a root-position diagram',()=>{
  for(const [typed,name] of [['Cmaj','C'],['CM7','Cmaj7'],['Cmin','Cm'],['C-7','Cm7'],['C+','Caug'],['C°','Cdim'],['am7','Am7'],['Bbm/Db','Bbm/Db']] as const)
    expect(first(typed)?.action,typed).toMatchObject({command:{chord:{name}}});
  const staff=music().tracks[0].staves[0];
  for(const typed of ['Am7','Cmaj7','C#m7b5','G7']){
    const match=first(typed);if(match?.action?.kind!=='edit'||match.action.command.type!=='setHarmonyChord'||!match.action.command.chord)throw new Error(typed);
    const {frets,recipe}=match.action.command.chord,lowest=Math.min(...frets.flatMap((fret,index)=>fret<0?[]:[staff.tuning[index]+fret]));
    expect(lowest%12,typed).toBe(([0,2,4,5,7,9,11][recipe!.root.step]+recipe!.root.alteration+12)%12);
  }
  expect(first('Da Coda')).toMatchObject({action:{command:{directions:[model.Direction.JumpDaCoda]}}});
  expect(first('D.C.al Fine')).toMatchObject({action:{command:{directions:[model.Direction.JumpDaCapoAlFine]}}});
  expect(first('sfz')).toMatchObject({action:{command:{patch:{dynamics:model.DynamicValue.SFZ}}}});
  expect(first('EB major')).toMatchObject({action:{command:{keySignature:-3}}});
});

it('refuses expressions that would change other measure settings or do not fit the track',()=>{
  const tempo=music();tempo.masterBars[0].tempoAutomations=[model.Automation.buildTempoAutomation(false,0,120,2),model.Automation.buildTempoAutomation(false,0.375,90,2)];
  for(const query of ['[Chorus]','2/2'])expect(first(query,{score:tempo}),query).toMatchObject({error:'Measure 1 has a tempo change between beats or with a label; change it in the inspector\'s Measure & notation panel.'});
  const labelled=music();const automation=model.Automation.buildTempoAutomation(false,0,120,2);automation.text='Swing';labelled.masterBars[0].tempoAutomations=[automation];
  expect(first('[Chorus]',{score:labelled})?.action).toBeUndefined();
  const jump=music();jump.masterBars[0].directions=new Set([model.Direction.JumpDaCapoAlFine]);
  expect(first('D.S. al Coda',{score:jump})).toMatchObject({error:'Measure 1 already jumps with D.C. al Fine.'});
  expect(first('Fine',{score:jump})?.action).toBeDefined();
  const drums=music();drums.tracks[0].staves[0].isPercussion=true;
  expect(first('Am',{score:drums})).toMatchObject({error:'Chords apply to fretted tracks.'});
  expect(first('G major',{score:drums})).toMatchObject({error:'Key signatures apply to pitched tracks.'});
  const empty=music(),voice=empty.tracks[0].staves[0].bars[0].voices[0];voice.beats.splice(0);const placeholder=new model.Beat();placeholder.isEmpty=true;voice.addBeat(placeholder);empty.finish(new Settings());
  expect(first('Am',{score:empty})).toMatchObject({error:'Put a note or rest on this beat first.'});
});

it('keeps common time and the section marker when a measure edit leaves them unchanged',()=>{
  let project:Project=blankProject();
  project=previewEdit(project,{type:'setMasterBarGestures',bar:0,commonTime:true,doubleBar:false,tripletFeel:0,beaming:null}).project;
  const match=first('[Chorus]',{score:buildScore(project)});if(match?.action?.kind!=='edit')throw new Error('section');
  project=previewEdit(project,match.action.command).project;
  const master=buildScore(project).masterBars[0];
  expect([master.timeSignatureCommon,master.section?.text]).toEqual([true,'Chorus']);
});
