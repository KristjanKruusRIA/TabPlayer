import { expect, it, vi } from 'vitest';
import { midi, model, Settings } from '@coderline/alphatab';
import { createHash } from 'node:crypto';
import { buildScore, exportGp } from '../engine';
import { buildPlaybackPlan, buildPlaybackPlanFromJson, deadBrushMidiDurations, prepareMidiScore, preparePlan, validatePlaybackPlan } from './plan';
import { blankProject } from '../project';

const settings = new Settings();
function authored(bars = 2, voices = 1, tracks = 1) {
  const score = new model.Score();
  for (let b = 0; b < bars; b++) score.addMasterBar(new model.MasterBar());
  score.masterBars[0].tempoAutomations = [model.Automation.buildTempoAutomation(false, 0, 120, 2)];
  for (let t = 0; t < tracks; t++) {
    const track = new model.Track(); track.playbackInfo.program = 25; track.playbackInfo.primaryChannel = t * 2; track.playbackInfo.secondaryChannel = t * 2 + 1;
    const staff = new model.Staff(); staff.stringTuning.tunings = [64, 59, 55, 50, 45, 40]; track.addStaff(staff); score.addTrack(track);
    for (let b = 0; b < bars; b++) {
      const bar = new model.Bar(); staff.addBar(bar);
      for (let v = 0; v < voices; v++) {
        const voice = new model.Voice(); bar.addVoice(voice);
        for (let i = 0; i < 4; i++) { const beat = new model.Beat(); beat.duration = model.Duration.Quarter; beat.isEmpty = false; voice.addBeat(beat); }
      }
    }
  }
  return score;
}
function note(score: model.Score, bar: number, beat: number, string = 1, fret = 3, voice = 0, track = 0) {
  const n = new model.Note(); n.string = string; n.fret = fret;
  score.tracks[track].staves[0].bars[bar].voices[voice].beats[beat].addNote(n); return n;
}
function agree(score: model.Score) {
  const plan = buildPlaybackPlan(score, 7), file = new midi.MidiFile();
  new midi.MidiFileGenerator(score, settings, new midi.AlphaSynthMidiFileHandler(file)).generate();
  const expected = file.tracks.flatMap(t => t.events).filter(e => e.type === midi.MidiEventType.NoteOn).map(e => { const n = e as midi.NoteOnEvent; return [n.tick, n.noteKey, n.noteVelocity]; }).sort();
  expect(plan.notes.map(n => [n.startTick, n.key, n.velocity]).sort()).toEqual(expected);
  const offs = file.tracks.flatMap(t => t.events).filter(e => e.type === midi.MidiEventType.NoteOff).map(e => { const n = e as midi.NoteOffEvent; return [n.tick, n.noteKey, n.noteVelocity]; }).sort();
  expect(plan.notes.map(n => [n.endTick, n.key, n.velocity]).sort()).toEqual(offs);
  expect(new Set(plan.notes.map(n => n.id)).size).toBe(plan.notes.length);
  expect(plan.generation).toBe(7); expect(plan.ppq).toBe(960); return plan;
}

it('same_pitch_different_voice_keeps_identity', () => {
  const score = authored(2, 2); note(score, 0, 0, 1, 3, 0); note(score, 0, 0, 1, 3, 1); score.finish(settings);
  const plan = agree(score); expect(plan.notes).toHaveLength(2);
  expect(plan.notes.map(n => n.source.target.voice).sort()).toEqual([0, 1]);
  expect(plan.notes[0].key).toBe(plan.notes[1].key); expect(plan.notes[0].id).not.toBe(plan.notes[1].id);
});

it('attacks_crossing_bar_boundaries_retain_authored_beat_identity', () => {
  const score = authored(2, 1, 2), voice = score.tracks[0].staves[0].bars[0].voices[0];
  const extra = new model.Beat(); extra.duration = model.Duration.Quarter; extra.isEmpty = false; voice.addBeat(extra);
  for (let beat=0;beat<5;beat++) note(score, 0, beat, 1, 3);
  note(score, 1, 0, 1, 3); note(score, 0, 0, 1, 3, 0, 1);
  score.finish(settings); const plan = agree(score);
  expect(plan.notes.filter(n=>n.source.target.track===0&&n.source.target.bar===0).map(n=>n.source.target.beat)).toEqual([0,1,2,3,4]);
});

it('provenance_survives_long_skipped_empty_voice_sections', () => {
  const score=authored(129,2);
  for(const bar of score.tracks[0].staves[0].bars){const voice=bar.voices[1];voice.beats.splice(1);voice.beats[0].duration=model.Duration.Whole;voice.beats[0].isEmpty=bar.index>0&&bar.index<128;}
  note(score,0,0,1,3,1);note(score,128,0,1,3,1);score.finish(settings);
  const plan=agree(score);expect(plan.notes.map(n=>n.source.target.bar)).toEqual([0,128]);
});

it('initial_grace_in_another_voice_preserves_full_score_tick_shift', () => {
  const score=authored(2,2,2), voice=score.tracks[0].staves[0].bars[0].voices[0];
  const grace=new model.Beat();grace.duration=model.Duration.Eighth;grace.graceType=model.GraceType.BeforeBeat;grace.isEmpty=false;
  const n=new model.Note();n.string=1;n.fret=3;grace.addNote(n);grace.voice=voice;voice.beats.unshift(grace);
  note(score,0,0,1,3,1);const bent=note(score,0,0,1,3,0,1);bent.addBendPoint(new model.BendPoint(0,0));bent.addBendPoint(new model.BendPoint(60,4));
  score.finish(settings);const plan=agree(score);
  expect(plan.notes.find(n=>n.source.target.voice===1)?.startTick).toBe(120);
  const other=plan.notes.find(n=>n.source.target.track===1)!;expect(other.startTick).toBe(120);expect(Math.max(...other.pitch.map(p=>p.semitones))).toBe(2);
});

it('worker_json_preserves_explicit_nonadjacent_phrase_origin', () => {
  for(const string of [1,2]) {
    const score=authored(), a=note(score,0,0,1,3), b=note(score,0,1,1,5), c=note(score,0,2,string,7);
    score.finish(settings); a.slurDestination=c;c.slurOrigin=a;c.isSlurDestination=true;
    const json=model.JsonConverter.scoreToJson(score), clone=model.JsonConverter.jsonToScore(json,settings);
    expect(clone.tracks[0].staves[0].bars[0].voices[0].beats[2].notes[0].slurOrigin?.id).toBe(a.id);
    const expected=buildPlaybackPlan(score,19), actual=buildPlaybackPlanFromJson(json,expected.tracks.map(t=>t.id),19);
    if(string===1)expect(actual.notes.find(n=>n.source.target.beat===2)?.legatoFrom).toBe(actual.notes.find(n=>n.source.target.beat===0)?.id);
    expect(actual).toEqual(expected);expect(b.slurOrigin).toBeNull();
  }
});

it('imported_logical_channels_are_mapped_to_native_midi_channels', () => {
  const score=authored(), track=score.tracks[0];track.playbackInfo.primaryChannel=16;track.playbackInfo.secondaryChannel=17;
  note(score,0,0);const bent=note(score,0,1);bent.addBendPoint(new model.BendPoint(0,0));bent.addBendPoint(new model.BendPoint(60,4));
  score.finish(settings);const plan=agree(score);
  expect(new Set(plan.midi.map(e=>e.channel))).toEqual(new Set([0,1]));
  expect(Math.max(...plan.notes[1].pitch.map(p=>p.semitones))).toBe(2);
  expect(track.playbackInfo.primaryChannel).toBe(16);expect(track.playbackInfo.secondaryChannel).toBe(17);
});

it('logical_channel_collisions_remain_distinct_and_percussion_keeps_channel_nine', () => {
  const score=authored(2,1,2), a=score.tracks[0], drums=score.tracks[1];
  a.playbackInfo.primaryChannel=0;a.playbackInfo.secondaryChannel=16;
  note(score,0,0);const n=note(score,0,1);n.addBendPoint(new model.BendPoint(0,0));n.addBendPoint(new model.BendPoint(60,4));
  drums.staves[0].isPercussion=true;drums.staves[0].stringTuning.tunings=[];drums.playbackInfo.primaryChannel=9;drums.playbackInfo.secondaryChannel=9;
  const drum=new model.Note();drum.percussionArticulation=38;drums.staves[0].bars[0].voices[0].beats[0].addNote(drum);
  score.finish(settings);const plan=agree(score);
  expect(new Set(plan.midi.filter(e=>e.trackId===plan.tracks[0].id).map(e=>e.channel))).toEqual(new Set([0,1]));
  expect(new Set(plan.midi.filter(e=>e.trackId===plan.tracks[1].id).map(e=>e.channel))).toEqual(new Set([9]));
  expect(Math.max(...plan.notes.find(n=>n.source.target.beat===1)!.pitch.map(p=>p.semitones))).toBe(2);
});

it('dead_brush_negative_duration_uses_public_unbrushed_duration_after_delayed_attack', () => {
  const score=authored(), early=note(score,0,0,1), late=note(score,0,0,6);early.isDead=late.isDead=true;
  early.beat.brushType=model.BrushType.BrushDown;early.beat.brushDuration=120;score.finish(settings);
  const file=new midi.MidiFile();new midi.MidiFileGenerator(score,settings,new midi.AlphaSynthMidiFileHandler(file)).generate();
  const ons=file.tracks.flatMap(t=>t.events).filter(e=>e.type===midi.MidiEventType.NoteOn) as midi.NoteOnEvent[];
  const offs=file.tracks.flatMap(t=>t.events).filter(e=>e.type===midi.MidiEventType.NoteOff) as midi.NoteOffEvent[];
  expect(offs.some(off=>off.tick<ons.find(on=>on.noteKey===off.noteKey)!.tick)).toBe(true);
  const unbrushed=model.JsonConverter.jsonToScore(model.JsonConverter.scoreToJson(score),settings);unbrushed.tracks[0].staves[0].bars[0].voices[0].beats[0].brushType=model.BrushType.None;
  const plain=agree(unbrushed), plan=buildPlaybackPlan(score,7);
  expect(plan.notes.map(n=>[n.startTick,n.key,n.velocity]).sort()).toEqual(ons.map(n=>[n.tick,n.noteKey,n.noteVelocity]).sort());
  for(const n of plan.notes) {const off=offs.find(e=>e.noteKey===n.key)!;expect(n.endTick).toBe(off.tick>n.startTick?off.tick:n.startTick+plain.notes.find(p=>p.key===n.key)!.endTick);}
  expect(plan.midi.filter(e=>e.type==='noteOff').map(e=>e.tick).sort()).toEqual(plan.notes.map(n=>n.endTick).sort());
  expect(early.beat.brushDuration).toBe(120);expect(early.beat.brushType).toBe(model.BrushType.BrushDown);
});

it('dead_brush_adapter_uses_public_callback_ordinals_per_track', () => {
  const score=authored(2,1,2);
  note(score,0,0);note(score,1,0);note(score,0,0,1,3,0,1);
  const a=note(score,1,0,1,3,0,1),b=note(score,1,0,6,3,0,1);a.isDead=b.isDead=true;a.beat.brushType=model.BrushType.BrushDown;a.beat.brushDuration=120;
  score.finish(settings);const counts=new Map<number,number>(),expected:{track:number;attack:number;length:number}[]=[];
  class Reference extends midi.AlphaSynthMidiFileHandler {
    override addNote(track:number,start:number,length:number,key:number,velocity:number,channel:number){const attack=counts.get(track)??0;counts.set(track,attack+1);if(length<=0)expected.push({track,attack,length:60});super.addNote(track,start,length,key,velocity,channel);}
  }
  new midi.MidiFileGenerator(score,settings,new Reference(new midi.MidiFile())).generate();
  expect(expected).toHaveLength(1);expect(expected[0].track).toBe(1);expect(expected[0].attack).toBeGreaterThan(0);
  expect(deadBrushMidiDurations(score)).toEqual(expected);
});

it('brushed_independent_bend_points_match_public_generator', () => {
  const score = authored(); const a = note(score, 0, 0, 1), b = note(score, 0, 0, 2);
  a.beat.brushType = model.BrushType.BrushUp; a.beat.brushDuration = 120;
  for (const [n, value] of [[a, 4], [b, 8]] as const) { n.addBendPoint(new model.BendPoint(0, 0)); n.addBendPoint(new model.BendPoint(60, value)); }
  score.finish(settings); const plan = agree(score), file = new midi.MidiFile();
  new midi.MidiFileGenerator(score, settings, new midi.AlphaSynthMidiFileHandler(file)).generate();
  for (const n of plan.notes) {
    const expected = file.tracks.flatMap(t => t.events).filter(e => e.type === midi.MidiEventType.PerNotePitchBend && (e as midi.NoteBendEvent).noteKey === n.key && e.tick >= n.startTick && e.tick <= n.endTick);
    for (const event of expected) {
      const value = ((event as midi.NoteBendEvent).value / 4294967296 - .5) * 32;
      const exact = n.pitch.find(p => Math.abs(p.tick - event.tick) < .001);
      expect(exact?.semitones).toBeCloseTo(value, 5);
    }
  }
});

it('equal_pitch_different_strings_keep_independent_bend_points', () => {
  const score = authored(); const a = note(score, 0, 0, 1, 10), b = note(score, 0, 0, 2, 5);
  for (const [n, value] of [[a, 4], [b, 8]] as const) { n.addBendPoint(new model.BendPoint(0, 0)); n.addBendPoint(new model.BendPoint(60, value)); }
  score.finish(settings); const plan = agree(score);
  expect(plan.notes[0].key).toBe(plan.notes[1].key);
  expect(plan.notes[0].source.string).not.toBe(plan.notes[1].source.string);
  expect(plan.notes.map(n => Math.max(...n.pitch.map(p => p.semitones))).sort()).toEqual([2, 4]);
});

it('independent_string_bend_curves', () => {
  const score = authored(); const a = note(score, 0, 0, 1), b = note(score, 0, 0, 2);
  for (const [n, value] of [[a, 4], [b, 8]] as const) { n.addBendPoint(new model.BendPoint(0, 0)); n.addBendPoint(new model.BendPoint(60, value)); }
  score.finish(settings); const plan = agree(score);
  expect(plan.notes[0].pitch).not.toEqual(plan.notes[1].pitch);
  expect(plan.notes.map(n => Math.max(...n.pitch.map(p => p.semitones))).sort()).toEqual([2, 4]);
});

it('repeats_endings_tempo_grace_brush_tremolo', () => {
  const score = authored(3); score.masterBars[0].isRepeatStart = true; score.masterBars[1].repeatCount = 2;
  score.masterBars[1].alternateEndings = 1; score.masterBars[2].alternateEndings = 2;
  score.masterBars[1].tempoAutomations = [model.Automation.buildTempoAutomation(false, 0, 90, 2)];
  const a = note(score, 0, 0, 1), b = note(score, 0, 0, 2); a.beat.brushType = model.BrushType.BrushDown; a.beat.brushDuration = 120;
  note(score, 0, 1).beat.tremoloSpeed = model.Duration.Sixteenth;
  const trill = note(score, 1, 0); trill.trillValue = trill.stringTuning + 5; trill.trillSpeed = model.Duration.Sixteenth;
  const voice = b.beat.voice; const grace = new model.Beat(); grace.duration = model.Duration.Eighth; grace.graceType = model.GraceType.BeforeBeat; grace.isEmpty = false;
  const gn = new model.Note(); gn.string = 3; gn.fret = 2; grace.addNote(gn); grace.voice = voice; voice.beats.splice(0, 0, grace);
  note(score, 2, 0); score.rebuildRepeatGroups(); score.finish(settings); const plan = agree(score);
  expect(plan.occurrences.map(o => o.bar)).toEqual([0, 1, 0, 2]);
  expect(plan.tempos.some(t => t.bpm === 90)).toBe(true);
  expect(plan.notes.some(n => n.startTick === 0)).toBe(true);
  expect(plan.notes.filter(n => n.source.target.bar === 0 && n.source.target.beat === 1 && n.occurrence === 0).map(n => n.startTick).sort((x,y) => x-y)).toEqual([120, 240]);
});

it('tie_and_legato_voice_chain', () => {
  const score = authored(); const origin = note(score, 0, 0), tied = note(score, 0, 1), hammer = note(score, 0, 2, 1, 5);
  origin.tieDestination = tied; tied.tieOrigin = origin; tied.isTieDestination = true;
  tied.isHammerPullOrigin = true; tied.hammerPullDestination = hammer; hammer.hammerPullOrigin = tied;
  score.finish(settings); const plan = agree(score); expect(plan.notes).toHaveLength(2);
  expect(plan.notes[0].endTick).toBe(1920); expect(plan.notes[1].legatoFrom).toBe(plan.notes[0].id); expect(plan.notes[1].articulation).toBe('legato');
});

it('100_bar_four_track_schedule_agrees_with_public_generator', () => {
  const score = authored(100, 1, 4);
  for (let t = 0; t < 4; t++) for (let bar = 0; bar < 100; bar++) for (let b = 0; b < 4; b++) {
    const n = note(score, bar, b, (b % 3) + 1, b, 0, t); n.beat.tupletNumerator = 3; n.beat.tupletDenominator = 2;
  }
  score.finish(settings); const start = performance.now(); const plan = agree(score);
  expect(plan.notes).toHaveLength(1600); console.info(`100-bar/four-track plan: ${(performance.now()-start).toFixed(0)} ms`);
}, 20000);

it('gm_percussion_and_piano_chords_keep_full_stream_and_identity', () => {
  for (const percussion of [false, true]) {
    const score = authored(); const staff = score.tracks[0].staves[0]; staff.isPercussion = percussion; staff.stringTuning.tunings = [];
    if (percussion) { score.tracks[0].playbackInfo.primaryChannel = 9; score.tracks[0].playbackInfo.secondaryChannel = 9; }
    const beat = staff.bars[0].voices[0].beats[0];
    for (let i=0;i<2;i++) { const n=new model.Note(); if(percussion)n.percussionArticulation=38;else {n.octave=5;n.tone=4;} beat.addNote(n); }
    score.finish(settings); const plan = agree(score); expect(plan.notes).toHaveLength(2); expect(plan.notes[0].id).not.toBe(plan.notes[1].id);
    expect(plan.tracks[0].percussion).toBe(percussion); expect(plan.midi.filter(e=>e.type==='noteOn')).toHaveLength(2);
  }
});

it('channel_whammy_and_vibrato_use_the_complete_chord_clock', () => {
  const score=authored(); const a=note(score,0,0,1),b=note(score,0,0,2); a.beat.brushType=model.BrushType.BrushUp;a.beat.brushDuration=120;
  a.beat.addWhammyBarPoint(new model.BendPoint(0,0)); a.beat.addWhammyBarPoint(new model.BendPoint(60,-4));
  note(score,0,1,1).beat.vibrato=model.VibratoType.Slight; note(score,0,1,2);
  score.finish(settings); const plan=agree(score);
  for(const n of plan.notes) {
    const on=plan.midi.find(e=>e.type==='noteOn'&&e.key===n.key&&e.tick===n.startTick)!;
    const atTicks=new Map(plan.midi.filter(e=>e.type==='bend'&&e.channel===on.channel&&e.tick>=n.startTick&&e.tick<=n.endTick).map(e=>[e.tick,e]));
    for(const e of atTicks.values()) {
      const p=n.pitch.find(p=>Math.abs(p.tick-e.tick)<.001); expect(p?.semitones).toBeCloseTo((e as Extract<typeof e,{type:'bend'}>).value,5);
    }
  }
  expect(b.beat).toBe(a.beat);
});

it('rejects_invalid_midi_track_source_and_times_before_native_installation', () => {
  const score=authored();note(score,0,0);score.finish(settings);const valid=buildPlaybackPlan(score,1);
  for(const corrupt of [
    (p:typeof valid)=>{p.tracks.push({...p.tracks[0]});},
    (p:typeof valid)=>{p.notes[0].source.target.track=9;},
    (p:typeof valid)=>{p.midi[0].channel=16;},
    (p:typeof valid)=>{p.midi[0].tick=NaN;},
    (p:typeof valid)=>{p.tempos=[];},
  ]) { const p=structuredClone(valid);corrupt(p);expect(()=>validatePlaybackPlan(p)).toThrow(/Invalid native/); }
});

it('prepares_native_metadata_project_without_audio_asset_bytes', async () => {
  const plan=await preparePlan(blankProject(),11);expect(plan.generation).toBe(11);expect(plan.tracks[0].id).toBe('base/0');expect(plan.notes).toHaveLength(0);
});

it('simile_copies_keep_authored_source_and_distinct_played_occurrences', () => {
  const score=authored(4);note(score,0,0,1);note(score,0,1,2);
  score.tracks[0].staves[0].bars[1].simileMark=model.SimileMark.Simple;
  score.tracks[0].staves[0].bars[2].simileMark=model.SimileMark.FirstOfDouble;
  score.tracks[0].staves[0].bars[3].simileMark=model.SimileMark.SecondOfDouble;
  score.masterBars[0].isRepeatStart=true;score.masterBars[3].repeatCount=2;score.rebuildRepeatGroups();score.finish(settings);
  const plan=agree(score);expect(plan.notes).toHaveLength(16);
  expect(plan.notes.every(n=>n.source.target.bar===0)).toBe(true);
  expect(new Set(plan.notes.filter(n=>n.playedBar!==undefined).map(n=>n.playedBar))).toEqual(new Set([1,2,3]));
  expect(plan.notes.filter(n=>n.playedBar===3).map(n=>n.occurrence)).toEqual([0,0,1,1]);
});

it('worker_input_keeps_stable_track_ids_and_legato_links', () => {
  const score=authored();const a=note(score,0,0),b=note(score,0,1,1,5);
  a.isHammerPullOrigin=true;a.hammerPullDestination=b;b.hammerPullOrigin=a;score.finish(settings);
  const json=model.JsonConverter.scoreToJson(score);
  const plan=buildPlaybackPlanFromJson(json,['added/3/stable-track'],18);
  expect(plan.generation).toBe(18);expect(plan.tracks[0].id).toBe('added/3/stable-track');
  expect(plan.notes.every(n=>n.id.startsWith('added/3/stable-track/')&&n.trackId==='added/3/stable-track')).toBe(true);
  expect(plan.notes[1].legatoFrom).toBe(plan.notes[0].id);
  expect(()=>buildPlaybackPlanFromJson(json,[],18)).toThrow(/track identities/);
});

it('odd_swung_voices_agree_with_full_public_generation_state', () => {
  const score=authored(1,2);score.masterBars[0].timeSignatureNumerator=3;score.masterBars[0].timeSignatureDenominator=8;score.masterBars[0].tripletFeel=model.TripletFeel.Triplet8th;
  for(const voice of score.tracks[0].staves[0].bars[0].voices) {voice.beats.splice(3);for(const b of voice.beats)b.duration=model.Duration.Eighth;}
  for(let v=0;v<2;v++)for(let b=0;b<3;b++)note(score,0,b,1,b,v);
  score.finish(settings);agree(score);
});

it('authored_gp_import_keeps_tie_tuplet_hammer_and_slide_schedule', () => {
  const score=authored();const a=note(score,0,0),b=note(score,0,1),c=note(score,0,2,1,5),d=note(score,0,3,1,7);
  a.tieDestination=b;b.tieOrigin=a;b.isTieDestination=true;
  b.isHammerPullOrigin=true;b.hammerPullDestination=c;c.hammerPullOrigin=b;
  c.slideOutType=model.SlideOutType.Legato;c.slideTarget=d;d.slideOrigin=c;
  for(const beat of a.beat.voice.beats){beat.tupletNumerator=3;beat.tupletDenominator=2;}
  score.finish(settings);const bytes=exportGp(score);
  const project={...blankProject(),base:{kind:'file' as const,filename:'authored-plan.gp',bytesBase64:Buffer.from(bytes).toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')}};
  const imported=buildScore(project),plan=agree(imported);expect(plan.notes).toHaveLength(2);
  expect(plan.notes[0].endTick).toBe(1280);expect(plan.notes[1].endTick).toBe(2560);expect(plan.notes[1].legatoFrom).toBe(plan.notes[0].id);
  expect(Math.max(...plan.notes[1].pitch.map(p=>p.semitones))).toBeGreaterThan(1.9);
});

it('tied_equal_pitch_string_bends_keep_continuous_independent_segments', () => {
  const score=authored();
  for(const [string,fret,value] of [[1,10,4],[2,5,8]]) {
    const a=note(score,0,0,string,fret),b=note(score,0,1,string,fret);
    a.tieDestination=b;b.tieOrigin=a;b.isTieDestination=true;
    a.addBendPoint(new model.BendPoint(0,0));a.addBendPoint(new model.BendPoint(60,value));
    b.addBendPoint(new model.BendPoint(0,value));b.addBendPoint(new model.BendPoint(60,value+2));b.isContinuedBend=true;
  }
  score.finish(settings);const plan=agree(score);expect(plan.notes).toHaveLength(2);expect(plan.notes.every(n=>n.endTick===1920)).toBe(true);
  expect(plan.notes.map(n=>Math.max(...n.pitch.map(p=>p.semitones))).sort()).toEqual([3,5]);
  expect(plan.notes.every(n=>n.pitch.some(p=>p.tick>=960&&p.tick<=1920))).toBe(true);
});

it('cross_string_phrase_slurs_do_not_merge_independent_string_voices', () => {
  const score=authored();const a=note(score,0,0,1),b=note(score,0,1,2);
  a.slurDestination=b;b.slurOrigin=a;b.isSlurDestination=true;score.finish(settings);
  const plan=agree(score);expect(plan.notes[1].legatoFrom).toBeNull();
});

it('picked_fingered_tapped_and_harmonic_articulations_are_explicit', () => {
  const score=authored();score.tracks[0].playbackInfo.program=33;
  const picked=note(score,0,0),fingered=note(score,0,1),tapped=note(score,0,2),harmonic=note(score,0,3);
  picked.beat.pickStroke=model.PickStroke.Down;fingered.rightHandFinger=model.Fingers.IndexFinger;tapped.isLeftHandTapped=true;harmonic.harmonicType=model.HarmonicType.Natural;harmonic.harmonicValue=12;
  score.finish(settings);const plan=agree(score);expect(plan.notes.map(n=>n.articulation)).toEqual(['picked','fingered','tapped','harmonic']);
});

it('negative_tremolo_hosts_normalize_public_fields_and_keep_rhythm_ids_links', () => {
  for(const [duration,marks,numerator] of [[model.Duration.DoubleWhole,4,8],[model.Duration.QuadrupleWhole,5,16]] as const) {
    const score=authored();score.masterBars[0].timeSignatureNumerator=numerator;
    const a=note(score,0,0),b=note(score,1,0);a.beat.voice.beats.splice(1);a.beat.duration=duration;a.beat.dots=1;a.beat.tupletNumerator=3;a.beat.tupletDenominator=2;
    const effect=new model.TremoloPickingEffect();effect.marks=marks;a.beat.tremoloPicking=effect;
    a.tieDestination=b;b.tieOrigin=a;b.isTieDestination=true;score.finish(settings);
    expect(effect.getDurationAsTicks(duration)).toBeGreaterThan(a.beat.playbackDuration);
    const safe=prepareMidiScore(score),first=safe.tracks[0].staves[0].bars[0].voices[0].beats[0],destination=safe.tracks[0].staves[0].bars[1].voices[0].beats[0].notes[0];
    expect(first.duration).toBe(model.Duration.Whole);expect(first.displayDuration).toBe(a.beat.displayDuration);expect(first.playbackDuration).toBe(a.beat.playbackDuration);
    expect(first.id).toBe(a.beat.id);expect(first.notes[0].id).toBe(a.id);expect(first.notes[0].tieDestination).toBe(destination);
    expect(first.tremoloPicking!.marks).toBe(marks);
    expect(first.tremoloPicking!.getDurationAsTicks(first.duration) * first.playbackDuration / 3840).toBe(480);
    expect(prepareMidiScore(safe)).toBe(safe);expect(a.beat.duration).toBe(duration);expect(effect.marks).toBe(marks);
    const plan=agree(safe);expect(plan.notes.map(n=>n.startTick)).toEqual(Array.from({length:(a.beat.playbackDuration+b.beat.playbackDuration)/480},(_,i)=>i*480));
    expect(buildPlaybackPlan(score,7)).toEqual(buildPlaybackPlan(safe,7));
  }
});

it('rare_low_mark_negative_tremolo_preserves_literal_slow_subdivision', () => {
  for(const [duration,marks,numerator,ticks] of [[model.Duration.DoubleWhole,1,8,3840],[model.Duration.QuadrupleWhole,1,16,7680],[model.Duration.QuadrupleWhole,2,16,3840]] as const) {
    const score=authored(1);score.masterBars[0].timeSignatureNumerator=numerator;const a=note(score,0,0);a.beat.voice.beats.splice(1);a.beat.duration=duration;
    a.beat.tremoloPicking=new model.TremoloPickingEffect();a.beat.tremoloPicking.marks=marks;score.finish(settings);
    const safe=prepareMidiScore(score),beat=safe.tracks[0].staves[0].bars[0].voices[0].beats[0];expect(beat.duration).toBe(model.Duration.Whole);
    expect(beat.tremoloPicking!.getDurationAsTicks(beat.duration)*beat.playbackDuration/3840).toBe(ticks);const plan=agree(safe);
    expect(plan.notes.map(n=>n.startTick)).toEqual(Array.from({length:numerator*960/ticks},(_,i)=>i*ticks));
    expect(buildPlaybackPlanFromJson(model.JsonConverter.scoreToJson(safe),['base/0'],7)).toEqual(plan);
    expect(a.beat.duration).toBe(duration);
  }
});

it('zero_mark_imported_tremolo_keeps_public_silence_semantics', () => {
  const score=authored(1);score.masterBars[0].timeSignatureNumerator=8;const a=note(score,0,0);a.beat.voice.beats.splice(1);a.beat.duration=model.Duration.DoubleWhole;
  a.beat.tremoloPicking=new model.TremoloPickingEffect();a.beat.tremoloPicking.marks=0;score.finish(settings);
  const safe=prepareMidiScore(score);expect(agree(safe).notes).toHaveLength(0);expect(buildPlaybackPlan(score,7).notes).toHaveLength(0);
  expect(safe.tracks[0].staves[0].bars[0].voices[0].beats[0].tremoloPicking!.marks).toBe(0);
});

it('initial_whammy_control_is_applied_at_clock_zero', () => {
  const score=authored(1);const a=note(score,0,0);a.beat.addWhammyBarPoint(new model.BendPoint(0,4));a.beat.addWhammyBarPoint(new model.BendPoint(60,4));score.finish(settings);
  const file=new midi.MidiFile();new midi.MidiFileGenerator(score,settings,new midi.AlphaSynthMidiFileHandler(file)).generate();
  expect(file.tracks.flatMap(t=>t.events).some(e=>e.tick<0)).toBe(true);
  const plan=agree(score);expect(plan.midi.every(e=>e.tick>=0)).toBe(true);expect(plan.notes[0].pitch[0]).toEqual({tick:0,semitones:4});
});

it.each([1,2])('imported_dead_slap_keeps_every_implied_string_attack_with_%i_authored_notes', count => {
  const score=authored();const a=note(score,0,0);if(count>1)note(score,0,0,2);a.beat.deadSlapped=true;score.finish(settings);const plan=agree(score);
  expect(plan.notes).toHaveLength(6);expect(new Set(plan.notes.map(n=>n.source.string))).toEqual(new Set([1,2,3,4,5,6]));
  expect(plan.notes.every(n=>n.articulation==='dead'&&n.source.target.beat===0)).toBe(true);
});

it('worker_protocol_tags_requests_and_ignores_upstream_ready_messages', async () => {
  let terminated=false;
  class WorkerFixture {
    onmessage: ((event:MessageEvent)=>void)|null=null;
    onerror: ((event:ErrorEvent)=>void)|null=null;
    postMessage(data:{cmd:string;json:ReturnType<typeof model.JsonConverter.scoreToJson>;identities:string[];generation:number}) {
      expect(data.cmd).toBe('tabplayer.plan.prepare');
      queueMicrotask(()=>{this.onmessage?.({data:{cmd:'alphaSynth.ready'}} as MessageEvent);this.onmessage?.({data:{cmd:'tabplayer.plan.result',plan:buildPlaybackPlanFromJson(data.json,data.identities,data.generation)}} as MessageEvent);});
    }
    terminate(){terminated=true;}
  }
  vi.stubGlobal('Worker',WorkerFixture);
  try{const plan=await preparePlan(blankProject(),21);expect(plan.generation).toBe(21);expect(terminated).toBe(true);}finally{vi.unstubAllGlobals();}
});
