// @vitest-environment jsdom
import { expect,it } from 'vitest';
import { exporter,midi,model,NotationElement,Settings,StaveProfile,SystemsLayoutMode } from '@coderline/alphatab';
import { strToU8,unzipSync,zipSync } from 'fflate';
import { allNotes,captureNoteLinks } from '../editor/links';
import { getLyricsSource,setLyricsSource } from '../editor/lyrics-source';
import { exportGpInterchange,loadInterchangeScore } from '../interchange/gp';
import type { EngravingOverrides,TrackProfile } from './types';
import { configureEngraving,defaultEngraving,projectEngraving,remapStylesheetTracks,validateEngraving,validateEngravingTracks } from './projection';

const ids=['base/guitar','base/piano','base/drums'];
function music() {
  const score=new model.Score();score.addMasterBar(new model.MasterBar());
  for(const [index,name]of ['Guitar','Piano','Drums'].entries()) {
    const track=new model.Track();track.name=name;track.playbackInfo.primaryChannel=index===2?9:index;track.playbackInfo.secondaryChannel=index===2?9:index+3;
    for(let staffIndex=0;staffIndex<(index===1?2:1);staffIndex++) {
      const staff=new model.Staff();staff.stringTuning.tunings=index===0?[64,59,55,50,45,40]:[];staff.isPercussion=index===2;
      staff.showStandardNotation=true;staff.showTablature=true;staff.showSlash=true;staff.showNumbered=true;
      const bar=new model.Bar(),voice=new model.Voice();track.addStaff(staff);staff.addBar(bar);bar.addVoice(voice);
      for(let beatIndex=0;beatIndex<4;beatIndex++) {
        const beat=new model.Beat();beat.duration=model.Duration.Quarter;beat.isEmpty=false;voice.addBeat(beat);
        if(beatIndex===0||beatIndex===2){const note=new model.Note();if(index===0){note.string=6;note.fret=3+beatIndex;}else if(index===2){note.percussionArticulation=38+beatIndex;}else{note.octave=staffIndex===0?5:3;note.tone=beatIndex;}beat.addNote(note);}
      }
    }
    score.addTrack(track);
  }
  score.finish(new Settings());for(const track of score.tracks)for(const staff of track.staves){staff.showStandardNotation=true;staff.showTablature=true;staff.showSlash=true;staff.showNumbered=true;}for(const note of allNotes(score))note.dynamics=model.DynamicValue.MF;
  return score;
}
const tuple=(staff:model.Staff)=>[staff.showStandardNotation,staff.showTablature,staff.showSlash,staff.showNumbered];
const beats=(score:model.Score)=>score.tracks.flatMap(t=>t.staves.flatMap(s=>s.bars.flatMap(b=>b.voices.flatMap(v=>v.beats))));
// Decode the SMF bytes independently of the generator's event classes.
function midiAttacks(score:model.Score) {
  const file=new midi.MidiFile();new midi.MidiFileGenerator(score,new Settings(),new midi.AlphaSynthMidiFileHandler(file,true)).generate();
  const bytes=file.toBinary(),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let p=0;
  const text=(n:number)=>String.fromCharCode(...bytes.slice(p,p+=n)),u32=()=>{const n=view.getUint32(p);p+=4;return n;},u16=()=>{const n=view.getUint16(p);p+=2;return n;};
  const variable=()=>{let value=0,byte;do{byte=bytes[p++];value=value*128+(byte&127);}while(byte&128);return value;};
  expect(text(4)).toBe('MThd');expect(u32()).toBe(6);u16();const count=u16();expect(u16()).toBe(960);const result:number[][]=[];
  for(let track=0;track<count;track++){expect(text(4)).toBe('MTrk');const length=u32(),end=p+length;let tick=0,status=0;
    while(p<end){tick+=variable();let code=bytes[p++];if(code<128){p--;code=status;}else if(code<240)status=code;
      if(code===255){p++;const length=variable();p+=length;}else if(code===240||code===247){const length=variable();p+=length;}else{const kind=code&240,a=bytes[p++],b=kind===192||kind===208?undefined:bytes[p++];if(kind===144&&b)result.push([tick,a,b,code&15]);}
    }
  }
  expect(p).toBe(bytes.length);return result;
}

it('inherit_and_reset_preserve_source_style_without_mutation',()=>{
  const source=music(),style=source.stylesheet;style.hideDynamics=true;style.perTrackDisplayTuning=new Map([[1,false]]);
  const origin=allNotes(source)[0],voice=origin.beat.voice,first=new model.Note(),last=new model.Note();
  origin.bendType=model.BendType.Bend;origin.addBendPoint(new model.BendPoint(0,0));origin.addBendPoint(new model.BendPoint(60,4));
  for(const note of [first,last]){note.string=6;note.fret=3;voice.beats[1].addNote(note);note.tieOrigin=origin;note.isTieDestination=true;note.bendOrigin=origin;note.isContinuedBend=true;}
  origin.tieDestination=last;origin.slurDestination=first;first.slurOrigin=origin;first.isSlurDestination=true;
  const slideTarget=voice.beats[2].notes[0];first.slideTarget=slideTarget;first.slideOutType=model.SlideOutType.Legato;slideTarget.slideOrigin=first;origin.hammerPullDestination=last;origin.isHammerPullOrigin=true;last.hammerPullOrigin=origin;
  origin.dynamics=model.DynamicValue.PP;last.dynamics=model.DynamicValue.FF;
  setLyricsSource(source.tracks[0],{visible:false,lines:Array.from({length:5},(_,i)=>({startBar:0,text:`raw ${i}  a+b\n[c]`}))},true);
  source.backingTrack=new model.BackingTrack();source.backingTrack.rawAudioFile=new Uint8Array([0,255,4]);
  const before=model.JsonConverter.scoreToJson(source),links=captureNoteLinks(source),raw=getLyricsSource(source.tracks[0]);
  const inherited=projectEngraving(source,ids,defaultEngraving());expect(inherited.score===source,'detached score').toBe(false);expect(inherited.score.stylesheet.hideDynamics).toBe(true);expect(inherited.score.stylesheet.perTrackDisplayTuning).toEqual(new Map([[1,false]]));
  const value=defaultEngraving();value.stylesheet.hideDynamics=false;value.stylesheet.tuning=true;
  const changed=projectEngraving(source,ids,value);expect(changed.score.stylesheet.hideDynamics).toBe(false);expect(changed.score.stylesheet.perTrackDisplayTuning?.size??0).toBe(0);
  const reset=projectEngraving(source,ids,defaultEngraving());expect(reset.score.stylesheet.hideDynamics).toBe(true);
  for(const result of [inherited,changed,reset]) {
    expect(captureNoteLinks(result.score)).toEqual(links);expect(getLyricsSource(result.score.tracks[0])).toEqual(raw);expect(result.score.backingTrack!.rawAudioFile).toEqual(new Uint8Array([0,255,4]));
    expect(allNotes(result.score).map(n=>n.dynamics)).toEqual(allNotes(source).map(n=>n.dynamics));
    for(const beat of beats(source)){expect(result.beats.get(beat.id)?.source===beat,'canonical beat').toBe(true);expect(result.beats.get(beat.id)?.rendered.id).toBe(beat.id);}
    for(const note of allNotes(source)){expect(result.notes.get(note.id)?.source===note,'canonical note').toBe(true);expect(result.notes.get(note.id)?.rendered===note,'detached note').toBe(false);}
    const mappedOrigin=result.notes.get(origin.id)!.rendered;
    expect(result.notes.get(first.id)!.rendered.tieOrigin===mappedOrigin,'first incoming tie').toBe(true);expect(result.notes.get(last.id)!.rendered.tieOrigin===mappedOrigin,'last incoming tie').toBe(true);expect(mappedOrigin.tieDestination===result.notes.get(last.id)!.rendered,'canonical outgoing tie').toBe(true);
    expect(result.notes.get(first.id)!.rendered.bendOrigin===mappedOrigin,'first bend origin').toBe(true);expect(result.notes.get(last.id)!.rendered.bendOrigin===mappedOrigin,'last bend origin').toBe(true);
    expect(result.score.backingTrack!.rawAudioFile).not.toBe(source.backingTrack!.rawAudioFile);expect(result.score.stylesheet.perTrackDisplayTuning).not.toBe(style.perTrackDisplayTuning);
  }
  expect(model.JsonConverter.scoreToJson(source)).toBe(before);expect(captureNoteLinks(source)).toEqual(links);expect(getLyricsSource(source.tracks[0])).toEqual(raw);
});

it('retains_source_archive_siblings_through_a_render_projection',()=>{
  const entries=unzipSync(new exporter.Gp7Exporter().export(music(),new Settings()));
  entries['Content/score.gpss']=strToU8('unknown untouched style');entries['Content/BinaryStylesheet']=new Uint8Array([0,0,0,0]);entries['Content/Assets/backing.bin']=new Uint8Array([8,0,4]);
  const bytes=zipSync(entries),source=loadInterchangeScore(bytes,new Settings()),value=defaultEngraving();value.stylesheet.hideDynamics=true;
  const output=unzipSync(exportGpInterchange(projectEngraving(source,ids,value).score,new Settings()));
  for(const [name,data]of Object.entries(entries))if(name!=='Content/score.gpif'){expect([...output[name]],name).toEqual([...data]);expect([...unzipSync(bytes)[name]],name).toEqual([...data]);}
});

it('finite_override_validation_is_atomic',()=>{
  const first=defaultEngraving(),second=defaultEngraving();first.profiles.push({trackId:'x',profile:'standard'});first.stylesheet.hideDynamics=true;
  expect(second.profiles).toEqual([]);expect(second.stylesheet.hideDynamics).toBeNull();
  for(const factor of [.25,4,null]){const value=defaultEngraving();value.systemSpacing=factor;expect(()=>validateEngraving(value)).not.toThrow();}
  const invalid:unknown[]=[null,[],{}, {...second,extra:0}, {...second,systemSpacing:NaN},{...second,systemSpacing:Infinity},{...second,systemSpacing:.249},{...second,systemSpacing:4.01},{...second,profiles:[{trackId:' ',profile:'standard'}]},{...second,profiles:[{trackId:'x',profile:'oops'}]},{...second,profiles:[{trackId:'x',profile:'source'},{trackId:'x',profile:'standard'}]}];
  for(const section of ['stylesheet','notation'] as const)for(const key of Object.keys(second[section])) {
    const missing=structuredClone(second) as unknown as Record<string,Record<string,unknown>>;delete missing[section][key];invalid.push(missing);
    invalid.push({...second,[section]:{...second[section],[key]:'invalid'}});
  }
  invalid.push({...second,notation:{...second.notation,unknown:true}},{...second,profiles:[{trackId:'x',profile:'source',extra:0}]},{...second,stylesheet:{...second.stylesheet,hideDynamics:true},notation:{...second.notation,smallGraceTab:false,showDiveWhammyZeros:'invalid'}});
  const source=music(),before=model.JsonConverter.scoreToJson(source),settings=new Settings(),old=settings.notation.smallGraceTabNotes;
  for(const value of invalid){expect(()=>validateEngraving(value),JSON.stringify(value)).toThrow();expect(()=>projectEngraving(source,ids,value as EngravingOverrides)).toThrow();expect(()=>configureEngraving(settings,value as EngravingOverrides)).toThrow();}
  expect(model.JsonConverter.scoreToJson(source)).toBe(before);expect(settings.notation.smallGraceTabNotes).toBe(old);
});

it('profiles_replace_all_four_staff_flags_without_changing_music_or_ids',()=>{
  const source=music(),before=model.JsonConverter.scoreToJson(source),expected=[[0,67,79,0],[0,60,79,1],[0,36,79,1],[0,38,79,9],[1920,69,79,0],[1920,62,79,1],[1920,38,79,1],[1920,40,79,9]];
  expect(midiAttacks(source)).toEqual(expected);
  const cases:Array<[TrackProfile,boolean[][]]>=[['source',[[true,true,true,true],[true,true,true,true],[true,true,true,true],[true,true,true,true]]],['standard',[[true,false,false,false],[true,false,false,false],[true,false,false,false],[true,false,false,false]]],['standardTab',[[true,true,false,false],[true,false,false,false],[true,false,false,false],[true,false,false,false]]],['slash',[[false,false,true,false],[false,false,true,false],[false,false,true,false],[false,false,true,false]]]];
  for(const [profile,want]of cases){const value=defaultEngraving();value.profiles=ids.map(trackId=>({trackId,profile}));value.stylesheet.hideDynamics=true;const result=projectEngraving(source,ids,value);expect(result.score.tracks.flatMap(t=>t.staves.map(tuple))).toEqual(want);expect(midiAttacks(result.score)).toEqual(expected);}
  for(const [profile,trackId,want]of [['tablature',ids[0],[false,true,false,false]],['numbered',ids[0],[false,false,false,true]],['numbered',ids[1],[false,false,false,true]]] as const){const value=defaultEngraving();value.profiles=[{trackId,profile}];const result=projectEngraving(source,ids,value);expect(result.score.tracks[ids.indexOf(trackId)].staves.map(tuple)).toEqual(trackId===ids[1]?[want,want]:[want]);expect(midiAttacks(result.score)).toEqual(expected);}
  for(const [profile,trackId]of [['tablature',ids[1]],['tablature',ids[2]],['numbered',ids[2]]] as const){const value=defaultEngraving();value.profiles=[{trackId,profile}];expect(()=>validateEngravingTracks(source,ids,value)).toThrow();expect(()=>projectEngraving(source,ids,value)).toThrow();}
  const missing=defaultEngraving();missing.profiles=[{trackId:'removed/source',profile:'tablature'}];expect(()=>validateEngravingTracks(source,ids,missing)).toThrow();expect(projectEngraving(source,ids,missing).score.tracks.flatMap(t=>t.staves.map(tuple))).toEqual(cases[0][1]);
  expect(model.JsonConverter.scoreToJson(source)).toBe(before);
});

it('known_public_fields_and_maps_are_projected_exactly',()=>{
  const source=music(),style=source.stylesheet;style.perTrackDisplayTuning=new Map([[0,false]]);style.perTrackChordDiagramsOnTop=new Map([[1,true]]);style.perTrackMultiBarRest=new Set([2]);
  const chord=new model.Chord();chord.name='C';chord.showDiagram=false;chord.showName=true;source.tracks[0].staves[0].addChord('c',chord);
  for(const beat of beats(source))beat.voice.bar.barNumberDisplay=model.BarNumberDisplay.Hide;
  const sourceJson=model.JsonConverter.scoreToJson(source);
  const cases:Array<[keyof EngravingOverrides['stylesheet'],unknown,string,unknown]>=[
    ['hideDynamics',true,'hideDynamics',true],['brackets','none','bracketExtendMode',0],['brackets','staves','bracketExtendMode',1],['brackets','similar','bracketExtendMode',2],
    ['extendBarLines',true,'extendBarLines',true],['systemSeparators',true,'useSystemSignSeparator',true],['tuning',false,'globalDisplayTuning',false],
    ['singleNames','hidden','singleTrackTrackNamePolicy',0],['singleNames','firstSystem','singleTrackTrackNamePolicy',1],['singleNames','allSystems','singleTrackTrackNamePolicy',2],
    ['multiNames','hidden','multiTrackTrackNamePolicy',0],['multiNames','firstSystem','multiTrackTrackNamePolicy',1],['multiNames','allSystems','multiTrackTrackNamePolicy',2],
    ['firstNames','full','firstSystemTrackNameMode',0],['firstNames','short','firstSystemTrackNameMode',1],['otherNames','full','otherSystemsTrackNameMode',0],['otherNames','short','otherSystemsTrackNameMode',1],
    ['firstNameDirection','horizontal','firstSystemTrackNameOrientation',0],['firstNameDirection','vertical','firstSystemTrackNameOrientation',1],['otherNameDirection','horizontal','otherSystemsTrackNameOrientation',0],['otherNameDirection','vertical','otherSystemsTrackNameOrientation',1],
    ['barNumbers','all','barNumberDisplay',0],['barNumbers','firstSystem','barNumberDisplay',1],['barNumbers','hidden','barNumberDisplay',2],
    ['hideEmptyStaves',false,'hideEmptyStaves',false],['hideEmptyFirstSystem',true,'hideEmptyStavesInFirstSystem',true],['singleStaffBrackets',true,'showSingleStaffBrackets',true],
  ];
  for(const [key,value,field,want]of cases){const override=defaultEngraving();Object.assign(override.stylesheet,{[key]:value});const copy=projectEngraving(source,ids,override).score;expect((copy.stylesheet as unknown as Record<string,unknown>)[field]).toEqual(want);expect(midiAttacks(copy)).toEqual([[0,67,79,0],[0,60,79,1],[0,36,79,1],[0,38,79,9],[1920,69,79,0],[1920,62,79,1],[1920,38,79,1],[1920,40,79,9]]);if(key==='tuning')expect(copy.stylesheet.perTrackDisplayTuning?.size??0).toBe(0);if(key==='barNumbers')expect(copy.tracks.flatMap(t=>t.staves.flatMap(s=>s.bars.map(b=>b.barNumberDisplay)))).toEqual([undefined,undefined,undefined,undefined]);}
  for(const [value,want]of [['hidden',[false,false]],['top',[true,false]],['inline',[false,true]],['both',[true,true]]] as const){const override=defaultEngraving();override.stylesheet.chords=value;const copy=projectEngraving(source,ids,override).score;expect([copy.stylesheet.globalDisplayChordDiagramsOnTop,copy.stylesheet.globalDisplayChordDiagramsInScore]).toEqual(want);expect(copy.stylesheet.perTrackChordDiagramsOnTop?.size??0).toBe(0);expect(copy.tracks[0].staves[0].getChord('c')).toMatchObject({name:'C',showDiagram:false,showName:true});}
  for(const [value,want]of [['on',[0,1,2]],['off',[]]] as const){const override=defaultEngraving();override.stylesheet.multiRests=value;const copy=projectEngraving(source,ids,override).score;expect(copy.stylesheet.multiTrackMultiBarRest).toBe(value==='on');expect([...copy.stylesheet.perTrackMultiBarRest??[]]).toEqual(want);}
  expect(projectEngraving(source,ids,defaultEngraving()).score.stylesheet.perTrackMultiBarRest).toEqual(new Set([2]));expect(model.JsonConverter.scoreToJson(source)).toBe(sourceJson);
});

it('notation_configuration_resets_only_owned_fields_and_element_keys',()=>{
  const settings=new Settings(),defaults=new Settings(),core=settings.core,player=settings.player,resources=settings.display.resources;
  settings.core.engine='svg';settings.notation.transpositionPitches=[12];settings.notation.displayTranspositionPitches=[-12];settings.notation.elements.set(NotationElement.ScoreTitle,false);settings.notation.rhythmHeight=47;
  const mode=settings.notation.notationMode,firstTop=settings.display.firstSystemPaddingTop;
  for(const [key,values,field,wants]of [['tabRhythm',['hidden','beams','connected','auto'],'rhythmMode',[0,1,2,3]],['fingering',['score','piano','above','abovePiano'],'fingeringMode',[0,1,2,3]]] as const)for(let i=0;i<values.length;i++){const value=defaultEngraving();Object.assign(value.notation,{[key]:values[i]});configureEngraving(settings,value);expect((settings.notation as unknown as Record<string,unknown>)[field]).toBe(wants[i]);}
  const value=defaultEngraving();value.systemSpacing=1.75;value.notation={...value.notation,smallGraceTab:false,extendBendArrows:false,extendLineEffects:true,parenthesizeTiedBends:false,showTiedBendNumbers:false,showDiveWhammyZeros:true};configureEngraving(settings,value);
  expect([settings.notation.smallGraceTabNotes,settings.notation.extendBendArrowsOnTiedNotes,settings.notation.extendLineEffectsToBeatEnd]).toEqual([false,false,true]);expect([11,12,13].map(key=>settings.notation.elements.get(key))).toEqual([false,false,true]);
  expect(settings.display.systemPaddingTop).toBe(defaults.display.systemPaddingTop*1.75);expect(settings.display.systemPaddingBottom).toBe(defaults.display.systemPaddingBottom*1.75);expect(settings.display.lastSystemPaddingBottom).toBe(defaults.display.lastSystemPaddingBottom*1.75);expect(settings.display.firstSystemPaddingTop).toBe(firstTop);
  expect(settings.display.staveProfile).toBe(StaveProfile.Default);expect(settings.display.systemsLayoutMode).toBe(SystemsLayoutMode.UseModelLayout);
  configureEngraving(settings,defaultEngraving());
  expect(settings.notation.rhythmMode).toBe(defaults.notation.rhythmMode);expect(settings.notation.fingeringMode).toBe(defaults.notation.fingeringMode);expect(settings.notation.smallGraceTabNotes).toBe(defaults.notation.smallGraceTabNotes);expect(settings.notation.extendBendArrowsOnTiedNotes).toBe(defaults.notation.extendBendArrowsOnTiedNotes);expect(settings.notation.extendLineEffectsToBeatEnd).toBe(defaults.notation.extendLineEffectsToBeatEnd);
  for(const key of [11,12,13]){expect(settings.notation.elements.has(key)).toBe(defaults.notation.elements.has(key));expect(settings.notation.elements.get(key)).toBe(defaults.notation.elements.get(key));}
  expect(settings.display.systemPaddingTop).toBe(defaults.display.systemPaddingTop);expect(settings.display.systemPaddingBottom).toBe(defaults.display.systemPaddingBottom);expect(settings.display.lastSystemPaddingBottom).toBe(defaults.display.lastSystemPaddingBottom);
  expect(settings.notation.elements.get(NotationElement.ScoreTitle)).toBe(false);expect(settings.notation.notationMode).toBe(mode);expect(settings.notation.rhythmHeight).toBe(47);expect(settings.notation.transpositionPitches).toEqual([12]);expect(settings.notation.displayTranspositionPitches).toEqual([-12]);expect(settings.core).toBe(core);expect(settings.player).toBe(player);expect(settings.display.resources).toBe(resources);expect(settings.core.engine).toBe('svg');
});

it('source_track_maps_follow_surviving_identity_and_validate_before_mutation',()=>{
  const style=music().stylesheet;style.perTrackDisplayTuning=new Map([[0,true],[1,false],[2,true]]);style.perTrackChordDiagramsOnTop=new Map([[1,false]]);style.perTrackMultiBarRest=new Set([1,2]);style.hideDynamics=true;
  remapStylesheetTracks(style,[null,0,1]);expect(style.perTrackDisplayTuning).toEqual(new Map([[0,false],[1,true]]));expect(style.perTrackChordDiagramsOnTop).toEqual(new Map([[0,false]]));expect(style.perTrackMultiBarRest).toEqual(new Set([0,1]));expect(style.hideDynamics).toBe(true);
  remapStylesheetTracks(style,[1,0]);expect(style.perTrackDisplayTuning).toEqual(new Map([[1,false],[0,true]]));expect(style.perTrackChordDiagramsOnTop).toEqual(new Map([[1,false]]));
  const before=[...style.perTrackDisplayTuning];for(const invalid of [[0,0],[-1,0],[0,.5],[0,NaN],[0,2],[0,undefined]]){expect(()=>remapStylesheetTracks(style,invalid as Array<number|null>)).toThrow();expect([...style.perTrackDisplayTuning]).toEqual(before);}
});

it('projectEngraving reports the effective bracket mode',()=>{
  const source=music(),mode=(brackets:EngravingOverrides['stylesheet']['brackets'])=>projectEngraving(source,ids,{...defaultEngraving(),stylesheet:{...defaultEngraving().stylesheet,brackets}}).bracketMode;
  expect(mode('none')).toBe(0);expect(mode('staves')).toBe(1);expect(mode('inherit')).toBe(source.stylesheet.bracketExtendMode);
});
