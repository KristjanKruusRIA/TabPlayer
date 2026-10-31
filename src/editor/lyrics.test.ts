import { expect,it } from 'vitest';
import { model,Settings } from '@coderline/alphatab';
import { scoreFromJson } from '../model-clone';
import { music } from './fixtures';
import { applyLyricsEdit,getTrackLyrics,reflowLyrics,removeLyricsMeasure,tokenizeLyrics } from './lyrics';
import { copyLyricsSources,setLyricsSource } from './lyrics-source';
import type { LyricsCommand } from './lyrics-types';

function fixture() {
  const score=music(),copy=()=>scoreFromJson(model.JsonConverter.scoreToJson(music()),new Settings());
  score.addTrack(copy().tracks[0]);score.tracks[0].addStaff(copy().tracks[0].staves[0]);
  for(const bar of score.tracks[0].staves[0].bars) {
    const voice=new model.Voice(),beat=new model.Beat(),note=new model.Note();
    note.string=6;note.fret=5;beat.addNote(note);voice.addBeat(beat);bar.addVoice(voice);
  }
  score.finish(new Settings());return score;
}
const beats=(score:model.Score,track=0,staff=0,voice=0)=>score.tracks[track].staves[staff].bars.flatMap(b=>b.voices[voice]?.beats??[]);
const command=(lines:LyricsCommand['lines'],visible=true):LyricsCommand=>({type:'setTrackLyrics',track:0,visible,lines});

it('tokenizes_gp_lyrics_without_spending_comment_beats',()=>{
  const cases:[string,string[]][]=[
    ['Hel-lo  world+today',['Hel-','lo','','world today']],
    ['[VERSE] hello',['hello']],['a--b',['a-','','b']],
    ['a\n\nb',['a','b']],['a+b c',['a b','c']],['a___ b',['a___','b']],
    ['a\r\n\r\nb\tc',['a','b','c']],['[a comment] [next] hello',['hello']],
    ['a [unclosed comment remainder',['a']],['',[]]
  ];
  for(const [source,want]of cases)expect(tokenizeLyrics(source),source).toEqual(want);
});

it('distributes_five_lines_on_first_staff_voice_zero',()=>{
  const score=fixture(),first=beats(score),otherVoice=beats(score,0,0,1),second=beats(score,0,1),otherTrack=beats(score,1);
  first[1].notes=[];otherVoice[0].lyrics=['stale'];second[0].lyrics=['second staff'];otherTrack[0].lyrics=['other track'];
  const lines=[{startBar:0,text:'one  two+words'},{startBar:1,text:'verse two'},{startBar:2,text:''},{startBar:0,text:'four'},{startBar:3,text:'five'}];
  expect(applyLyricsEdit(score,command(lines))).toBe(true);
  expect([first[0],first[2],first[3]].map(b=>b.lyrics?.[0])).toEqual(['one','','two words']);
  expect(first[0].lyrics).toEqual(['one','','','four','']);expect(first[4].lyrics).toEqual(['','verse','','','']);expect(first[12].lyrics).toEqual(['','','','','five']);
  expect(first[1].lyrics).toBeNull();expect(otherVoice[0].lyrics).toBeNull();expect(second[0].lyrics).toEqual(['second staff']);expect(otherTrack[0].lyrics).toEqual(['other track']);
  expect(getTrackLyrics(score,0)).toEqual({visible:true,lines,source:'raw'});
});

it('includes_tied_continuations_and_grace_beats_as_eligible_syllables',()=>{
  const score=fixture(),first=beats(score);first[1].notes[0].isTieDestination=true;first[2].graceType=model.GraceType.BeforeBeat;
  applyLyricsEdit(score,command([{startBar:0,text:'one two three four'}]));
  expect(first.slice(0,4).map(b=>b.lyrics)).toEqual([['one'],['two'],['three'],['four']]);
});

it('shorten_hide_remove_clear_previous_assignments',()=>{
  const score=fixture(),first=beats(score),raw='[VERSE]\nlong  words+joined end';
  applyLyricsEdit(score,command([{startBar:0,text:raw},{startBar:0,text:'second verse'}]));
  applyLyricsEdit(score,command([{startBar:0,text:'short'}]));
  expect(first.slice(0,4).map(b=>b.lyrics)).toEqual([['short'],null,null,null]);
  applyLyricsEdit(score,command([{startBar:0,text:raw}],false));
  expect(first.every(b=>b.lyrics===null)).toBe(true);expect(getTrackLyrics(score,0).lines).toEqual([{startBar:0,text:raw}]);
  applyLyricsEdit(score,command([{startBar:0,text:raw}]));expect(first[0].lyrics).toEqual(['long']);
  applyLyricsEdit(score,command([]));expect(first.every(b=>b.lyrics===null)).toBe(true);expect(getTrackLyrics(score,0).lines).toEqual([]);
});

it('invalid_line_six_is_atomic',()=>{
  const score=fixture();applyLyricsEdit(score,command([{startBar:0,text:'keep this'}]));
  const valid=command([{startBar:0,text:'replacement'}]),bad:unknown[]=[
    {...valid,lines:Array.from({length:6},()=>({startBar:0,text:'too many'}))},
    ...[-1,0.5,4,NaN,2**32].map(startBar=>({...valid,lines:[{startBar,text:'bad'}]})),
    {...valid,unknown:true},{...valid,visible:0},{...valid,track:-1},{...valid,track:2**32},{...valid,track:2},
    {...valid,lines:[{startBar:0,text:'bad',unknown:true}]},{...valid,lines:[{startBar:0}]},
    {...valid,lines:[{text:'bad'}]},{...valid,lines:[{startBar:0,text:5}]},{...valid,lines:null},
    {type:'setTrackLyrics',track:0,lines:[]},{type:'setTrackLyrics',visible:true,lines:[]},
    {type:'setTrackLyrics',track:0,visible:true}
  ];
  const json=model.JsonConverter.scoreToJson(score),source=getTrackLyrics(score,0);
  for(const value of bad) {
    expect(()=>applyLyricsEdit(score,value as LyricsCommand),JSON.stringify(value)).toThrow();
    expect(model.JsonConverter.scoreToJson(score)).toBe(json);expect(getTrackLyrics(score,0)).toEqual(source);
  }
});

it('raw_source_survives_explicit_clone_cache_transfer',()=>{
  const score=fixture(),lines=[{startBar:1,text:'[VERSE]\r\nHel-lo  world+today'},{startBar:3,text:''}];
  applyLyricsEdit(score,command(lines));
  const clone=scoreFromJson(model.JsonConverter.scoreToJson(score),new Settings());
  expect(getTrackLyrics(clone,0).source).toBe('distributed');
  copyLyricsSources(score,clone);expect(getTrackLyrics(clone,0)).toEqual({visible:true,lines,source:'raw'});
  const draft=getTrackLyrics(clone,0);draft.lines[0].text='mutated draft';draft.lines.push({startBar:0,text:'another'});
  lines[0].text='mutated payload';expect(getTrackLyrics(clone,0).lines).toEqual([{startBar:1,text:'[VERSE]\r\nHel-lo  world+today'},{startBar:3,text:''}]);
  beats(clone)[4].notes=[];reflowLyrics(clone);expect(beats(clone)[4].lyrics).toBeNull();expect(beats(clone)[5].lyrics).toEqual(['Hel-','']);
  expect(beats(score)[4].lyrics).toEqual(['Hel-','']);
});

it('reconstructs_distributed_only_source_with_gaps_without_writing',()=>{
  const score=fixture(),first=beats(score);first[4].lyrics=['Hel-','',''];first[5].lyrics=['lo','',''];first[7].lyrics=['joined words','','third'];
  const json=model.JsonConverter.scoreToJson(score);
  expect(getTrackLyrics(score,0)).toEqual({visible:true,source:'distributed',lines:[{startBar:1,text:'Hel-lo  joined+words'},{startBar:0,text:''},{startBar:1,text:'   third'}]});
  expect(model.JsonConverter.scoreToJson(score)).toBe(json);
});
it('reconstructed_source_retains_eligible_gaps_before_first_syllable_in_its_measure',()=>{
  const score=fixture();beats(score)[5].lyrics=['word'];
  expect(getTrackLyrics(score,0).lines).toEqual([{startBar:1,text:' word'}]);
});

function deleteBar(score:model.Score,bar:number) {
  removeLyricsMeasure(score,bar);score.masterBars.splice(bar,1);score.masterBars.forEach((b,i)=>b.index=i);
  for(const track of score.tracks)for(const staff of track.staves){staff.bars.splice(bar,1);staff.bars.forEach((b,i)=>b.index=i);}
  score.finish(new Settings());reflowLyrics(score);
}
it('structural_reflow_keeps_track_and_line_identity',()=>{
  const score=fixture();applyLyricsEdit(score,{...command([{startBar:1,text:'stays with track'}]),track:1});
  score.tracks.splice(0,1);score.tracks[0].index=0;reflowLyrics(score);
  expect(getTrackLyrics(score,0)).toMatchObject({source:'raw',lines:[{startBar:1,text:'stays with track'}]});
  expect(beats(score)[4].lyrics).toEqual(['stays']);
  for(const [removed,start,want]of [[0,2,1],[2,2,2],[3,2,2],[3,3,2]] as const) {
    const fresh=fixture();applyLyricsEdit(fresh,command([{startBar:start,text:'word'}]));deleteBar(fresh,removed);
    expect(getTrackLyrics(fresh,0).lines).toEqual([{startBar:want,text:'word'}]);expect(beats(fresh)[want*4].lyrics).toEqual(['word']);
  }
});
it('reflows_managed_source_onto_changed_first_staff_and_voice_and_clears_rests',()=>{
  const score=fixture();applyLyricsEdit(score,command([{startBar:0,text:'one two'}]));
  const first=beats(score);first[0].notes=[];first[1].isEmpty=true;beats(score,0,0,1)[0].lyrics=['stale'];
  reflowLyrics(score);expect(first.slice(0,4).map(b=>b.lyrics)).toEqual([null,null,['one'],['two']]);expect(beats(score,0,0,1)[0].lyrics).toBeNull();
  score.tracks[0].staves[0].bars.forEach(bar=>bar.voices.splice(0,1));reflowLyrics(score);
  expect(beats(score)[0].lyrics).toEqual(['one']);expect(beats(score)[1].lyrics).toEqual(['two']);
  score.tracks[0].staves.splice(0,1);reflowLyrics(score);expect(beats(score)[0].lyrics).toEqual(['one']);expect(beats(score)[1].lyrics).toEqual(['two']);
});
it('preserves_unmanaged_import_distribution_across_clone_and_reflow',()=>{
  const score=fixture(),raw={visible:true,lines:[{startBar:1,text:'[IMPORTED] original raw'}]};
  beats(score)[0].lyrics=['independent'];setLyricsSource(score.tracks[0],raw,false);
  const clone=scoreFromJson(model.JsonConverter.scoreToJson(score),new Settings());copyLyricsSources(score,clone);
  beats(clone)[0].notes=[];reflowLyrics(clone);
  expect(beats(clone)[0].lyrics).toEqual(['independent']);expect(beats(clone)[4].lyrics).toBeNull();expect(getTrackLyrics(clone,0)).toEqual({...raw,source:'raw'});
});
it('keeps_unmanaged_hidden_source_hidden_after_first_staff_changes',()=>{
  const score=fixture(),raw={visible:false,lines:[{startBar:1,text:'[HIDDEN] exact raw'}]};
  setLyricsSource(score.tracks[0],raw,false);beats(score,0,1)[0].lyrics=['new first staff'];
  score.tracks[0].staves.splice(0,1);reflowLyrics(score);
  expect(beats(score)[0].lyrics).toBeNull();expect(getTrackLyrics(score,0)).toEqual({...raw,source:'raw'});
});
