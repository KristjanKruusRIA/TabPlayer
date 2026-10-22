import { expect,it } from 'vitest';
import { exporter,importer,midi,model,Settings } from '@coderline/alphatab';
import { strFromU8,unzipSync } from 'fflate';
import { scoreFromJson } from '../model-clone';
import { music,target } from './fixtures';
import type { GestureCommand,GesturePatch } from './gestures-types';
import { applyGestureEdit } from './gestures';
import { applyNoteLink,applyNoteTechniques } from './techniques';

const settings=new Settings();
const beat=(score:model.Score,bar=0,index=0,track=0)=>score.tracks[track].staves[0].bars[bar].voices[0].beats[index];
const snapshot=(score:model.Score)=>JSON.stringify(model.JsonConverter.scoreToJson(score));
const edit=(score:model.Score,command:unknown)=>applyGestureEdit(score,command as GestureCommand);
const patch=(score:model.Score,value:GesturePatch)=>edit(score,{type:'setBeatGestures',target,patch:value});
const rebuild=(score:model.Score)=>scoreFromJson(model.JsonConverter.scoreToJson(score),settings);
function chord(){const score=music();for(const b of score.tracks[0].staves[0].bars[0].voices[0].beats){b.notes[0].string=1;b.notes[0].fret=0;for(const string of [2,3]){const n=new model.Note();n.string=string;n.fret=0;b.addNote(n);}}score.finish(settings);return score;}
function smf(score:model.Score) {
  const file=new midi.MidiFile();new midi.MidiFileGenerator(score,settings,new midi.AlphaSynthMidiFileHandler(file,true)).generate();
  const bytes=file.toBinary(),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let p=0;
  const ascii=(n:number)=>String.fromCharCode(...bytes.slice(p,p+=n)),u32=()=>{const n=view.getUint32(p);p+=4;return n;},u16=()=>{const n=view.getUint16(p);p+=2;return n;};
  const variable=()=>{let n=0,b;do{b=bytes[p++];n=n*128+(b&127);}while(b&128);return n;};
  expect(ascii(4)).toBe('MThd');expect(u32()).toBe(6);u16();const tracks=u16();expect(u16()).toBe(960);
  const notes:number[][]=[],cc:number[][]=[],tempos:number[][]=[];
  for(let track=0;track<tracks;track++){expect(ascii(4)).toBe('MTrk');const end=p+4+view.getUint32(p);p+=4;let tick=0,status=0;
    while(p<end){tick+=variable();let code=bytes[p++];if(code<128){p--;code=status;}else if(code<240)status=code;
      if(code===255){const type=bytes[p++],length=variable();if(type===81)tempos.push([tick,...bytes.slice(p,p+length)]);p+=length;}
      else if(code===240||code===247){const length=variable();p+=length;}
      else{const kind=code&240,a=bytes[p++],b=kind===192||kind===208?undefined:bytes[p++];if(kind===144&&b)notes.push([tick,a,b,code&15]);if(kind===176)cc.push([tick,a,b!,code&15]);}
    }
  }expect(p).toBe(bytes.length);return {notes,cc,tempos,bytes};
}

it('sets_and_clears_every_finite_beat_gesture',()=>{
  const score=chord(),b=beat(score);b.text='sentinel';const ids=b.notes.map(n=>n.id);
  for(const flag of ['tap','slap','pop','deadSlapped','slashed','showTimer'] as const){patch(score,{[flag]:true});expect(b[flag]).toBe(true);patch(score,{[flag]:false});expect(b[flag]).toBe(false);}
  for(const [field,max] of [['golpe',2],['rasgueado',18],['fade',3],['vibrato',2],['beamingMode',3]] as const)for(let n=0;n<=max;n++){patch(score,{[field]:n});expect(b[field]).toBe(n);}
  for(const shape of [1,2]){patch(score,{barre:{fret:127,shape}});expect([b.barreFret,b.barreShape]).toEqual([127,shape]);}
  patch(score,{barre:null});expect([b.barreFret,b.barreShape]).toEqual([0,0]);
  for(const [stem,preference,inversion]of [['up',0,false],['down',1,false],['inverted',null,true],['auto',null,false]] as const){patch(score,{stem});expect([b.preferredBeamDirection,b.invertBeamDirection]).toEqual([preference,inversion]);}
  b.timer=421;patch(score,{showTimer:true});expect(b.timer).toBeNull();
  expect(b.text).toBe('sentinel');expect(b.notes.map(n=>n.id)).toEqual(ids);
  expect(edit(score,{type:'setScoreInfo',title:''})).toBe(false);
});
it('invalid_patch_is_atomic_and_staff_rules_are_explicit',()=>{
  const score=chord();for(const invalid of [{slap:true,fade:4},{slap:true,golpe:NaN},{slap:true,rasgueado:19},{slap:true,vibrato:-1},{slap:true,beamingMode:.5},{tap:1},{barre:{fret:0,shape:1}},{barre:{fret:2,shape:3}},{barre:{fret:2,shape:1,extra:1}},{stem:'left'},{tap:undefined},{unknown:1},{}]){const before=snapshot(score);expect(()=>patch(score,invalid as never)).toThrow();expect(snapshot(score)).toBe(before);}
  patch(score,{barre:{fret:3,shape:1}});patch(score,{slap:true});expect(beat(score).barreFret).toBe(3);
  const staff=score.tracks[0].staves[0];staff.stringTuning.tunings=[];
  for(const value of [{tap:true},{slap:true},{pop:true},{deadSlapped:true},{golpe:1},{rasgueado:1},{barre:{fret:2,shape:1}}]){const before=snapshot(score);expect(()=>patch(score,value)).toThrow(/string|guitar/i);expect(snapshot(score)).toBe(before);}
  patch(score,{tap:false,slap:false,pop:false,deadSlapped:false,golpe:0,rasgueado:0,barre:null,fade:1,slashed:true});expect(beat(score).barreFret).toBe(0);
  const single=music();expect(()=>patch(single,{rasgueado:1})).toThrow(/string|chord/i);beat(single).notes=[];single.finish(settings);patch(single,{golpe:1});expect(beat(single).golpe).toBe(1);
  staff.isPercussion=true;staff.stringTuning.tunings=[64,59,55,50,45,40];expect(()=>patch(score,{tap:true})).toThrow();
  for(const badTarget of [{...target,beat:99},{...target,beat:NaN},{...target,voice:-1},{...target,extra:0}]){const before=snapshot(score);expect(()=>edit(score,{type:'setBeatGestures',target:badTarget,patch:{fade:1}})).toThrow();expect(snapshot(score)).toBe(before);}
});
it('ottava_range_is_bounded_and_pitch_preserving',()=>{
  const source=music(),staff=source.tracks[0].staves[0];for(const bar of staff.bars){const voice=new model.Voice();for(let i=0;i<4;i++){const b=new model.Beat();b.isEmpty=false;b.duration=4;b.ottava=4;voice.addBeat(b);}bar.addVoice(voice);}source.finish(settings);
  const from={...target,beat:3},to={...target,bar:1,beat:1},control=smf(source).notes.map(n=>n[1]);
  for(let ottava=0;ottava<=4;ottava++){const score=rebuild(source),pitches=score.tracks[0].staves[0].bars.flatMap(bar=>bar.voices[0].beats.map(b=>b.notes[0].realValue));edit(score,{type:'setOttava',from,to,ottava});
    expect(score.tracks[0].staves[0].bars.flatMap(bar=>bar.voices[0].beats.map(b=>b.ottava))).toEqual([2,2,2,ottava,ottava,ottava,2,2,2,2,2,2,2,2,2,2]);
    expect(score.tracks[0].staves[0].bars.flatMap(bar=>bar.voices[1].beats.map(b=>b.ottava))).toEqual(Array(16).fill(4));
    expect(score.tracks[0].staves[0].bars.flatMap(bar=>bar.voices[0].beats.map(b=>b.notes[0].realValue))).toEqual(pitches);expect(smf(rebuild(score)).notes.map(n=>n[1])).toEqual(control);
  }
  for(const bad of [{from:to,to:from},{from,to:{...to,track:1}},{from,to:{...to,staff:1}},{from,to:{...to,voice:1}},{from,to:{...to,beat:99}}]){const before=snapshot(source);expect(()=>edit(source,{type:'setOttava',ottava:1,...bad})).toThrow();expect(snapshot(source)).toBe(before);}
});
it('crescendo_has_exact_target_and_audible_progression',()=>{
  const score=music(),voice=beat(score).voice;for(const b of voice.beats){b.dynamics=2;for(const n of b.notes)n.dynamics=2;}
  const command={type:'setCrescendo',from:target,to:{...target,beat:3},crescendo:1,targetDynamics:6};edit(score,command);
  expect(voice.beats.map(b=>b.dynamics)).toEqual([2,3,5,6]);expect(voice.beats.map(b=>b.notes[0].dynamics)).toEqual([2,3,5,6]);expect(beat(score,1).dynamics).toBe(5);
  expect(smf(rebuild(score)).notes.slice(0,4).map(n=>n[2])).toEqual([47,63,95,111]);
  const xml=strFromU8(unzipSync(new exporter.Gp7Exporter().export(rebuild(score),settings))['Content/score.gpif']);const doc=new DOMParser().parseFromString(xml,'application/xml');
  expect([...doc.querySelectorAll('Beats > Beat > Dynamic')].slice(0,4).map(n=>n.textContent)).toEqual(['P','MP','F','FF']);expect([...doc.querySelectorAll('Beats > Beat > Hairpin')].slice(0,4).map(n=>n.textContent)).toEqual(['Crescendo','Crescendo','Crescendo','Crescendo']);
  edit(score,{...command,crescendo:0,targetDynamics:null});expect(voice.beats.map(b=>b.crescendo)).toEqual([0,0,0,0]);expect(voice.beats.map(b=>b.dynamics)).toEqual([2,3,5,6]);
  for(const b of voice.beats){b.dynamics=6;for(const n of b.notes)n.dynamics=6;}edit(score,{...command,crescendo:2,targetDynamics:2});expect(smf(rebuild(score)).notes.slice(0,4).map(n=>n[2])).toEqual([111,95,63,47]);
});
it('crescendo_uses_onsets_skips_rests_and_rejects_invalid_targets_atomically',()=>{
  const score=music(),voice=beat(score).voice;voice.beats[0].duration=8;voice.beats[1].duration=8;voice.beats[2].duration=2;voice.beats[3].duration=4;voice.beats[1].notes=[];for(const b of voice.beats)b.dynamics=2;score.finish(settings);
  const command={type:'setCrescendo',from:target,to:{...target,beat:3},crescendo:1,targetDynamics:6};edit(score,command);expect(voice.beats.map(b=>b.dynamics)).toEqual([2,2,3,6]);expect(voice.beats.map(b=>b.crescendo)).toEqual([1,1,1,1]);
  for(const invalid of [{crescendo:1,targetDynamics:2},{crescendo:2,targetDynamics:7},{crescendo:0,targetDynamics:0},{crescendo:1,targetDynamics:null},{crescendo:1,targetDynamics:8},{crescendo:1,targetDynamics:NaN},{crescendo:3,targetDynamics:6},{to:target}]){const before=snapshot(score);expect(()=>edit(score,{...command,...invalid})).toThrow();expect(snapshot(score)).toBe(before);}
});
it('fermata_is_global_and_clear_cannot_resurrect',()=>{
  const score=music(),second=rebuild(music()).tracks[0];score.addTrack(second);score.finish(settings);
  edit(score,{type:'setFermata',target:{...target,track:1,beat:1},fermata:{type:2,length:1.5}});const master=score.masterBars[0];
  expect([...master.fermata!].map(([offset,f])=>[offset,f.type,f.length])).toEqual([[960,2,1.5]]);expect(beat(score,0,1).fermata).toBe(master.fermata!.get(960));expect(beat(score,0,1,1).fermata).toBe(master.fermata!.get(960));expect(beat(score).fermata).toBeNull();
  edit(score,{type:'setFermata',target:{...target,beat:1},fermata:null});score.finish(settings);const again=rebuild(score);expect(again.masterBars[0].fermata?.size??0).toBe(0);for(const track of again.tracks)expect(track.staves[0].bars[0].voices[0].beats.every(b=>b.fermata===null)).toBe(true);
  for(const [offset,type,length]of [[0,0,.5],[87,1,1.25],[960,2,2]])master.addFermata(offset,Object.assign(new model.Fermata(),{type,length}));expect([...rebuild(score).masterBars[0].fermata!].map(([offset,f])=>[offset,f.type,f.length])).toEqual([[0,0,.5],[87,1,1.25],[960,2,2]]);
});
it('fermata_rejects_invalid_lengths_and_empty_or_grace_carriers_atomically',()=>{
  const score=music();for(const fermata of [{type:3,length:1},{type:1,length:-1},{type:1,length:NaN},{type:1,length:Infinity},{type:1,length:1,extra:1},{}]){const before=snapshot(score);expect(()=>edit(score,{type:'setFermata',target,fermata})).toThrow();expect(snapshot(score)).toBe(before);}
  beat(score).notes=[];score.finish(settings);edit(score,{type:'setFermata',target,fermata:{type:0,length:.5}});expect(beat(score).fermata?.length).toBe(.5);
  for(const empty of [true,false]){beat(score).isEmpty=empty;beat(score).graceType=empty?0:1;const before=snapshot(score);expect(()=>edit(score,{type:'setFermata',target,fermata:null})).toThrow();expect(snapshot(score)).toBe(before);}
});
it('fermata_accepts_the_zero_length_guitar_pro_stores',()=>{
  const score=music();edit(score,{type:'setFermata',target,fermata:{type:1,length:0}});
  expect(beat(score).fermata?.length).toBe(0);expect(score.masterBars[0].fermata?.get(0)?.length).toBe(0);
});
it('fermata_storage_does_not_claim_an_unsupported_playback_hold',()=>{
  const score=music(),control=smf(score).bytes;edit(score,{type:'setFermata',target:{...target,beat:1},fermata:{type:2,length:2}});expect(smf(rebuild(score)).bytes).toEqual(control);
});
it('fade_and_rasgueado_survive_command_and_rebuild',()=>{
  for(const [fade,first,last]of [[1,[0,7,0,0],[768,7,120,0]],[2,[0,7,120,0],[768,7,0,0]],[3,[0,7,120,0],[864,7,0,0]]]){const score=music();patch(score,{fade:fade as number});const events=smf(rebuild(score)).cc.filter(n=>n[1]===7&&n[3]===0&&n[0]<960);expect(events).toContainEqual(first);expect(events).toContainEqual(last);}
  const score=chord();patch(score,{rasgueado:1});expect(smf(rebuild(score)).notes.filter(n=>n[0]<960).map(n=>n.slice(0,2))).toEqual([[0,40],[60,45],[120,50],[480,50],[540,45],[600,40]]);
  const patterns=['ii_1','mi_1','mii_1','mii_2','pmp_1','pmp_2','pei_1','pei_2','pai_1','pai_2','ami_1','ami_2','ppp_1','amii_1','amip_1','eami_1','eamii_1','peami_1'];
  for(let rasgueado=1;rasgueado<=18;rasgueado++){patch(score,{rasgueado});const rebuilt=rebuild(score),events=smf(rebuilt).notes.filter(n=>n[0]<960);expect(events.length).toBeGreaterThanOrEqual(6);expect(events.every(n=>n.every(Number.isFinite))).toBe(true);expect(events.map(n=>n[0])).toEqual(events.map(n=>n[0]).sort((a,b)=>a-b));const xml=strFromU8(unzipSync(new exporter.Gp7Exporter().export(rebuilt,settings))['Content/score.gpif']);expect(new DOMParser().parseFromString(xml,'application/xml').querySelector('Beats > Beat > Properties > Property[name=Rasgueado] > Rasgueado')?.textContent).toBe(patterns[rasgueado-1]);}
});


it('clearing_global_fermata_clears_first_grace_beat_fallback_references',()=>{
  const score=music(),second=rebuild(music()).tracks[0];score.addTrack(second);const grace=beat(score,0,0,1);grace.graceType=model.GraceType.BeforeBeat;
  score.masterBars[0].addFermata(0,Object.assign(new model.Fermata(),{type:1,length:1}));score.finish(settings);
  expect(grace.playbackStart).toBeLessThan(0);expect(grace.fermata).not.toBeNull();edit(score,{type:'setFermata',target,fermata:null});expect(grace.fermata).toBeNull();score.finish(settings);expect(score.masterBars[0].fermata?.size??0).toBe(0);
});

it('crescendo_rejects_a_tie_continuation_as_a_second_audible_attack',()=>{
  const score=music(),voice=beat(score).voice;for(const b of voice.beats){b.dynamics=2;for(const n of b.notes)n.dynamics=2;}
  applyNoteLink(score,{target,string:6},{target:{...target,beat:1},string:6},'tie');
  expect(smf(rebuild(score)).notes.filter(n=>n[0]<1920).map(n=>n.slice(0,3))).toEqual([[0,67,47]]);
  const before=snapshot(score);expect(()=>edit(score,{type:'setCrescendo',from:target,to:{...target,beat:1},crescendo:1,targetDynamics:6})).toThrow(/two attacks/i);expect(snapshot(score)).toBe(before);
});
it('crescendo_carries_hairpin_over_ties_without_an_inaudible_dynamic_step',()=>{
  const score=music(),voice=beat(score).voice;for(const b of voice.beats){b.dynamics=2;for(const n of b.notes)n.dynamics=2;}
  applyNoteLink(score,{target,string:6},{target:{...target,beat:1},string:6},'tie');edit(score,{type:'setCrescendo',from:target,to:{...target,beat:3},crescendo:1,targetDynamics:6});
  expect(voice.beats.map(b=>b.crescendo)).toEqual([1,1,1,1]);expect(voice.beats.map(b=>b.dynamics)).toEqual([2,2,5,6]);expect(voice.beats.map(b=>b.notes[0].dynamics)).toEqual([2,2,5,6]);
  const rebuilt=rebuild(score);expect(smf(rebuilt).notes.filter(n=>n[0]<3840).map(n=>n.slice(0,3))).toEqual([[0,67,47],[1920,67,95],[2880,67,111]]);expect(beat(rebuilt).notes[0].tieDestination).toBe(beat(rebuilt,0,1).notes[0]);
});
it('crescendo_counts_a_mixed_tied_and_new_note_chord_as_an_audible_attack',()=>{
  const score=music(),voice=beat(score).voice;for(const b of voice.beats){b.dynamics=2;for(const n of b.notes)n.dynamics=2;}
  applyNoteLink(score,{target,string:6},{target:{...target,beat:1},string:6},'tie');const fresh=new model.Note();fresh.string=5;fresh.fret=0;fresh.dynamics=2;voice.beats[1].addNote(fresh);score.finish(settings);
  edit(score,{type:'setCrescendo',from:target,to:{...target,beat:1},crescendo:1,targetDynamics:6});expect(voice.beats.slice(0,2).map(b=>b.dynamics)).toEqual([2,6]);expect(smf(rebuild(score)).notes.filter(n=>n[0]<1920).map(n=>n.slice(0,3))).toEqual([[0,67,47],[960,59,111]]);
});
it('crescendo_rejects_a_legato_slide_continuation_as_a_second_audible_attack',()=>{
  const score=music(),voice=beat(score).voice;for(const b of voice.beats){b.dynamics=2;for(const n of b.notes)n.dynamics=2;}voice.beats[1].notes[0].fret=5;
  applyNoteTechniques(score,{target,string:6},{slideOut:2});expect(smf(rebuild(score)).notes.filter(n=>n[0]<1920).map(n=>n.slice(0,3))).toEqual([[0,67,47]]);
  const before=snapshot(score);expect(()=>edit(score,{type:'setCrescendo',from:target,to:{...target,beat:1},crescendo:1,targetDynamics:6})).toThrow(/two attacks/i);expect(snapshot(score)).toBe(before);
});
it.each([
  {effect:'ornament',apply:(b:model.Beat)=>{b.notes[0].ornament=model.NoteOrnament.UpperMordent;},keys:[69,71,69],ticks:[960,1080,1200],velocities:[95,95,95]},
  {effect:'trill',apply:(b:model.Beat)=>{b.notes[0].trillValue=71;b.notes[0].trillSpeed=16;},keys:[69,71,69,71],ticks:[960,1200,1440,1680],velocities:[111,111,111,111]},
  {effect:'tremolo',apply:(b:model.Beat)=>{b.tremoloPicking=new model.TremoloPickingEffect();b.tremoloPicking.marks=2;},keys:[69,69,69,69],ticks:[960,1200,1440,1680],velocities:[111,111,111,111]},
  {effect:'rasgueado',apply:(b:model.Beat)=>{b.rasgueado=model.Rasgueado.Ii;},keys:[69,69],ticks:[960,1440],velocities:[111,111]},
])('crescendo counts $effect retriggers on legato slide continuations',({apply,keys,ticks,velocities})=>{
  const score=music(),voice=beat(score).voice;for(const b of voice.beats){b.dynamics=2;for(const n of b.notes)n.dynamics=2;}voice.beats[1].notes[0].fret=5;applyNoteTechniques(score,{target,string:6},{slideOut:2});apply(voice.beats[1]);
  const before=smf(rebuild(score)).notes.filter(n=>n[0]>=960&&n[0]<1920);expect(before.map(n=>n[0])).toEqual(ticks);expect(before.map(n=>n[1])).toEqual(keys);expect(before.map(n=>n[2])).toEqual(velocities.map(value=>value-64));
  expect(()=>edit(score,{type:'setCrescendo',from:target,to:{...target,beat:1},crescendo:1,targetDynamics:6})).not.toThrow();expect(voice.beats.slice(0,2).map(b=>b.dynamics)).toEqual([2,6]);
  const after=smf(rebuild(score)).notes.filter(n=>n[0]>=960&&n[0]<1920);expect(after.map(n=>n[0])).toEqual(ticks);expect(after.map(n=>n[1])).toEqual(keys);expect(after.map(n=>n[2])).toEqual(velocities);
});
it.each([
  {effect:'ornament',apply:(b:model.Beat)=>{b.notes[0].ornament=model.NoteOrnament.UpperMordent;},keys:[67,69,67],ticks:[960,1080,1200],velocities:[95,95,95]},
  {effect:'trill',apply:(b:model.Beat)=>{b.notes[0].trillValue=69;b.notes[0].trillSpeed=16;},keys:[67,69,67,69],ticks:[960,1200,1440,1680],velocities:[111,111,111,111]},
  {effect:'tremolo',apply:(b:model.Beat)=>{b.tremoloPicking=new model.TremoloPickingEffect();b.tremoloPicking.marks=2;},keys:[67,67,67,67],ticks:[960,1200,1440,1680],velocities:[111,111,111,111]},
  {effect:'rasgueado',apply:(b:model.Beat)=>{b.rasgueado=model.Rasgueado.Ii;},keys:[67,67],ticks:[960,1440],velocities:[111,111]},
])('crescendo counts $effect retriggers on tied continuations',({apply,keys,ticks,velocities})=>{
  const score=music(),voice=beat(score).voice;for(const b of voice.beats){b.dynamics=2;for(const n of b.notes)n.dynamics=2;}applyNoteLink(score,{target,string:6},{target:{...target,beat:1},string:6},'tie');apply(voice.beats[1]);
  const before=smf(rebuild(score)).notes.filter(n=>n[0]>=960&&n[0]<1920);expect(before.map(n=>n[0])).toEqual(ticks);expect(before.map(n=>n[1])).toEqual(keys);expect(before.map(n=>n[2])).toEqual(velocities.map(value=>value-64));
  expect(()=>edit(score,{type:'setCrescendo',from:target,to:{...target,beat:1},crescendo:1,targetDynamics:6})).not.toThrow();expect(voice.beats.slice(0,2).map(b=>b.dynamics)).toEqual([2,6]);
  const after=smf(rebuild(score)).notes.filter(n=>n[0]>=960&&n[0]<1920);expect(after.map(n=>n[0])).toEqual(ticks);expect(after.map(n=>n[1])).toEqual(keys);expect(after.map(n=>n[2])).toEqual(velocities);
});

it.each(['both','last'] as const)('crescendo_rejects_%s_dead_slap_beats_as_dynamic_controlled_attacks',mode=>{
  const score=music(),voice=beat(score).voice;for(const b of voice.beats){b.dynamics=2;for(const n of b.notes)n.dynamics=2;}voice.beats[1].deadSlapped=true;voice.beats[1].notes[0].ornament=model.NoteOrnament.UpperMordent;if(mode==='both')voice.beats[0].deadSlapped=true;
  const notes=smf(rebuild(score)).notes.filter(n=>n[0]>=960&&n[0]<1920);expect(notes.map(n=>n.slice(0,3))).toEqual([[960,64,95],[960,59,95],[960,55,95],[960,50,95],[960,45,95],[960,40,95]]);
  const before=snapshot(score);expect(()=>edit(score,{type:'setCrescendo',from:target,to:{...target,beat:1},crescendo:1,targetDynamics:6})).toThrow(/two attacks controlled by dynamics/i);expect(snapshot(score)).toBe(before);
});
it('crescendo_preserves_dead_slap_notes_and_hairpin_without_assigning_them_target_dynamics',()=>{
  const score=music(),voice=beat(score).voice;for(const b of voice.beats){b.dynamics=2;for(const n of b.notes)n.dynamics=2;}voice.beats[1].deadSlapped=true;voice.beats[3].deadSlapped=true;const ids=voice.beats.map(b=>b.notes.map(n=>n.id));
  edit(score,{type:'setCrescendo',from:target,to:{...target,beat:3},crescendo:1,targetDynamics:6});expect(voice.beats.map(b=>b.dynamics)).toEqual([2,2,6,2]);expect(voice.beats.map(b=>b.crescendo)).toEqual([1,1,1,1]);expect(voice.beats.map(b=>b.notes.map(n=>n.id))).toEqual(ids);expect(voice.beats.map(b=>b.deadSlapped)).toEqual([false,true,false,true]);
  const events=smf(rebuild(score)).notes.filter(n=>n[0]<3840);expect(events.filter(n=>n[0]===0||n[0]===1920).map(n=>n.slice(0,3))).toEqual([[0,67,47],[1920,67,111]]);expect(events.filter(n=>n[0]===960||n[0]===2880).map(n=>n[2])).toEqual([95,95,95,95,95,95,95,95,95,95,95,95]);
});
it('wah_pedal_gesture_sets_open_closed_and_none_and_round_trips_through_gp',()=>{
  const score=music();patch(score,{wahPedal:1});expect(beat(score).wahPedal).toBe(model.WahPedal.Open);
  patch(score,{wahPedal:2});expect(beat(score).wahPedal).toBe(model.WahPedal.Closed);
  const gpif=strFromU8(unzipSync(new exporter.Gp7Exporter().export(score,settings))['Content/score.gpif']);
  expect(gpif).toContain('<Wah>Closed</Wah>');
  expect(rebuild(score).tracks[0].staves[0].bars[0].voices[0].beats[0].wahPedal).toBe(model.WahPedal.Closed);
  patch(score,{wahPedal:1});const reloaded=importer.ScoreLoader.loadScoreFromBytes(new exporter.Gp7Exporter().export(score,settings),settings);
  expect(reloaded.tracks[0].staves[0].bars[0].voices[0].beats[0].wahPedal).toBe(model.WahPedal.Open);
  patch(score,{wahPedal:0});expect(beat(score).wahPedal).toBe(model.WahPedal.None);
  // Like other guitar gestures, wah is refused on percussion and notation-only staves, which clipboard conversion can't carry.
  const drums=music();drums.tracks[0].staves[0].isPercussion=true;const before=snapshot(drums);expect(()=>patch(drums,{wahPedal:1})).toThrow(/stringed/);expect(snapshot(drums)).toBe(before);
  for(const wahPedal of [3,-1,1.5,'1']){const before=snapshot(score);expect(()=>patch(score,{wahPedal} as unknown as GesturePatch)).toThrow(/wahPedal/);expect(snapshot(score)).toBe(before);}
});
