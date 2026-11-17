import { describe,expect,it } from 'vitest';
import { model,Settings } from '@coderline/alphatab';
import { scoreFromJson } from '../model-clone';
import { standardPercussionCatalog } from '../editor/percussion-catalog';
import { assignDrumTabLines,convertDrumTabJson,drumTabLine,drumTabNumber,DRUM_TAB_LINES,DRUM_TAB_TUNING,hideDrumTabTuning } from './drum-tab';

const plain=()=>new model.Track();
const hit=(percussionArticulation:number)=>({percussionArticulation});

describe('drumTabNumber and drumTabLine over the whole standard catalogue',()=>{
  const ids=[...new Set(standardPercussionCatalog.map(entry=>entry.id))];
  const onLine=(line:number)=>ids.filter(id=>drumTabLine(plain(),hit(id))===line);
  it('gives every standard articulation a line 1-6 and its own id as a number 0-127',()=>{
    for(const id of ids){
      const line=drumTabLine(plain(),hit(id)),number=drumTabNumber(plain(),hit(id));
      expect(line,`line of ${id}`).toBeGreaterThanOrEqual(1);expect(line,`line of ${id}`).toBeLessThanOrEqual(DRUM_TAB_LINES);
      expect(number,`number of ${id}`).toBe(id);expect(number!).toBeGreaterThanOrEqual(0);expect(number!).toBeLessThanOrEqual(127);
    }
  });
  it('puts crashes, china, splash, reverse and clash cymbals on line 1',()=>{
    expect(onLine(1)).toEqual([55,95,52,96,49,97,57,98,115,116,30]);
  });
  it('puts the hi-hat family on line 3, the toms on 4, the snare family on 5 and the kicks on 6',()=>{
    expect(onLine(3)).toEqual([42,92,46,44]);
    expect(onLine(4)).toEqual([50,48,47,45,43,41]);
    expect(onLine(5)).toEqual([38,37,91,39,40,31]);
    expect(onLine(6)).toEqual([35,36]);
  });
  it('lists the rides, bells and other metal or percussion under line 2, and every id on exactly one line',()=>{
    const other=onLine(2);
    expect(other).toEqual([93,51,53,94,99,100,56,101,102,103,77,76,60,104,105,61,106,107,66,65,68,67,64,108,109,63,110,62,72,71,73,74,86,87,54,111,112,113,79,78,58,81,80,114,69,117,85,75,70,118,119,120,82,122,84,123,83,124,125,59,126,127,29,33,34]);
    expect([1,2,3,4,5,6].flatMap(onLine).sort((a,b)=>a-b)).toEqual([...ids].sort((a,b)=>a-b));
  });
  it('writes the standard id, so half-open hi-hat is 92, rim shot 91, ride edge 93 and chokes 94-98',()=>{
    expect([92,91,93,94,95,96,97,98].map(id=>drumTabNumber(plain(),hit(id)))).toEqual([92,91,93,94,95,96,97,98]);
  });
});

describe('articulations of a track with its own table',()=>{
  it('writes the standard id a table entry copies, and the output key of one that copies none',()=>{
    const track=plain();
    track.percussionArticulations=[
      new model.InstrumentArticulation('Snare',3,38,model.MusicFontSymbol.NoteheadBlack,model.MusicFontSymbol.NoteheadHalf,model.MusicFontSymbol.NoteheadWhole),
      new model.InstrumentArticulation('Mystery drum',3,20,model.MusicFontSymbol.NoteheadBlack,model.MusicFontSymbol.NoteheadHalf,model.MusicFontSymbol.NoteheadWhole),
    ];
    expect(drumTabNumber(track,hit(0))).toBe(38);expect(drumTabLine(track,hit(0))).toBe(5);
    expect(drumTabNumber(track,hit(1))).toBe(20);expect(drumTabLine(track,hit(1))).toBe(2);
  });
  it('leaves a note whose articulation resolves to nothing without a number and a line',()=>{
    expect(drumTabNumber(plain(),hit(5))).toBeNull();expect(drumTabLine(plain(),hit(5))).toBeNull();
    expect(drumTabNumber(plain(),hit(-1))).toBeNull();
  });
});

describe('assignDrumTabLines',()=>{
  const c=(number:number,line:number)=>({number,line});
  it('gives separate pieces their own lines: kick, snare, hat and crash',()=>{
    expect(assignDrumTabLines([c(49,1),c(42,3),c(38,5),c(36,6)])).toEqual({lines:[1,3,5,6],surplus:0});
  });
  it('moves the higher of two toms to the free line above',()=>{
    expect(assignDrumTabLines([c(47,4),c(45,4)])).toEqual({lines:[3,4],surplus:0});
  });
  it('lets every hit keep its own line first, then moves the displaced one to the nearest free line, above before below',()=>{
    // 45 keeps 4 and the hat keeps 3; 47 is displaced, line 3 above is taken, so the nearest free line is 5 below... at distance 1 the line above (3) is tried first, then 5.
    expect(assignDrumTabLines([c(42,3),c(47,4),c(45,4)])).toEqual({lines:[3,5,4],surplus:0});
    expect(assignDrumTabLines([c(36,6),c(38,5),c(40,5)])).toEqual({lines:[6,5,4],surplus:0});
  });
  it('writes six simultaneous hits one per line and leaves the seventh off, counted',()=>{
    expect(assignDrumTabLines([c(49,1),c(51,2),c(42,3),c(45,4),c(38,5),c(36,6)])).toEqual({lines:[1,2,3,4,5,6],surplus:0});
    const seven=assignDrumTabLines([c(49,1),c(51,2),c(42,3),c(45,4),c(38,5),c(36,6),c(55,1)]);
    expect(seven.surplus).toBe(1);expect(seven.lines.filter(line=>line!==null).sort()).toEqual([1,2,3,4,5,6]);
    // The second crash finds no free line: the first crash (49) keeps line 1.
    expect(seven.lines.indexOf(null)).toBe(6);expect(seven.lines.slice(0,6)).toEqual([1,2,3,4,5,6]);
    const nine=assignDrumTabLines(Array.from({length:9},(_,i)=>c(36+i,6)));
    expect(nine.surplus).toBe(3);expect(nine.lines.filter(line=>line!==null)).toHaveLength(6);
  });
  it('is stable: the same hits get the same lines in any storage order, and repeated calls agree',()=>{
    const hits=[c(36,6),c(38,5),c(42,3),c(49,1),c(47,4),c(45,4),c(41,4)];
    const base=assignDrumTabLines(hits),byNumber=new Map(hits.map((entry,i)=>[entry.number,base.lines[i]]));
    expect(assignDrumTabLines(hits)).toEqual(base);
    for(const order of [[...hits].reverse(),[hits[3],hits[0],hits[5],hits[1],hits[6],hits[2],hits[4]]]){
      const result=assignDrumTabLines(order);
      expect(new Map(order.map((entry,i)=>[entry.number,result.lines[i]]))).toEqual(byNumber);
    }
  });
  it('treats an empty beat as nothing to place',()=>{expect(assignDrumTabLines([])).toEqual({lines:[],surplus:0});});
});

function drumSource(beats:number[][],ghost=false) {
  const score=new model.Score(),track=new model.Track();track.name='Drums';
  const staff=new model.Staff();staff.isPercussion=true;track.addStaff(staff);score.addTrack(track);
  score.addMasterBar(new model.MasterBar());
  const bar=new model.Bar(),voice=new model.Voice();
  beats.forEach((ids,beatIndex)=>{
    const beat=new model.Beat();beat.duration=4;beat.isEmpty=false;
    for(const id of ids){const note=new model.Note();note.percussionArticulation=id;if(ghost&&beatIndex===0)note.isGhost=true;note.isDead=id===37;beat.addNote(note);}
    voice.addBeat(beat);
  });
  bar.addVoice(voice);staff.addBar(bar);score.finish(new Settings());return score;
}
type J=Record<string,any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const jsonOf=(score:model.Score):J=>JSON.parse(model.JsonConverter.scoreToJson(score)) as J;
const staffNotes=(staff:J)=>staff.bars.flatMap((bar:J)=>bar.voices.flatMap((voice:J)=>voice.beats.map((beat:J)=>beat.notes))) as J[][];
const written=(notes:J[])=>notes.map(n=>`${n.fret}@${DRUM_TAB_LINES+1-n.string}`);

describe('convertDrumTabJson',()=>{
  const beats=[[36,42,49],[38,42],[47,45],[91,53]];
  it('tab mode replaces the percussion staff with a six-line tab staff of numbers and keeps rhythm and ids',()=>{
    const source=drumSource(beats),json=jsonOf(source),original=jsonOf(source);
    const report=convertDrumTabJson(json,source,new Map([[0,'tab']]));
    const staves=json.tracks[0].staves as J[];
    expect(staves).toHaveLength(1);
    expect(staves[0]).toMatchObject({ispercussion:false,showtablature:true,showstandardnotation:false,showslash:false,shownumbered:false,stringtuning:{tunings:[...DRUM_TAB_TUNING]}});
    expect(staffNotes(staves[0]).map(written)).toEqual([['49@1','42@3','36@6'],['42@3','38@5'],['47@3','45@4'],['53@2','91@5']]);
    const durations=(staff:J)=>staff.bars[0].voices[0].beats.map((b:J)=>[b.duration,b.id]);
    expect(durations(staves[0])).toEqual(durations(original.tracks[0].staves[0]));
    for(const [rendered,src] of report.notes)expect(rendered).toBe(src);
    expect(report.notes.size).toBe(9);
    expect(report.hiddenTuningTracks).toEqual([0]);expect(json.stylesheet.pertrackdisplaytuning).toEqual({'0':false});
  });
  it('keeps six hits of a crowded beat on the tab and counts the rest',()=>{
    const source=drumSource([[36,38,42,45,51,49,55]]),json=jsonOf(source);
    const report=convertDrumTabJson(json,source,new Map([[0,'tab']]));
    const [notes]=staffNotes(json.tracks[0].staves[0]);
    expect(notes).toHaveLength(6);expect(notes.map(n=>DRUM_TAB_LINES+1-n.string)).toEqual([1,2,3,4,5,6]);
    expect(report.surplusNotes).toHaveLength(1);
    expect(new Set(report.notes.values()).has(report.surplusNotes[0])).toBe(false);
  });
  it('both mode keeps the percussion staff untouched and appends a tab staff with fresh unique ids',()=>{
    const source=drumSource(beats,true),json=jsonOf(source),original=jsonOf(source);
    const report=convertDrumTabJson(json,source,new Map([[0,'both']]));
    const staves=json.tracks[0].staves as J[];
    expect(staves).toHaveLength(2);
    expect(JSON.stringify(staves[0])).toBe(JSON.stringify(original.tracks[0].staves[0]));
    expect(staves[0].ispercussion).toBe(true);expect(staves[1].ispercussion).toBe(false);expect(staves[1].showtablature).toBe(true);
    const flat=(staff:J,pick:(beat:J)=>number[])=>staff.bars.flatMap((bar:J)=>bar.voices.flatMap((voice:J)=>voice.beats.flatMap(pick))) as number[];
    const noteIds=[...flat(staves[0],b=>b.notes.map((n:J)=>n.id)),...flat(staves[1],b=>b.notes.map((n:J)=>n.id))];
    const beatIds=[...flat(staves[0],b=>[b.id]),...flat(staves[1],b=>[b.id])];
    expect(new Set(noteIds).size).toBe(noteIds.length);expect(new Set(beatIds).size).toBe(beatIds.length);
    const sourceNotes=source.tracks[0].staves[0].bars[0].voices[0].beats.flatMap(beat=>beat.notes),sourceBeats=source.tracks[0].staves[0].bars[0].voices[0].beats;
    const byId=new Map(sourceNotes.map(n=>[n.id,n]));
    for(const [rendered,src] of report.notes){expect(rendered).not.toBe(src);expect(byId.has(src)).toBe(true);}
    expect([...report.notes.keys()].sort((a,b)=>a-b)).toEqual(flat(staves[1],b=>b.notes.map((n:J)=>n.id)).sort((a,b)=>a-b));
    // The mapped note is the one the tab note was made from: its number is the source note's written id.
    for(const note of staffNotes(staves[1]).flat())expect(note.fret).toBe(byId.get(report.notes.get(note.id)!)!.percussionArticulation);
    expect(report.beats.size).toBe(beats.length);
    for(const [renderedBeat,sourceBeat] of report.beats){expect(sourceBeats.some(b=>b.id===sourceBeat)).toBe(true);expect(renderedBeat).not.toBe(sourceBeat);}
  });
  it('keeps ghost notes, drops dead notes, and does not repeat text or lyrics on the second staff',()=>{
    const source=drumSource([[38,37]],true),json=jsonOf(source);
    const beat=json.tracks[0].staves[0].bars[0].voices[0].beats[0];beat.text='fill';beat.lyrics=['la'];
    const alone=JSON.parse(JSON.stringify(json)) as J;
    convertDrumTabJson(json,source,new Map([[0,'both']]));
    const tab=json.tracks[0].staves[1].bars[0].voices[0].beats[0];
    expect(tab.text).toBeNull();expect(tab.lyrics).toBeNull();
    expect(tab.notes.every((n:J)=>n.isghost===true)).toBe(true);
    expect(tab.notes.every((n:J)=>n.isdead===false)).toBe(true);
    convertDrumTabJson(alone,source,new Map([[0,'tab']]));
    expect(alone.tracks[0].staves[0].bars[0].voices[0].beats[0].text).toBe('fill');
  });
  it('is deterministic and leaves the source score and its JSON untouched',()=>{
    const source=drumSource(beats),sourceJson=model.JsonConverter.scoreToJson(source);
    const run=(mode:'tab'|'both')=>{const json=JSON.parse(sourceJson) as J;const report=convertDrumTabJson(json,source,new Map([[0,mode]]));return JSON.stringify([json,[...report.notes],[...report.beats],report.surplusNotes]);};
    expect(run('tab')).toBe(run('tab'));expect(run('both')).toBe(run('both'));
    expect(model.JsonConverter.scoreToJson(source)).toBe(sourceJson);
    expect(source.tracks[0].staves).toHaveLength(1);expect(source.tracks[0].staves[0].isPercussion).toBe(true);
  });
  it('leaves tracks that are not asked for alone',()=>{
    const source=drumSource([[36]]),json=jsonOf(source),before=JSON.stringify(json);
    const report=convertDrumTabJson(json,source,new Map());
    expect(JSON.stringify(json)).toBe(before);expect(report.notes.size).toBe(0);expect(report.hiddenTuningTracks).toEqual([]);
  });
  it('reports a note whose articulation resolves to nothing and draws the others',()=>{
    const source=drumSource([[36]]),json=jsonOf(source);
    const notes=json.tracks[0].staves[0].bars[0].voices[0].beats[0].notes as J[];
    notes.push({...notes[0],id:77,percussionarticulation:5});
    const report=convertDrumTabJson(json,source,new Map([[0,'tab']]));
    expect(report.unresolvedNotes).toEqual([77]);expect(staffNotes(json.tracks[0].staves[0])[0]).toHaveLength(1);
  });
});

describe('ties on the tab',()=>{
  it('keeps a tie only between hits written alike: an equal number moved to another line is not tied, and the JSON names no tie partner',()=>{
    // 38 and 91 both want line 5: 91 is moved to line 4, and the lone 91 after it sits on line 5.
    const source=drumSource([[38,91],[91]]),json=jsonOf(source);
    const [first,second]=json.tracks[0].staves[0].bars[0].voices[0].beats as J[];
    const moved=first.notes.find((n:J)=>n.percussionarticulation===91),lone=second.notes[0];
    moved.tiedestinationnoteid=lone.id;lone.tieoriginnoteid=moved.id;lone.istiedestination=true;
    const report=convertDrumTabJson(json,source,new Map([[0,'tab']]));
    expect(report.ties).toEqual([]);
    expect(JSON.stringify(json.tracks[0].staves[0])).not.toMatch(/tie(?:origin|destination)noteid/);
  });
  it('keeps the tie of two equal hits on one line, by the ids the tab notes got',()=>{
    const source=drumSource([[49],[49]]),json=jsonOf(source);
    const [first,second]=json.tracks[0].staves[0].bars[0].voices[0].beats as J[];
    first.notes[0].tiedestinationnoteid=second.notes[0].id;second.notes[0].tieoriginnoteid=first.notes[0].id;second.notes[0].istiedestination=true;
    const report=convertDrumTabJson(json,source,new Map([[0,'both']]));
    const tab=json.tracks[0].staves[1].bars[0].voices[0].beats as J[];
    expect(report.ties).toEqual([{from:tab[0].notes[0].id,to:tab[1].notes[0].id}]);
  });
  it('builds a score when a note shares its tie origin with a destination that was left off the tab',()=>{
    const source=drumSource([[36],[36,38,42,45,51,49,55]]),json=jsonOf(source);
    const [first,crowd]=json.tracks[0].staves[0].bars[0].voices[0].beats as J[];
    const probe=JSON.parse(JSON.stringify(json)) as J;
    const surplus=convertDrumTabJson(probe,source,new Map([[0,'tab']])).surplusNotes[0],written=crowd.notes.find((n:J)=>n.id!==surplus&&n.percussionarticulation===38);
    first.notes[0].tiedestinationnoteid=surplus;
    for(const id of [surplus,written.id]){const note=crowd.notes.find((n:J)=>n.id===id);note.tieoriginnoteid=first.notes[0].id;note.istiedestination=true;}
    convertDrumTabJson(json,source,new Map([[0,'tab']]));
    expect(()=>scoreFromJson(JSON.stringify(json) as never,new Settings())).not.toThrow();
  });
});

describe('hideDrumTabTuning',()=>{
  it('marks the tracks as hiding their tuning on a finished copy, keeping other entries',()=>{
    const score=drumSource([[36]]);score.stylesheet.perTrackDisplayTuning=new Map([[3,true]]);
    hideDrumTabTuning(score,[0]);expect(score.stylesheet.perTrackDisplayTuning).toEqual(new Map([[3,true],[0,false]]));
    const bare=drumSource([[36]]);hideDrumTabTuning(bare,[]);expect(bare.stylesheet.perTrackDisplayTuning).toBeNull();
  });
});
