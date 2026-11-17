import { beforeAll,describe,expect,it } from 'vitest';
import { midi,model,Settings } from '@coderline/alphatab';
import { scoreFromJson } from '../model-clone';
import { captureNoteLinks,restoreNoteLinks } from '../editor/links';
import { standardPercussionCatalog } from '../editor/percussion-catalog';
import { kitScore,KIT_BAR_1 } from './drum-tab-fixtures';
import { DRUM_TAB_TUNING } from './drum-tab';
import { defaultEngraving,drumTabModes,mapProjection,projectEngraving,validateEngravingTracks } from './projection';
import type { TrackProfile } from './types';
import { setLanguagePreference } from '../i18n';

beforeAll(()=>setLanguagePreference('en'));

/**
 * THE-220 slice 2: a drum track's engraving profile ('tablature' or 'standardTab') draws drum tab on the display copy. The source score is never touched.
 */
const engraving=(ids:string[],drum:TrackProfile|null,guitar:TrackProfile|null=null)=>({...defaultEngraving(),profiles:[...guitar?[{trackId:ids[0],profile:guitar}]:[],...drum?[{trackId:ids[1],profile:drum}]:[]]});
const jsonOf=(score:model.Score)=>model.JsonConverter.scoreToJson(score) as string;
const notesOf=(staff:model.Staff)=>staff.bars.flatMap(bar=>bar.voices.flatMap(voice=>voice.beats.flatMap(beat=>beat.notes)));
const drumStaff=(score:model.Score,index=0)=>score.tracks[1].staves[index];

describe('a score without a drum tab profile projects exactly as it did',()=>{
  /** The display copy as it was made before drum tab existed: a plain JSON round trip with the profile flags set by hand. */
  function oracle(source:model.Score,flags:Record<number,boolean[]>) {
    const copy=scoreFromJson(model.JsonConverter.scoreToJson(source),new Settings());restoreNoteLinks(copy,captureNoteLinks(source));
    copy.tracks.forEach((track,ti)=>{if(flags[ti])for(const staff of track.staves)[staff.showStandardNotation,staff.showTablature,staff.showSlash,staff.showNumbered]=flags[ti];});
    return jsonOf(copy);
  }
  it('with no profile, the source profile, or a profile that is not a tab one for the drum track',()=>{
    for(const crowded of [false,true]){
      const cases:Array<[TrackProfile|null,TrackProfile|null,Record<number,boolean[]>]>=[
        [null,null,{}],['source','source',{}],[null,'standard',{1:[true,false,false,false]}],[null,'slash',{1:[false,false,true,false]}],[null,'numbered' as TrackProfile,{}],
        ['tablature','standard',{0:[false,true,false,false],1:[true,false,false,false]}],['standardTab','standard',{0:[true,true,false,false],1:[true,false,false,false]}],
      ];
      for(const [guitar,drum,flags] of cases){
        const {score,ids}=kitScore({crowded});
        if(drum==='numbered')expect(()=>projectEngraving(score,ids,engraving(ids,drum,guitar))).toThrow();
        else{
          const result=projectEngraving(score,ids,engraving(ids,drum,guitar));
          expect(jsonOf(result.score),`${guitar}/${drum}`).toBe(oracle(score,flags));
          expect(result.drumTab).toBeUndefined();expect('drumTab' in result).toBe(false);
          expect(result.beats.size).toBe(16);
        }
      }
    }
  });
  it('for a drum track of two percussion staves, whose standard + tablature profile has always drawn the standard staves only',()=>{
    const {score,ids}=kitScore({secondStaff:true});
    const result=projectEngraving(score,ids,engraving(ids,'standardTab'));
    expect(jsonOf(result.score)).toBe(oracle(score,{1:[true,false,false,false]}));expect(result.drumTab).toBeUndefined();
    expect(drumTabModes(score,ids,engraving(ids,'standardTab')).size).toBe(0);
    // Tablature stays refused for it, as for a track that mixes percussion with strings.
    expect(()=>validateEngravingTracks(score,ids,engraving(ids,'tablature'))).toThrow(/Tablature requires/);
    expect(()=>projectEngraving(score,ids,engraving(ids,'tablature'))).toThrow(/Tablature requires/);
  });
});

describe('which profiles a drum track accepts',()=>{
  it('takes tablature and standard + tablature, and still refuses numbered notation',()=>{
    const {score,ids}=kitScore();
    for(const profile of ['source','standard','tablature','standardTab','slash'] as const)expect(()=>validateEngravingTracks(score,ids,engraving(ids,profile))).not.toThrow();
    expect(()=>validateEngravingTracks(score,ids,engraving(ids,'numbered'))).toThrow(/Numbered notation is unavailable for percussion/);
    // The guitar's rules are unchanged.
    expect(()=>validateEngravingTracks(score,ids,engraving(ids,null,'tablature'))).not.toThrow();
  });
});

describe('a drum track shown as tablature only',()=>{
  it('replaces the percussion staff with a six-line tab staff of the written numbers, and maps it to the source notes',()=>{
    const {score,ids}=kitScore(),before=jsonOf(score);
    const result=projectEngraving(score,ids,engraving(ids,'tablature'));
    expect(jsonOf(score)).toBe(before);
    const staves=result.score.tracks[1].staves;
    expect(staves).toHaveLength(1);
    expect([staves[0].isPercussion,staves[0].showTablature,staves[0].showStandardNotation,staves[0].tuning.length]).toEqual([false,true,false,6]);
    expect(staves[0].tuning).toEqual([...DRUM_TAB_TUNING]);
    // Every kit note is on the tab with its own number; the guitar track is untouched.
    const sourceNotes=notesOf(drumStaff(score));
    expect(sourceNotes).toHaveLength(14);
    for(const note of sourceNotes){
      const pair=result.notes.get(note.id)!;
      expect(pair.source).toBe(note);expect(pair.rendered.fret).toBe(note.percussionArticulation);expect(pair.tab).toBeUndefined();
      expect(result.renderedNotes!.get(pair.rendered)).toBe(note);
    }
    expect(result.beats.get(drumStaff(score).bars[0].voices[0].beats[1].id)!.rendered).toBe(staves[0].bars[0].voices[0].beats[1]);
    expect(result.renderedBeats!.get(staves[0].bars[1].voices[0].beats[3])).toBe(drumStaff(score).bars[1].voices[0].beats[3]);
    expect(result.score.tracks[0].staves.map(staff=>[staff.showStandardNotation,staff.showTablature])).toEqual([[true,true]]);
    expect(result.drumTab!.hiddenTuningTracks).toEqual([1]);
    expect(result.score.stylesheet.perTrackDisplayTuning?.get(1)).toBe(false);
  });
  it('keeps the tuning label hidden when the engraving sets its own tuning display',()=>{
    const {score,ids}=kitScore(),value=engraving(ids,'tablature');value.stylesheet.tuning=true;
    const result=projectEngraving(score,ids,value);
    expect(result.score.stylesheet.globalDisplayTuning).toBe(true);expect(result.score.stylesheet.perTrackDisplayTuning?.get(1)).toBe(false);
  });
  it('leaves off the hits beyond six in one beat, and has no mapping for them',()=>{
    const {score,ids}=kitScore({crowded:true});
    const result=projectEngraving(score,ids,engraving(ids,'tablature'));
    const crowd=drumStaff(score).bars[1].voices[0].beats[2];
    expect(crowd.notes).toHaveLength(7);expect(result.drumTab!.surplusNotes).toHaveLength(1);
    const left=crowd.notes.filter(note=>!result.notes.has(note.id));
    expect(left.map(note=>note.id)).toEqual(result.drumTab!.surplusNotes);
    expect(result.beats.get(crowd.id)!.rendered.notes).toHaveLength(6);
    // The same beat always gets the same lines.
    const again=projectEngraving(score,ids,engraving(ids,'tablature'));
    expect(again.beats.get(crowd.id)!.rendered.notes.map(note=>[note.fret,note.string])).toEqual(result.beats.get(crowd.id)!.rendered.notes.map(note=>[note.fret,note.string]));
  });
  it('keeps a tie between two hits that are both written',()=>{
    const {score,ids}=kitScore();
    const result=projectEngraving(score,ids,engraving(ids,'tablature'));
    const to=drumStaff(score).bars[1].voices[0].beats[0].notes[0],drawn=result.notes.get(to.id)!.rendered;
    expect(drawn.isTieDestination).toBe(true);expect(drawn.tieOrigin?.fret).toBe(49);
  });
});

describe('a drum track shown as standard notation and tablature',()=>{
  it('keeps the percussion staff and adds the tab as the next staff; either drawn note leads to the one source note',()=>{
    const {score,ids}=kitScore(),before=jsonOf(score);
    const result=projectEngraving(score,ids,engraving(ids,'standardTab'));
    expect(jsonOf(score)).toBe(before);
    const staves=result.score.tracks[1].staves;
    expect(staves.map(staff=>[staff.isPercussion,staff.showStandardNotation,staff.showTablature,staff.tuning.length])).toEqual([[true,true,false,0],[false,false,true,6]]);
    expect(result.score.tracks[1].staves[0].bars[0].voices[0].beats[0].notes[0].percussionArticulation).toBe(36);
    for(const note of notesOf(drumStaff(score))){
      const pair=result.notes.get(note.id)!;
      expect(pair.rendered.isPercussion).toBe(true);expect(pair.tab!.fret).toBe(note.percussionArticulation);expect(pair.tab!.isPercussion).toBe(false);
      expect(result.renderedNotes!.get(pair.rendered)).toBe(note);expect(result.renderedNotes!.get(pair.tab!)).toBe(note);
    }
    for(const beat of drumStaff(score).bars.flatMap(bar=>bar.voices[0].beats)){
      const pair=result.beats.get(beat.id)!;
      expect(pair.tab).toBeDefined();expect(pair.tab!.voice.bar.staff).toBe(staves[1]);expect(result.renderedBeats!.get(pair.rendered)).toBe(beat);expect(result.renderedBeats!.get(pair.tab!)).toBe(beat);
    }
    // Rendered ids are all different, so alphaTab's per-id bounds never mix the two staves.
    const ids2=result.score.tracks[1].staves.flatMap(staff=>staff.bars.flatMap(bar=>bar.voices.flatMap(voice=>voice.beats.map(beat=>beat.id))));
    expect(new Set(ids2).size).toBe(ids2.length);
  });
  it('repeats the tie on the tab staff',()=>{
    const {score,ids}=kitScore();
    const result=projectEngraving(score,ids,engraving(ids,'standardTab'));
    const to=drumStaff(score).bars[1].voices[0].beats[0].notes[0],pair=result.notes.get(to.id)!;
    expect(pair.rendered.isTieDestination).toBe(true);expect(pair.tab!.isTieDestination).toBe(true);expect(pair.tab!.tieOrigin?.fret).toBe(49);expect(pair.tab!.tieOrigin).not.toBe(pair.rendered.tieOrigin);
  });
  it('lifts the id counters above the ids it made up, so a later beat on the copy cannot share one',()=>{
    const {score,ids}=kitScore(),result=projectEngraving(score,ids,engraving(ids,'standardTab'));
    const used=Math.max(...result.score.tracks.flatMap(track=>track.staves.flatMap(staff=>staff.bars.flatMap(bar=>bar.voices.flatMap(voice=>voice.beats.map(beat=>beat.id))))));
    expect(new model.Beat().id).toBeGreaterThan(used);
    const noteUsed=Math.max(...result.score.tracks.flatMap(track=>track.staves.flatMap(staff=>staff.bars.flatMap(bar=>bar.voices.flatMap(voice=>voice.beats.flatMap(beat=>beat.notes.map(note=>note.id)))))));
    expect(new model.Note().id).toBeGreaterThan(noteUsed);
  });
  it('mixes with a tab profile on the guitar and gives the same projection twice',()=>{
    const {score,ids}=kitScore(),value=engraving(ids,'standardTab','standardTab');
    const a=projectEngraving(score,ids,value),b=projectEngraving(score,ids,value);
    expect(a.score.tracks.map(track=>track.staves.length)).toEqual([1,2]);
    // The ids differ between projections (alphaTab's counters moved on), everything else is the same.
    const strip=(score:model.Score)=>jsonOf(score).replace(/"id":\d+/g,'"id":0').replace(/"(?:note|beat|bar|voice)id":\d+/g,'');
    expect(strip(a.score)).toBe(strip(b.score));
  });
  it('maps by the conversion report, so asking for the map without it is refused',()=>{
    const {score,ids}=kitScore(),value=engraving(ids,'standardTab'),result=projectEngraving(score,ids,value);
    expect(()=>mapProjection(score,result.score,ids,value)).toThrow(/conversion report/);
    expect(mapProjection(score,result.score,ids,value,result.drumTab).notes.size).toBe(result.notes.size);
    expect(()=>mapProjection(score,projectEngraving(score,ids,engraving(ids,'standard')).score,ids,value,result.drumTab)).toThrow(/lacks its drum tab staff/);
  });
});

describe('playback and MIDI read the source, never the display copy',()=>{
  const smf=(score:model.Score)=>{const file=new midi.MidiFile();new midi.MidiFileGenerator(score,new Settings(),new midi.AlphaSynthMidiFileHandler(file,true)).generate();return Buffer.from(file.toBinary());};
  it('leaves the source MIDI as it was, and the display copy can still be turned into MIDI (alphaTab does it for its cursor) without error',()=>{
    for(const profile of ['tablature','standardTab'] as const){
      const {score,ids}=kitScore(),before=smf(score),result=projectEngraving(score,ids,engraving(ids,profile));
      expect(smf(score).equals(before),profile).toBe(true);
      expect(()=>smf(result.score)).not.toThrow();
    }
  });
});

describe('the kit pattern the tests use',()=>{
  it('is the pattern the render test draws',()=>{expect(KIT_BAR_1).toEqual([[36,42],[38,42],[36,42,49],[91,53]]);});
});

describe('a tie is drawn on the tab only between two hits that are written alike',()=>{
  /** Every tab note that has a tie origin, with the origin's number and line. */
  const tabTies=(score:model.Score)=>notesOf(score.tracks[1].staves.find(staff=>!staff.isPercussion)!).filter(note=>note.tieOrigin).map(note=>[note.tieOrigin!.fret,note.tieOrigin!.string,note.fret,note.string]);
  /** The ride bell (53) of bar 1's last beat tied into the snare (38) of bar 2's second beat: two different hits. */
  function crossTied() {
    const kit=kitScore(),staff=kit.score.tracks[1].staves[0];
    const from=staff.bars[0].voices[0].beats[3].notes.find(note=>note.percussionArticulation===53)!,to=staff.bars[1].voices[0].beats[1].notes[0];
    from.tieDestination=to;to.tieOrigin=from;to.isTieDestination=true;
    return kit;
  }
  it('draws no tie between two different numbers, in either mode, and still draws the tie of equal hits',()=>{
    for(const profile of ['tablature','standardTab'] as const){
      const {score,ids}=crossTied(),result=projectEngraving(score,ids,engraving(ids,profile));
      expect(tabTies(result.score),profile).toEqual([[49,6,49,6]]);
      const to=score.tracks[1].staves[0].bars[1].voices[0].beats[1].notes[0],pair=result.notes.get(to.id)!;
      expect((pair.tab??pair.rendered).tieOrigin,profile).toBeNull();expect((pair.tab??pair.rendered).isTieDestination,profile).toBe(false);
      // The percussion staff of the other mode still carries the source's own tie.
      if(profile==='standardTab')expect(pair.rendered.isTieDestination).toBe(true);
    }
  });
});

describe('a drum track with its own articulation table, as a Guitar Pro file writes it',()=>{
  /** The table's entries are the standard ones of 42, 36, 38, 91 and 49, in that order, so no note's index is the number the tab must write. */
  const WRITTEN=[42,36,38,91,49];
  function tableScore() {
    const score=new model.Score(),track=new model.Track();track.name='Drums';
    track.percussionArticulations=WRITTEN.map(id=>{const entry=standardPercussionCatalog.find(candidate=>candidate.id===id)!;return new model.InstrumentArticulation(entry.element,entry.staffLine,entry.outputMidiNumber,...entry.symbols);});
    const staff=new model.Staff();staff.isPercussion=true;track.addStaff(staff);score.addTrack(track);score.addMasterBar(new model.MasterBar());
    const bar=new model.Bar(),voice=new model.Voice();staff.addBar(bar);bar.addVoice(voice);
    for(const indexes of [[0,1],[2,0],[3,4]]){const beat=new model.Beat();beat.duration=model.Duration.Quarter;beat.isEmpty=false;voice.addBeat(beat);for(const index of indexes){const note=new model.Note();note.percussionArticulation=index;beat.addNote(note);}}
    score.finish(new Settings());return {score,ids:['base/0']};
  }
  it('writes each hit as the standard number its table entry stands for, never the table index, on the line of its kit piece',()=>{
    for(const profile of ['tablature','standardTab'] as const){
      const {score,ids}=tableScore(),result=projectEngraving(score,ids,{...defaultEngraving(),profiles:[{trackId:ids[0],profile}]});
      const drawn=result.score.tracks[0].staves.at(-1)!.bars[0].voices[0].beats.map(beat=>beat.notes.map(note=>`${note.fret}@${7-note.string}`).sort());
      expect(drawn,profile).toEqual([['36@6','42@3'],['38@5','42@3'],['49@1','91@5']]);
    }
  });
});
