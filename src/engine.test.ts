import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { midi, model, Settings } from '@coderline/alphatab';
import { buildScore, buildDocument, previewEdit, exportGp, validateProject, describeSelection, trackIdentity } from './engine';
import { exporter } from '@coderline/alphatab';
import { strToU8, unzipSync, zipSync } from 'fflate';

const base = () => ({
  format: 'TabPlayer' as const, schemaVersion: 1 as const, engineVersion: '1.8.4' as const,
  base: { kind: 'blank' as const, title: 'Test', artist: '', tempo: 120, tuning: [64,59,55,50,45,40], measureCount: 4 },
  edits: [],
});
const target = { track: 0, staff: 0, bar: 0, voice: 0, beat: 0 };
const beat = (score: ReturnType<typeof buildScore>) => score.tracks[0].staves[0].bars[0].voices[0].beats[0];
const imported = (score: model.Score) => {
  const bytes=exportGp(score);
  return {...base(),base:{kind:'file' as const,filename:'authored.gp',bytesBase64:Buffer.from(bytes).toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')}};
};
const originTarget={...target,beat:3}, destinationTarget={...target,bar:1};
function linkedProject(kind:'tie'|'slide'|'slur'|'hammer') {
  if(kind==='slur') {
    const note=(type:string)=>`<note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type><notations><slur type="${type}" number="1"/><technical><string>1</string><fret>3</fret></technical></notations></note>`;
    const tuning=['E','B','G','D','A','E'].map((step,i)=>`<staff-tuning line="${6-i}"><tuning-step>${step}</tuning-step><tuning-octave>${i<1?4:i<5?3:2}</tuning-octave></staff-tuning>`).join('');
    const rest='<note><rest/><duration>1</duration><type>quarter</type></note>';
    const bytes=Buffer.from(`<?xml version="1.0"?><score-partwise version="3.1"><part-list><score-part id="P1"><part-name>Guitar</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef><staff-details><staff-lines>6</staff-lines>${tuning}</staff-details></attributes>${rest.repeat(3)}${note('start')}</measure><measure number="2">${note('stop')}${rest.repeat(3)}</measure></part></score-partwise>`);
    return {...base(),base:{kind:'file' as const,filename:'slur.musicxml',bytesBase64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')}};
  }
  const notes=previewEdit(previewEdit(base(),{type:'setNote',target:originTarget,string:6,fret:3}).project,{type:'setNote',target:destinationTarget,string:6,fret:3}).score;
  const origin=describeSelection(notes,originTarget).beat!.notes[0], destination=describeSelection(notes,destinationTarget).beat!.notes[0];
  if(kind==='tie'){origin.tieDestination=destination;destination.tieOrigin=origin;destination.isTieDestination=true;}
  if(kind==='slide'){origin.slideOutType=model.SlideOutType.Shift;origin.slideTarget=destination;destination.slideOrigin=origin;}
  if(kind==='hammer'){origin.isHammerPullOrigin=true;origin.hammerPullDestination=destination;destination.hammerPullOrigin=origin;}
  return imported(notes);
}

describe('moving tracks', () => {
  const threeTracks = () => {
    let project = previewEdit(base(), {type:'setNote', target, string:6, fret:3}).project;
    project = previewEdit(project, {type:'addTrack', name:'Bass', tuning:[43,38,33,28], program:33}).project;
    return previewEdit(project, {type:'addPitchedTrack', name:'Keys', program:0}).project;
  };
  it('moves a track with its music, channels and identity-keyed settings', () => {
    const project = threeTracks(), before = buildDocument(project), ids = before.score.tracks.map(trackIdentity);
    const channels = before.score.tracks.map(track => [track.playbackInfo.primaryChannel, track.playbackInfo.secondaryChannel]);
    const mixed = previewEdit(project, {type:'setTrackMix', trackId:ids[0], mix:{gain:0.5, pan:0, mute:false, solo:false}}).project;
    const moved = previewEdit(mixed, {type:'moveTrack', track:0, to:2});
    expect(moved.score.tracks.map(track => track.name)).toEqual(['Bass','Keys','Guitar']);
    expect(moved.score.tracks.map(track => track.index)).toEqual([0,1,2]);
    expect(moved.score.tracks[2].staves[0].bars[0].voices[0].beats[0].notes[0].fret).toBe(3);
    expect(moved.score.tracks.map(track => [track.playbackInfo.primaryChannel, track.playbackInfo.secondaryChannel])).toEqual([channels[1], channels[2], channels[0]]);
    const document = buildDocument(moved.project);
    expect(document.score.tracks.map(trackIdentity)).toEqual([ids[1], ids[2], ids[0]]);
    expect(document.settings.mixes[ids[0]].gain).toBe(0.5);
    // Later settings edits take the fast path on the moved score and still reach the moved track.
    const fast = previewEdit(moved.project, {type:'setTrackMix', trackId:ids[0], mix:{gain:0.25, pan:0, mute:false, solo:false}}, document);
    expect(fast.settings.mixes[ids[0]].gain).toBe(0.25);
    expect(trackIdentity(fast.score.tracks[2])).toBe(ids[0]);
    const back = previewEdit(moved.project, {type:'moveTrack', track:2, to:0});
    expect(back.score.tracks.map(track => track.name)).toEqual(['Guitar','Bass','Keys']);
    expect(buildDocument(back.project).score.tracks.map(trackIdentity)).toEqual(ids);
  });
  it('remaps per-track style with the track order', () => {
    const score = buildScore(threeTracks());
    score.stylesheet.perTrackMultiBarRest = new Set([0]);
    const moved = previewEdit(imported(score), {type:'moveTrack', track:0, to:1});
    expect([...moved.score.stylesheet.perTrackMultiBarRest ?? []]).toEqual([1]);
  });
  it('keeps lyrics and later index-based edits on the moved track through Undo', () => {
    let project = previewEdit(threeTracks(), {type:'setTrackLyrics', track:0, visible:true, lines:[{text:'la la', startBar:0}]}).project;
    const moved = previewEdit(project, {type:'moveTrack', track:0, to:1});
    expect(moved.score.tracks[1].name).toBe('Guitar');
    expect(moved.score.tracks[1].staves[0].bars[0].voices[0].beats[0].lyrics?.[0]).toBe('la');
    project = previewEdit(moved.project, {type:'setNote', target:{...target, track:1, beat:1}, string:5, fret:2}).project;
    expect(buildScore(project).tracks[1].staves[0].bars[0].voices[0].beats[1].notes[0].fret).toBe(2);
    // Undo replays the shorter history from scratch.
    const undone = buildScore({...project, edits:project.edits.slice(0,-1)});
    expect(undone.tracks.map(track => track.name)).toEqual(moved.score.tracks.map(track => track.name));
    expect(undone.tracks[1].staves[0].bars[0].voices[0].beats.map(beat => [beat.lyrics?.[0], beat.notes.map(note => note.fret)])).toEqual(moved.score.tracks[1].staves[0].bars[0].voices[0].beats.map(beat => [beat.lyrics?.[0], beat.notes.map(note => note.fret)]));
  });
  it('refuses a move to the same place or outside the tracks', () => {
    const project = threeTracks();
    for (const edit of [{track:0,to:0},{track:0,to:3},{track:3,to:0},{track:-1,to:0},{track:0,to:-1},{track:0,to:1.5}])
      expect(() => previewEdit(project, {type:'moveTrack', ...edit})).toThrow();
  });
  it('drops track-ordered GP archive entries once the track order changes', () => {
    const entries = unzipSync(exportGp(buildScore(threeTracks())));
    entries['Content/ScoreViews/custom.gpsv'] = strToU8('view');
    const bytes = zipSync(entries), project = {...base(), base:{kind:'file' as const, filename:'ordered.gp', bytesBase64:Buffer.from(bytes).toString('base64'), sha256:createHash('sha256').update(bytes).digest('hex')}};
    const kept = unzipSync(exportGp(buildScore(project)));
    expect(kept['Content/ScoreViews/custom.gpsv']).toBeDefined();
    const moved = previewEdit(project, {type:'moveTrack', track:0, to:2}).score, out = unzipSync(exportGp(moved));
    const generated = unzipSync(new exporter.Gp7Exporter().export(moved, new Settings()));
    expect(out['Content/ScoreViews/custom.gpsv']).toBeUndefined();
    expect(out['Content/PartConfiguration']).toEqual(generated['Content/PartConfiguration']);
    expect(out['Content/PartConfiguration']).not.toEqual(entries['Content/PartConfiguration']);
    expect(out['Content/LayoutConfiguration']).toEqual(generated['Content/LayoutConfiguration']);
    // Adding or removing a track changes the order the same way; other edits keep the source entries.
    for (const edit of [{type:'addTrack' as const, name:'More', tuning:[64,59,55,50,45,40], program:25}, {type:'removeTrack' as const, track:1}])
      expect(unzipSync(exportGp(previewEdit(project, edit).score))['Content/ScoreViews/custom.gpsv']).toBeUndefined();
    expect(unzipSync(exportGp(previewEdit(project, {type:'setNote', target, string:5, fret:1}).score))['Content/ScoreViews/custom.gpsv']).toBeDefined();
  });
});

describe('score editing', () => {
  it.each(['removeNote','setRest','deleteBeat','removeMeasure'] as const)('repairs duplicate incoming ties after legacy %s',type=>{
    const source=buildScore(base()),origin=source.tracks[0].staves[0].bars[0].voices[0].beats[3],destination=source.tracks[0].staves[0].bars[1].voices[0].beats[0];
    const first=new model.Note();first.string=1;first.fret=3;origin.addNote(first);
    for(let index=0;index<2;index++){const note=new model.Note();note.string=1;note.fret=3;note.isTieDestination=true;destination.addNote(note);}
    source.finish(new Settings());const project=imported(source),before=JSON.stringify(project);
    const edit=type==='removeMeasure'?{type,bar:0}:type==='removeNote'?{type,target:originTarget,string:1}:{type,target:originTarget};
    const changed=previewEdit(project,edit),survivors=changed.score.tracks[0].staves[0].bars[type==='removeMeasure'?0:1].voices[0].beats[0].notes;
    expect(survivors).toHaveLength(2);expect(survivors.every(note=>!note.isTieDestination&&note.tieOrigin===null)).toBe(true);
    expect(()=>buildScore(imported(changed.score))).not.toThrow();expect(JSON.stringify(project)).toBe(before);
  });
  it.each(['removeNote','setRest','deleteBeat','removeMeasure'] as const)('repairs imported cross-measure ties after %s',type=>{
    const project=linkedProject('tie');
    expect(describeSelection(buildScore(project),destinationTarget).beat!.notes[0].isTieDestination).toBe(true);
    const changed=previewEdit(project,type==='removeMeasure'?{type,bar:0}:type==='removeNote'?{type,target:originTarget,string:6}:{type,target:originTarget});
    const survivor=describeSelection(changed.score,{...destinationTarget,bar:type==='removeMeasure'?0:1}).beat!.notes[0];
    expect(survivor.isTieDestination).toBe(false);expect(survivor.tieOrigin).toBeNull();expect(survivor.fret).toBe(3);
    expect(()=>buildScore(imported(changed.score))).not.toThrow();
  });
  it('changes the pitch of a tied note from either end and preserves the tie on export',()=>{
    for(const selection of [originTarget,destinationTarget]) {
      const changed=previewEdit(linkedProject('tie'),{type:'setNote',target:selection,string:6,fret:7});
      const origin=describeSelection(changed.score,originTarget).beat!.notes[0], destination=describeSelection(changed.score,destinationTarget).beat!.notes[0];
      expect(origin.fret).toBe(7);expect(destination.fret).toBe(7);expect(destination.tieOrigin).toBe(origin);
      expect(describeSelection(buildScore(imported(changed.score)),destinationTarget).beat!.notes[0].fret).toBe(7);
    }
  });
  it.each(['slide','slur','hammer'] as const)('detaches both ends of an imported %s when a note is removed',kind=>{
    const project=linkedProject(kind);const original=buildScore(project);
    const before=describeSelection(original,destinationTarget).beat!.notes[0];
    expect(kind==='slide'?before.slideOrigin:kind==='slur'?before.slurOrigin:before.hammerPullOrigin).not.toBeNull();
    for(const selection of [originTarget,destinationTarget]) {
      const changed=previewEdit(project,{type:'removeNote',target:selection,string:6});
      const survivor=describeSelection(changed.score,selection===originTarget?destinationTarget:originTarget).beat!.notes[0];
      expect(survivor.slideOrigin).toBeNull();expect(survivor.slideTarget).toBeNull();
      expect(survivor.slurOrigin).toBeNull();expect(survivor.slurDestination).toBeNull();
      expect(survivor.hammerPullOrigin).toBeNull();expect(survivor.hammerPullDestination).toBeNull();
    }
  });
  it.each([0,1,3])('clears measure %i and can render, replay and insert into it',bar=>{
    let project=base() as Parameters<typeof buildScore>[0];const selection={...target,bar};
    for(let i=0;i<4;i++)project=previewEdit(project,{type:'deleteBeat',target:selection}).project;
    const empty=buildScore(project);
    expect(describeSelection(empty,selection).beat).toBeUndefined();
    expect(empty.tracks[0].staves[0].bars[bar].voices[0].beats).toHaveLength(1);
    expect(()=>exportGp(empty)).not.toThrow();
    const inserted=previewEdit(project,{type:'insertBeat',target:selection,duration:4,dots:0});
    expect(describeSelection(inserted.score,selection).voice.beats).toHaveLength(1);
    expect(describeSelection(inserted.score,selection).beat?.isRest).toBe(true);
  });
  it('rejects note entry that overfills an imported whole-measure rest in 3/4',()=>{
    const score=buildScore(base());score.masterBars[0].timeSignatureNumerator=3;
    const voice=beat(score).voice;voice.beats.splice(1);voice.beats[0].duration=1;
    const project=imported(model.JsonConverter.jsonToScore(model.JsonConverter.scoreToJson(score),new Settings()));
    expect(beat(buildScore(project)).playbackDuration).toBe(2880);
    expect(()=>previewEdit(project,{type:'setNote',target,string:6,fret:5})).toThrow(/overfill/i);
    expect(project.edits).toHaveLength(0);
  });
  it('plays triple dots with correct MIDI ticks, overflow rejection and export/reimport',()=>{
    let project=base() as Parameters<typeof buildScore>[0];
    for(let i=0;i<3;i++)project=previewEdit(project,{type:'deleteBeat',target:{...target,beat:1}}).project;
    const rhythm=previewEdit(project,{type:'setDuration',target,duration:4,dots:3});
    expect(beat(rhythm.score).playbackDuration).toBe(1800);
    const first=previewEdit(rhythm.project,{type:'setNote',target,string:6,fret:7});
    const second=previewEdit(first.project,{type:'insertBeat',target:{...target,beat:1},duration:4,dots:0});
    const music=previewEdit(second.project,{type:'setNote',target:{...target,beat:1},string:6,fret:9});
    expect(describeSelection(music.score,{...target,beat:1}).beat!.absolutePlaybackStart).toBe(1800);
    const file=new midi.MidiFile();new midi.MidiFileGenerator(music.score,new Settings(),new midi.AlphaSynthMidiFileHandler(file)).generate();
    expect(file.tracks.some(t=>t.events.some(e=>e.type===midi.MidiEventType.NoteOn && e.tick===1800))).toBe(true);
    const reopened=buildScore(imported(music.score));expect(beat(reopened).dots).toBe(3);expect(beat(reopened).playbackDuration).toBe(1800);
    expect(()=>previewEdit(base(),{type:'setDuration',target,duration:4,dots:3})).toThrow(/overfill/i);
    expect(beat(previewEdit(rhythm.project,{type:'setDuration',target,duration:4,dots:0}).score).playbackDuration).toBe(960);
  });
  it('keeps triple-dot tuplet timing and supported tick quantization on imported notes',()=>{
    const score=previewEdit(base(),{type:'setNote',target,string:6,fret:3}).score;
    const voice=beat(score).voice;voice.beats.splice(1);
    beat(score).dots=3;beat(score).tupletNumerator=3;beat(score).tupletDenominator=2;
    expect(beat(buildScore(imported(score))).playbackDuration).toBe(1200);
    beat(score).duration=64;beat(score).tupletNumerator=-1;beat(score).tupletDenominator=-1;
    expect(beat(buildScore(imported(score))).playbackDuration).toBe(112);
  });
  it('rejects retuning that would push existing frets outside MIDI range',()=>{
    const note=previewEdit(base(),{type:'setNote',target,string:6,fret:7});
    expect(()=>previewEdit(note.project,{type:'setTuning',track:0,tuning:[127,59,55,50,45,40]})).toThrow(/pitch range/i);
  });
  it('turns a fret into its sounding MIDI pitch and adds chords', () => {
    const first = previewEdit(base(), { type: 'setNote', target, string: 6, fret: 7 });
    expect(beat(first.score).notes[0].realValue).toBe(71);
    const chord = previewEdit(first.project, { type: 'setNote', target, string: 5, fret: 5 });
    expect(beat(chord.score).notes.map(n => n.realValue).sort()).toEqual([64,71]);
    const rest = previewEdit(chord.project, { type: 'setRest', target });
    expect(beat(rest.score).isRest).toBe(true);
    expect(base().edits).toEqual([]);
  });
  it('validates measure capacity using dotted durations', () => {
    const short = previewEdit(base(), { type: 'setDuration', target, duration: 8, dots: 1 });
    expect(beat(short.score).playbackDuration).toBe(720);
    expect(() => previewEdit(base(), { type: 'setDuration', target, duration: 2, dots: 0 })).toThrow(/overfill/i);
  });
  it('rejects invalid pitches and targets without appending a command', () => {
    const project = base();
    expect(() => previewEdit(project, { type: 'setNote', target, string: 1, fret: -1 })).toThrow();
    expect(() => previewEdit(project, { type: 'setNote', target, string: 1, fret: 100 })).toThrow();
    expect(() => previewEdit(project, { type: 'setRest', target: {...target, bar: 99} })).toThrow();
    expect(project.edits).toHaveLength(0);
  });
  it('keeps every track aligned during measure edits', () => {
    const added = previewEdit(base(), { type: 'addTrack', name: 'Bass', tuning: [43,38,33,28], program: 33 });
    const longer = previewEdit(added.project, { type: 'appendMeasure' });
    expect(longer.score.masterBars).toHaveLength(5);
    expect(longer.score.tracks.map(t => t.staves[0].bars.length)).toEqual([5,5]);
    const shorter = previewEdit(longer.project, { type: 'removeMeasure', bar: 0 });
    expect(shorter.score.tracks.map(t => t.staves[0].bars.length)).toEqual([4,4]);
  });
  it('supports beat deletion to empty, insertion, retuning, and protected last track', () => {
    let project = base() as Parameters<typeof buildScore>[0];
    for (let i=0; i<4; i++) project = previewEdit(project, {type:'deleteBeat', target}).project;
    const inserted = previewEdit(project, { type:'insertBeat', target, duration:4, dots:0 });
    expect(beat(inserted.score).isRest).toBe(true);
    const note = previewEdit(inserted.project, { type:'setNote', target, string:1, fret:0 });
    const tuned = previewEdit(note.project, {type:'setTuning', track:0, tuning:[64,59,55,50,45,38]});
    expect(beat(tuned.score).notes[0].realValue).toBe(38);
    expect(() => previewEdit(base(), {type:'removeTrack', track:0})).toThrow();
  });
  it('exports supported music and imports the exported score without altering its source', () => {
    const changed = previewEdit(base(), {type:'setNote', target, string:6, fret:7});
    const bytes = exportGp(changed.score);
    const encoded = Buffer.from(bytes).toString('base64');
    const imported = {...base(), base: {kind:'file' as const,filename:'score.gp',bytesBase64:encoded,sha256:createHash('sha256').update(bytes).digest('hex')}};
    const score = buildScore(imported);
    expect(beat(score).notes[0].realValue).toBe(71);
    expect(imported.base.bytesBase64).toBe(encoded);
  });
  it('rejects incompatible native documents and malformed replay commands', () => {
    expect(() => validateProject({...base(),engineVersion:'future'})).toThrow(/version|requires/i);
    expect(() => buildScore({...base(),edits:[{type:'unknown'}]} as never)).toThrow();
  });
});
