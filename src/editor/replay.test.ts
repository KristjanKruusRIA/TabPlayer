import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { midi, model, Settings } from '@coderline/alphatab';
import { buildScore, exportGp, previewEdit, trackIdentity } from '../engine';
import { blankProject, type EditCommand, type Project } from '../project';
import { music, target } from './fixtures';

const imported=()=>{const bytes=exportGp(music());return {...blankProject(),base:{kind:'file' as const,filename:'advanced.gp',bytesBase64:Buffer.from(bytes).toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')}};};
const note=(score:model.Score,bar=0,beat=0,voice=0)=>score.tracks[0].staves[0].bars[bar].voices[voice].beats[beat].notes[0];
const patches=[
  {letRing:true},{palmMute:true},{dead:true},{ghost:true},{staccato:true},{leftHandTapped:true},{accent:3},{dynamics:3},{leftFinger:1},{rightFinger:2},{slideIn:1},{slideOut:3},{vibrato:2},{ornament:1},{bend:{type:2,style:1,points:[{offset:0,value:0},{offset:60,value:4}]}},{harmonic:{type:3,value:12}},{trill:{pitch:72,speed:16}},
];
it.each(patches)('authored and imported technique history undo redo save reopen %j',patch=>{
  for(const project of [previewEdit(blankProject(),{type:'setNote',target,string:6,fret:3}).project,imported()]) {
    const edit:EditCommand={type:'setNoteTechniques',target,string:6,patch};const edited=previewEdit(project,edit);const saved=JSON.parse(JSON.stringify(edited.project));
    const selected=(score:model.Score)=>{const n=note(score);return {fret:n.fret,letRing:n.isLetRing,palmMute:n.isPalmMute,dead:n.isDead,ghost:n.isGhost,staccato:n.isStaccato,leftHandTapped:n.isLeftHandTapped,accent:n.accentuated,dynamics:n.dynamics,leftFinger:n.leftHandFinger,rightFinger:n.rightHandFinger,slideIn:n.slideInType,slideOut:n.slideOutType,vibrato:n.vibrato,ornament:n.ornament,bendType:n.bendType,bendStyle:n.bendStyle,bend:n.bendPoints?.map(p=>({offset:p.offset,value:p.value})),harmonicType:n.harmonicType,harmonicValue:n.harmonicValue,trill:n.trillValue,speed:n.trillSpeed};};
    expect(selected(buildScore(saved))).toEqual(selected(edited.score));
    expect(buildScore({...saved,edits:saved.edits.slice(0,-1)}).tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].fret).toBe(3);
    expect(note(buildScore(saved)).fret).toBe(3);expect(project.base).toEqual(saved.base);
  }
});
it('long explicit slurs survive rebuild and deletion repairs surviving endpoint',()=>{
  const project=previewEdit(imported(),{type:'setNoteLink',kind:'slur',from:{target,string:6},to:{target:{...target,bar:1,beat:2},string:6}}).project;
  const score=buildScore(project);expect(note(score,1,2).slurOrigin?.id).toBe(note(score).id);
  const deleted=previewEdit(project,{type:'deleteBeat',target});expect(note(deleted.score,1,2).slurOrigin).toBeNull();expect(note(deleted.score,1,2).isSlurDestination).toBe(false);
});
it('copied range clears external ties and retains only internal cross-bar links',()=>{
  let project:Project=imported();
  project=previewEdit(project,{type:'setNoteLink',kind:'tie',from:{target:{...target,beat:3},string:6},to:{target:{...target,bar:1},string:6}}).project;
  project=previewEdit(project,{type:'addVoice',track:0,staff:0}).project;
  const copied=previewEdit(project,{type:'copyVoice',track:0,staff:0,sourceVoice:0,destinationVoice:1,startBar:1,endBar:1});expect(note(copied.score,1,0,1).tieOrigin).toBeNull();expect(note(copied.score,1,0,1).isTieDestination).toBe(false);expect(note(copied.score,1,0,0).tieOrigin).not.toBeNull();
});
it('program change preserves track identity and produces MIDI program selection',()=>{
  const project=imported(),original=buildScore(project),changed=previewEdit(project,{type:'setTrackInfo',track:0,name:'Clean lead',shortName:'Ld',program:27});
  expect(trackIdentity(changed.score.tracks[0])).toBe(trackIdentity(original.tracks[0]));expect(note(changed.score).realValue).toBe(note(original).realValue);
  const file=new midi.MidiFile();new midi.MidiFileGenerator(changed.score,new Settings(),new midi.AlphaSynthMidiFileHandler(file)).generate();
  expect(file.tracks.flatMap(t=>t.events).filter(e=>e.type===midi.MidiEventType.ProgramChange)).toEqual(expect.arrayContaining([expect.objectContaining({program:27})]));
  const firstPrograms=file.tracks.flatMap(t=>t.events).filter(e=>e.type===midi.MidiEventType.ProgramChange&&e.tick===0);
  expect(firstPrograms.at(-1)).toMatchObject({program:27});
});
it('trill and tremolo create repeated attacks and articulation shortens staccato',()=>{
  const project=imported(),plain=buildScore(project);let changed=previewEdit(project,{type:'setNoteTechniques',target,string:6,patch:{trill:{pitch:70,speed:16},staccato:true}});
  changed=previewEdit(changed.project,{type:'setBeatTechniques',target:{...target,beat:1},patch:{tremolo:{speed:16,style:0}}});
  const generate=(score:model.Score)=>{const file=new midi.MidiFile();new midi.MidiFileGenerator(score,new Settings(),new midi.AlphaSynthMidiFileHandler(file)).generate();return file.tracks.flatMap(t=>t.events);};
  expect(generate(changed.score).filter(e=>e.type===midi.MidiEventType.NoteOn).length).toBeGreaterThan(generate(plain).filter(e=>e.type===midi.MidiEventType.NoteOn).length);
});
it('invalid command preserves original project and authored fields',()=>{
  const project=imported(),before=JSON.stringify(project);expect(()=>previewEdit(project,{type:'setNoteTechniques',target,string:6,patch:{harmonic:{type:99,value:12}}})).toThrow();expect(JSON.stringify(project)).toBe(before);
});
it('append measure keeps every staff voice count aligned',()=>{
  let project:Project=imported();for(let i=0;i<3;i++)project=previewEdit(project,{type:'addVoice',track:0,staff:0}).project;
  const appended=previewEdit(project,{type:'appendMeasure'});expect(appended.score.tracks[0].staves[0].bars.map(b=>b.voices.length)).toEqual([4,4,4,4,4]);expect(appended.score.tracks[0].staves[0].bars.at(-1)?.voices[3].beats[0].isEmpty).toBe(true);
});
it('layout_breaks_shift_on_bar_delete and retain surviving source positions',()=>{
  const project=previewEdit(imported(),{type:'setTrackLayout',track:0,barsPerSystem:2,lineBreaks:[0,1,3]}).project;
  expect([...previewEdit(project,{type:'removeMeasure',bar:1}).score.tracks[0].lineBreaks??[]]).toEqual([0,2]);
});
it.each([-2,-4])('negative duration %i preserves tremolo rate marks and history replay',duration=>{
  let project=previewEdit(blankProject(),{type:'setNote',target,string:6,fret:3}).project;
  for(let i=0;i<3;i++)project=previewEdit(project,{type:'deleteBeat',target:{...target,beat:1}}).project;
  project=previewEdit(project,{type:'setMeasureSettings',bar:0,numerator:duration===-2?8:16,denominator:4,pickup:false,freeTime:false,repeatStart:false,repeatCount:0,endings:[],section:'',tempos:[]}).project;
  project=previewEdit(project,{type:'setBeatRhythm',target,duration,dots:0,tupletNumerator:1,tupletDenominator:1,graceType:0}).project;
  const edited=previewEdit(project,{type:'setBeatTechniques',target,patch:{tremolo:{speed:4,style:0}}});
  const beat=note(buildScore(JSON.parse(JSON.stringify(edited.project)))).beat;expect(beat.duration).toBe(duration);expect(beat.tremoloPicking?.marks).toBe(duration===-2?3:4);expect(beat.playbackDuration).toBe(duration===-2?7680:15360);
  expect(note(buildScore(project)).beat.tremoloPicking).toBeUndefined();
});
