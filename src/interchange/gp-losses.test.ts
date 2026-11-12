// @vitest-environment jsdom
import { describe,expect,it,vi } from 'vitest';
import { model,Settings } from '@coderline/alphatab';
import { strFromU8,strToU8,unzipSync,zipSync } from 'fflate';
import { applyHarmonyEdit } from '../harmony/edits';
import { selectScore } from '../export/selection';
import { exportGpInterchange,loadInterchangeScore } from './gp';
import { gpExportRefusal,gpLosses } from './gp-losses';
import { projectGpDocument } from './backing-projection';
import { defaultDocumentSettings } from '../document-settings';
import { curveLosses } from './curves';
import { readLegacyStylesheetSymbol } from './stylesheet-legacy';
import { setTimeSignatureIntent } from '../editor/time-signature-source';

const settings=new Settings();
const gpif='Content/score.gpif';

/** A guitar score of `bars` bars of four quarter notes on string 6, `tracks` tracks alike. */
function build(bars:number,tracks=1):model.Score {
  const score=new model.Score();
  for(let t=0;t<tracks;t++){
    const track=new model.Track();track.name=`Track ${t+1}`;track.playbackInfo.program=25;
    const staff=new model.Staff();staff.stringTuning.tunings=[64,59,55,50,45,40];track.addStaff(staff);score.addTrack(track);
  }
  for(let i=0;i<bars;i++){
    score.addMasterBar(new model.MasterBar());
    for(const track of score.tracks){
      const bar=new model.Bar();bar.clef=model.Clef.G2;const voice=new model.Voice();
      for(let b=0;b<4;b++){const beat=new model.Beat();beat.duration=4;beat.isEmpty=false;const note=new model.Note();note.string=6;note.fret=3;beat.addNote(note);voice.addBeat(beat);}
      bar.addVoice(voice);track.staves[0].addBar(bar);
    }
  }
  score.finish(settings);return score;
}
const noteAt=(score:model.Score,bar:number,beat:number,track=0)=>score.tracks[track].staves[0].bars[bar].voices[0].beats[beat].notes[0];
const tie=(from:model.Note,to:model.Note)=>{from.tieDestination=to;to.tieOrigin=from;to.isTieDestination=true;};
const hammer=(from:model.Note,to:model.Note)=>{from.hammerPullDestination=to;from.isHammerPullOrigin=true;to.hammerPullOrigin=from;};
const slide=(from:model.Note,to:model.Note)=>{from.slideTarget=to;from.slideOutType=model.SlideOutType.Legato;to.slideOrigin=from;};
const slur=(from:model.Note,to:model.Note)=>{from.slurDestination=to;to.slurOrigin=from;to.isSlurDestination=true;};

/** The GPIF document of an exported file, read here and not by alphaTab's reader. */
function written(bytes:Uint8Array) {
  const xml=strFromU8(unzipSync(bytes)[gpif]),doc=new DOMParser().parseFromString(xml,'application/xml');
  return {xml,doc};
}
const kids=(node:Element|null|undefined,name:string)=>node?[...node.children].filter(child=>child.localName===name):[];
const ids=(node:Element|null|undefined,name:string)=>(kids(node,name)[0]?.textContent??'').trim().split(/\s+/).filter(id=>id&&id!=='-1');
const byId=(doc:Document,section:string,name:string)=>new Map(kids(kids(doc.documentElement,section)[0],name).map(node=>[node.getAttribute('id')!,node]));
/** For every note id of the first staff of the first track, the master bar it sits in, from the file's own id lists. */
function barOfNotes(doc:Document):Map<string,number> {
  const bars=byId(doc,'Bars','Bar'),voices=byId(doc,'Voices','Voice'),beats=byId(doc,'Beats','Beat'),result=new Map<string,number>();
  kids(kids(doc.documentElement,'MasterBars')[0],'MasterBar').forEach((master,index)=>{
    const bar=bars.get(ids(master,'Bars')[0]);
    for(const voiceId of ids(bar,'Voices'))for(const beatId of ids(voices.get(voiceId),'Beats'))for(const noteId of ids(beats.get(beatId),'Notes'))result.set(noteId,index);
  });
  return result;
}
const noteNodes=(doc:Document)=>byId(doc,'Notes','Note');
const hasProperty=(note:Element|undefined,name:string)=>kids(kids(note,'Properties')[0],'Property').some(property=>property.getAttribute('name')===name);
const propertyNamed=(note:Element|undefined,prefix:string)=>kids(kids(note,'Properties')[0],'Property').some(property=>(property.getAttribute('name')??'').startsWith(prefix));

/** `bars` bars of rests; `put` then places single notes where a test wants them. */
const bare=(bars:number)=>{
  const score=build(bars);
  for(const bar of score.tracks[0].staves[0].bars)for(const beat of bar.voices[0].beats)beat.notes.length=0;
  return score;
};
const put=(score:model.Score,bar:number,beat:number,string:number)=>{
  const holder=score.tracks[0].staves[0].bars[bar].voices[0].beats[beat],note=new model.Note();note.string=string;note.fret=3;holder.addNote(note);return note;
};

describe('GP 7/8 export loss list',()=>{
  it('reports nothing for links the reader restores to the same notes, and nothing for an ordinary score',()=>{
    const score=build(6);tie(noteAt(score,0,0),noteAt(score,0,1));hammer(noteAt(score,1,3),noteAt(score,2,0));slide(noteAt(score,3,0),noteAt(score,3,1));
    expect(gpLosses(score)).toEqual(curveLosses(score));
    expect(gpLosses(score)).toEqual([]);
    expect(gpLosses(build(0))).toEqual([]);
  });

  it('reports ties, hammer-ons and slides the reader cannot restore, from the links the file really holds',()=>{
    const score=bare(8);
    // One string per link, so each search can only find its own notes.
    tie(put(score,0,0,6),put(score,4,0,6));tie(put(score,1,1,5),put(score,5,1,5));tie(put(score,0,2,4),put(score,3,2,4));
    hammer(put(score,2,0,3),put(score,6,0,3));
    slide(put(score,0,3,2),put(score,4,3,2));
    const losses=gpLosses(score);
    expect(losses).toEqual([
      '2 ties will not be linked to the same notes when this file is opened again (first at track 1, bar 1, beat 1)',
      '1 hammer-on or pull-off will not be linked to the same notes when this file is opened again (first at track 1, bar 3, beat 1)',
      '1 slide will not be linked to the same notes when this file is opened again (first at track 1, bar 1, beat 4)',
    ]);
    // The bytes: alphaTab writes only flags, and the far destinations sit four bars after their origins in the file's own lists.
    const {doc}=written(exportGpInterchange(score,settings)),barOf=barOfNotes(doc),notes=noteNodes(doc);
    const withTie=(flag:'origin'|'destination')=>[...notes].filter(([,node])=>kids(node,'Tie')[0]?.getAttribute(flag)==='true').map(([id])=>barOf.get(id)!).sort((a,b)=>a-b);
    expect(withTie('origin')).toEqual([0,0,1]);expect(withTie('destination')).toEqual([3,4,5]);
    expect([...notes.values()].filter(node=>hasProperty(node,'HopoOrigin'))).toHaveLength(1);
  });

  it('links a tie up to three bars ahead and not four',()=>{
    const score=bare(6);
    tie(put(score,0,0,6),put(score,3,0,6));
    expect(gpLosses(score)).toEqual([]);
    tie(put(score,1,1,5),put(score,5,1,5));
    expect(gpLosses(score)).toEqual(['1 tie will not be linked to the same notes when this file is opened again (first at track 1, bar 2, beat 2)']);
  });

  describe('hammer-ons and slides follow the reader search, not a bar count',()=>{
    // gp-link-search.test.ts pins the reader: later beats of the origin bar, then the first beat of the next bar; the first note on the string wins.
    const T=true,R=false;
    /** `layout[bar][beat]` says whether the beat keeps its note; the rest become rests. */
    function sparse(layout:boolean[][]) {
      const score=build(layout.length);
      layout.forEach((beats,bar)=>beats.forEach((keep,beat)=>{if(!keep)score.tracks[0].staves[0].bars[bar].voices[0].beats[beat].notes.length=0;}));
      return score;
    }
    const cases:[string,boolean[][],[number,number],[number,number],boolean][]=[
      ['the next beat of the same bar',[[T,T,R,R]],[0,0],[0,1],false],
      ['a later beat with a rest between',[[T,R,T,R]],[0,0],[0,2],false],
      ['the first beat of the next bar after rests',[[T,R,R,R],[T,R,R,R]],[0,0],[1,0],false],
      ['the first beat of the next bar from the last beat',[[R,R,R,T],[T,R,R,R]],[0,3],[1,0],false],
      ['the second beat of the next bar',[[T,R,R,R],[R,T,R,R]],[0,0],[1,1],true],
      ['the first beat of the bar after next',[[T,R,R,R],[R,R,R,R],[T,R,R,R]],[0,0],[2,0],true],
      ['a later beat past a nearer note on the same string',[[T,T,T,R]],[0,0],[0,2],true],
    ];
    it.each(cases)('hammer-on: %s',(_name,layout,[fromBar,fromBeat],[toBar,toBeat],lost)=>{
      const score=sparse(layout);hammer(noteAt(score,fromBar,fromBeat),noteAt(score,toBar,toBeat));
      expect(gpLosses(score)).toEqual(lost?[`1 hammer-on or pull-off will not be linked to the same notes when this file is opened again (first at track 1, bar ${fromBar+1}, beat ${fromBeat+1})`]:[]);
    });
    it.each(cases)('slide: %s',(_name,layout,[fromBar,fromBeat],[toBar,toBeat],lost)=>{
      const score=sparse(layout);slide(noteAt(score,fromBar,fromBeat),noteAt(score,toBar,toBeat));
      expect(gpLosses(score)).toEqual(lost?[`1 slide will not be linked to the same notes when this file is opened again (first at track 1, bar ${fromBar+1}, beat ${fromBeat+1})`]:[]);
    });
    it('treats a shift slide like a legato slide, and leaves a slide with no target alone',()=>{
      const far=sparse([[T,R,R,R],[R,T,R,R]]);slide(noteAt(far,0,0),noteAt(far,1,1));noteAt(far,0,0).slideOutType=model.SlideOutType.Shift;
      expect(gpLosses(far)).toHaveLength(1);
      const none=sparse([[T,R,R,R],[R,T,R,R]]);noteAt(none,0,0).slideOutType=model.SlideOutType.OutDown;
      expect(gpLosses(none)).toEqual([]);
    });
  });

  it('counts a sounding length outside 0 to 16 separately: it is written, and the reader refuses it',()=>{
    const score=build(1);noteAt(score,0,0).durationPercent=20;noteAt(score,0,1).durationPercent=Number.NaN;noteAt(score,0,2).durationPercent=0.5;
    expect(gpLosses(score)).toEqual([
      '1 note has a sounding length that is written only for TabPlayer (first at track 1, bar 1, beat 3)',
      '2 notes have a sounding length outside 0 to 16 that will not be read back (first at track 1, bar 1, beat 1)',
    ]);
    const bytes=exportGpInterchange(score,settings),{doc}=written(bytes),items=[...doc.querySelectorAll('Property[name="TabPlayerCurves"] > Items > Note')];
    expect(items.map(item=>item.getAttribute('durationPercent'))).toEqual(['20','NaN','0.5']);
    const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
    const reread=loadInterchangeScore(bytes,settings).tracks[0].staves[0].bars[0].voices[0].beats;
    expect(reread.map(beat=>beat.notes[0].durationPercent)).toEqual([1,1,0.5,1]);expect(warn).toHaveBeenCalledTimes(2);
  });

  it('agrees with the writer on which notes carry a length or a hidden flag: every note of a voice that is not empty, and none of an empty voice',()=>{
    const score=build(2);
    noteAt(score,0,0).durationPercent=0.5;noteAt(score,0,1).isVisible=false;
    // An empty voice (every beat a placeholder) is skipped by both the writer and the list.
    const bar=score.tracks[0].staves[0].bars[1].voices[0];for(const beat of bar.beats){beat.isEmpty=true;beat.notes[0].durationPercent=0.25;}
    score.finish(settings);
    const losses=gpLosses(score),{doc}=written(exportGpInterchange(score,settings));
    const items=[...doc.querySelectorAll('Property[name="TabPlayerCurves"] > Items > Note')];
    expect(items).toHaveLength(2);
    expect(losses).toEqual([
      '1 note has a sounding length that is written only for TabPlayer (first at track 1, bar 1, beat 1)',
      '1 hidden note is written as hidden only for TabPlayer (first at track 1, bar 1, beat 2)',
    ]);
  });

  it('lists the aggregated lines before the per-item curve lines, which keep their own order',()=>{
    const score=build(2);
    score.tracks[0].staves[0].bars[1].voices[0].beats[0].tremoloPicking=Object.assign(new model.TremoloPickingEffect(),{marks:2,style:model.TremoloPickingStyle.BuzzRoll});
    score.tracks[0].staves[0].bars[0].voices[0].beats[0].tremoloPicking=Object.assign(new model.TremoloPickingEffect(),{marks:2,style:model.TremoloPickingStyle.BuzzRoll});
    slur(noteAt(score,0,1),noteAt(score,0,3));
    expect(gpLosses(score)).toEqual([
      '1 slur is written only for TabPlayer (first at track 1, bar 1, beat 2)',
      'the buzz-roll tremolo picking at track 1, bar 1, beat 1 becomes ordinary tremolo picking',
      'the buzz-roll tremolo picking at track 1, bar 2, beat 1 becomes ordinary tremolo picking',
    ]);
  });

  describe('ties follow the reader backward search',()=>{
    const tieLine=(bar:number,beat:number)=>`1 tie will not be linked to the same notes when this file is opened again (first at track 1, bar ${bar}, beat ${beat})`;
    it('warns for a tie whose origin is not the nearest earlier note on its string, and the file really re-reads it onto that note',()=>{
      const score=build(1);
      noteAt(score,0,0).fret=3;noteAt(score,0,1).fret=7;noteAt(score,0,1).isDead=true;noteAt(score,0,2).fret=3;
      tie(noteAt(score,0,0),noteAt(score,0,2));
      expect(gpLosses(score)).toEqual([tieLine(1,1)]);
      const bytes=exportGpInterchange(score,settings),reread=loadInterchangeScore(bytes,settings).tracks[0].staves[0].bars[0].voices[0].beats;
      expect(reread[2].notes[0].tieOrigin===reread[1].notes[0]).toBe(true);expect(reread[2].notes[0].fret).toBe(7);
      // Independent of the reader: the file lists the tie origin flag on beat 1 and the destination flag on beat 3 with a note between them.
      const {doc}=written(bytes),flags=[...noteNodes(doc).values()].map(node=>kids(node,'Tie')[0]?.getAttribute('origin')==='true'?'o':kids(node,'Tie')[0]?.getAttribute('destination')==='true'?'d':'-');
      expect(flags).toEqual(['o','-','d','-']);
    });
    it('stays quiet for a tie to the next note on the string, even with other strings in between',()=>{
      const score=build(2);
      tie(noteAt(score,0,3),noteAt(score,1,0));
      expect(gpLosses(score)).toEqual([]);
      const far=build(3);const between=noteAt(far,1,1);between.string=2;
      tie(noteAt(far,0,0),noteAt(far,0,1));
      expect(gpLosses(far)).toEqual([]);
    });
  });

  it('does not match a hammer-on on a staff without strings, where the reader finds nothing',()=>{
    const score=new model.Score(),track=new model.Track(),staff=new model.Staff();
    staff.showTablature=false;track.addStaff(staff);score.addTrack(track);score.addMasterBar(new model.MasterBar());
    const bar=new model.Bar(),voice=new model.Voice();bar.clef=model.Clef.G2;
    for(const tone of [0,2]){const beat=new model.Beat();beat.duration=4;beat.isEmpty=false;const note=new model.Note();note.octave=4;note.tone=tone;beat.addNote(note);voice.addBeat(beat);}
    bar.addVoice(voice);staff.addBar(bar);score.finish(settings);
    const first=score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0],second=score.tracks[0].staves[0].bars[0].voices[0].beats[1].notes[0];
    expect(first.string).toBe(-1);
    hammer(first,second);
    expect(gpLosses(score)).toEqual(['1 hammer-on or pull-off will not be linked to the same notes when this file is opened again (first at track 1, bar 1, beat 1)']);
  });

  describe('refusals the export would throw, worked out before anything is confirmed',()=>{
    const chord={name:'Dm',nameMode:'manual' as const,recipe:null,firstFret:1,frets:[1,3,2,0,-1,-1],fingers:[1,3,2,-2,-2,-2],barreFrets:[],showName:false,showDiagram:true,showFingering:false};
    function carrierScore() {
      const score=build(2),staff=new model.Staff();staff.stringTuning.tunings=[64,59,55,50,45,40];score.tracks[0].addStaff(staff);
      for(const master of score.masterBars){void master;const bar=new model.Bar(),voice=new model.Voice(),beat=new model.Beat();beat.isEmpty=true;beat.duration=model.Duration.Quarter;voice.addBeat(beat);bar.addVoice(voice);staff.addBar(bar);}
      score.finish(settings);
      applyHarmonyEdit(score,{type:'setHarmonyChord',target:{track:0,staff:1,bar:0,voice:0,beat:0},chord,fillEmptyBeat:false},1);
      return score;
    }
    const thrown=(score:model.Score)=>{try{exportGpInterchange(score,settings);return null;}catch(error){return (error as Error).message;}};
    it('returns null for a score the export accepts',()=>{
      expect(gpExportRefusal(build(2))).toBeNull();
      expect(gpExportRefusal(carrierScore())).toBeNull();
    });
    it('returns the message for a chord carrier that is not a plain quarter, and the list does not call it a quarter rest',()=>{
      const score=carrierScore();score.tracks[0].staves[1].bars[0].voices[0].beats[0].duration=model.Duration.Half;score.finish(settings);
      const message=thrown(score);
      expect(message).toBe('GP export supports an annotated empty carrier only with one existing plain quarter rhythm.');
      expect(gpExportRefusal(score)).toBe(message);
      expect(gpLosses(score).filter(entry=>/quarter rest/.test(entry))).toEqual([]);
    });
    it('does not refuse mixed common and cut choices: they are warned about and written',()=>{
      const score=build(3);score.masterBars[0].timeSignatureCommon=true;score.masterBars[1].timeSignatureCommon=false;
      expect(gpExportRefusal(score)).toBeNull();expect(thrown(score)).toBeNull();
    });
  });

  describe('common and cut time, of which the file holds one choice for the whole score',()=>{
    const flagged=(flags:boolean[])=>{const score=build(flags.length);flags.forEach((flag,index)=>{score.masterBars[index].timeSignatureCommon=flag;});return score;};
    const why=', because the Guitar Pro file holds one choice for the whole score';
    it('counts the numeric bars when the common bars are the majority',()=>{
      expect(gpLosses(flagged([true,true,false]))).toEqual([`1 bar set to numbers will show the common/cut symbol${why} (first at bar 3)`]);
      expect(gpLosses(flagged([false,true,true,false,true]))).toEqual([`2 bars set to numbers will show the common/cut symbol${why} (first at bar 1)`]);
    });
    it('counts the common bars when numeric wins or ties',()=>{
      expect(gpLosses(flagged([true,false]))).toEqual([`1 bar set to the common/cut symbol will show numbers${why} (first at bar 1)`]);
      expect(gpLosses(flagged([false,true,true,false]))).toEqual([`2 bars set to the common/cut symbol will show numbers${why} (first at bar 2)`]);
    });
    it('says nothing for a uniform score, and the file the model exports reads back as the written choice',()=>{
      expect(gpLosses(flagged([true,true,true]))).toEqual([]);expect(gpLosses(flagged([false,false]))).toEqual([]);
      const mixed=unzipSync(exportGpInterchange(flagged([true,true,false,true]),settings)),tie=unzipSync(exportGpInterchange(flagged([true,false]),settings));
      expect(readLegacyStylesheetSymbol(mixed['Content/BinaryStylesheet'])).toBe(true);expect(readLegacyStylesheetSymbol(tie['Content/BinaryStylesheet'])).toBe(false);
    });
    it('counts bars with no choice of their own, which follow the explicit choice written',()=>{
      const entries=unzipSync(exportGpInterchange(build(3),settings));
      entries['Content/Stylesheets/score.gpss']=Uint8Array.of(0x08,1);
      const score=loadInterchangeScore(zipSync(entries),settings);score.masterBars[0].timeSignatureCommon=true;
      expect(gpLosses(score)).toEqual(['2 bars with no common/cut choice of their own now follow the whole-score choice of the common/cut symbol (first at bar 2)']);
      const out=unzipSync(exportGpInterchange(score,settings));
      expect(Array.from(out['Content/Stylesheets/score.gpss'])).toEqual([8,1,0x5a,4,0x2a,2,8,1]);
      setTimeSignatureIntent(score.masterBars[1],false);
      expect(gpLosses(score)).toEqual(['1 bar set to the common/cut symbol will show numbers, because the Guitar Pro file holds one choice for the whole score (first at bar 1)','1 bar with no common/cut choice of its own now follows the whole-score choice of numbers (first at bar 3)']);
    });
    it('names source bars when a bar range is exported',()=>{
      const projected=projectGpDocument({score:flagged([true,false,false,true]),settings:defaultDocumentSettings(),bytes:null,selection:{tracks:[0],range:{first:1,last:3}},backing:false});
      expect(gpLosses(projected)).toEqual([`1 bar set to the common/cut symbol will show numbers${why} (first at bar 4)`]);
    });
  });

  describe('through the export dialog projection, which clones the score',()=>{
    const T=true,R=false;
    const sparse=(layout:boolean[][])=>{
      const score=build(layout.length);
      layout.forEach((beats,bar)=>beats.forEach((keep,beat)=>{if(!keep)score.tracks[0].staves[0].bars[bar].voices[0].beats[beat].notes.length=0;}));
      return score;
    };
    const project=(score:model.Score,selection:{tracks:number[];range:{first:number;last:number}|null}={tracks:[0],range:null})=>projectGpDocument({score,settings:defaultDocumentSettings(),bytes:null,selection,backing:false});
    const hammerLine=(bar:number,beat:number)=>`1 hammer-on or pull-off will not be linked to the same notes when this file is opened again (first at track 1, bar ${bar}, beat ${beat})`;
    it('warns for a hammer-on the reader cannot reach, as it does on the score itself',()=>{
      const score=sparse([[T,R,R,R],[R,T,R,R]]);hammer(noteAt(score,0,0),noteAt(score,1,1));
      expect(gpLosses(score)).toEqual([hammerLine(1,1)]);
      expect(gpLosses(project(score))).toEqual([hammerLine(1,1)]);
      const bytes=exportGpInterchange(project(score),settings);
      expect(strFromU8(unzipSync(bytes)[gpif])).toContain('HopoOrigin');
      expect(loadInterchangeScore(bytes,settings).tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].isHammerPullOrigin).toBe(false);
    });
    it('warns for a hammer-on the reader would link to a nearer note',()=>{
      const score=sparse([[T,T,T,R]]);hammer(noteAt(score,0,0),noteAt(score,0,2));
      expect(gpLosses(score)).toEqual([hammerLine(1,1)]);
      expect(gpLosses(project(score))).toEqual([hammerLine(1,1)]);
    });
    it('keeps a hammer-on the reader can reach clean, and still warns for ties and slides',()=>{
      const clean=sparse([[T,R,T,R]]);hammer(noteAt(clean,0,0),noteAt(clean,0,2));
      expect(gpLosses(project(clean))).toEqual([]);
      const score=build(8);tie(noteAt(score,0,0),noteAt(score,4,0));slide(noteAt(score,0,3),noteAt(score,4,3));
      expect(gpLosses(project(score))).toEqual(gpLosses(score));
      expect(gpLosses(project(score))).toHaveLength(2);
    });
    it('does not throw, and restores no link, when a bar range cuts a link in half',()=>{
      const score=build(4);
      hammer(noteAt(score,0,3),noteAt(score,1,0));tie(noteAt(score,0,0),noteAt(score,1,1));slide(noteAt(score,1,3),noteAt(score,2,0));
      let cut!:model.Score;
      expect(()=>{cut=project(score,{tracks:[0],range:{first:1,last:1}});}).not.toThrow();
      const notes=cut.tracks[0].staves[0].bars[0].voices[0].beats.flatMap(beat=>beat.notes);
      expect(notes.every(note=>!note.hammerPullOrigin&&!note.tieOrigin&&!note.slideTarget)).toBe(true);
      expect(gpLosses(cut)).toEqual([]);
      expect(()=>exportGpInterchange(cut,settings)).not.toThrow();
    });
  });

  it('gives an empty list for a large ordinary score and does not throw on odd ones',()=>{
    expect(gpLosses(build(200,4))).toEqual([]);
    expect(gpLosses(new model.Score())).toEqual([]);
    const noBars=new model.Score(),track=new model.Track();track.addStaff(new model.Staff());noBars.addTrack(track);
    expect(gpLosses(noBars)).toEqual([]);
    // Links to notes that sit in no bar at all.
    const score=build(2),origin=noteAt(score,0,0);
    origin.tieDestination=new model.Note();origin.hammerPullDestination=new model.Note();origin.isHammerPullOrigin=true;
    const other=noteAt(score,0,1);other.slideTarget=new model.Note();other.slideOutType=model.SlideOutType.Legato;
    let losses:string[]=[];
    expect(()=>{losses=gpLosses(score);}).not.toThrow();
    expect(losses.map(entry=>entry.replace(/^\d+ /,''))).toEqual([
      'tie will not be linked to the same notes when this file is opened again (first at track 1, bar 1, beat 1)',
      'hammer-on or pull-off will not be linked to the same notes when this file is opened again (first at track 1, bar 1, beat 1)',
      'slide will not be linked to the same notes when this file is opened again (first at track 1, bar 1, beat 2)',
    ]);
  });

  it('reports carried slurs, which only TabPlayer reads',()=>{
    const score=build(3);slur(noteAt(score,0,1),noteAt(score,0,3));slur(noteAt(score,1,0),noteAt(score,2,0));
    expect(gpLosses(score)).toEqual(['2 slurs are written only for TabPlayer (first at track 1, bar 1, beat 2)']);
    const {xml,doc}=written(exportGpInterchange(score,settings));
    // The slur is in the private property and nowhere in GPIF's own fields: nothing but TabPlayerCurves names it.
    const items=[...doc.querySelectorAll('Property[name="TabPlayerCurves"] > Items > Slur')];
    expect(items).toHaveLength(2);
    expect(xml.replace(/<Property name="TabPlayerCurves">[\s\S]*?<\/Property>/,'')).not.toMatch(/slur/i);
    const one=build(2);slur(noteAt(one,0,0),noteAt(one,1,0));
    expect(gpLosses(one)).toEqual(['1 slur is written only for TabPlayer (first at track 1, bar 1, beat 1)']);
  });

  it('reports curve detail that only TabPlayerCurves holds, and nothing for a curve GPIF holds whole',()=>{
    const score=build(2);
    const long=noteAt(score,0,0);long.bendType=model.BendType.Custom;for(const [offset,value]of [[0,0],[15,2],[30,4],[45,2],[60,0]])long.addBendPoint(new model.BendPoint(offset,value));
    const whammy=score.tracks[0].staves[0].bars[1].voices[0].beats[0];whammy.whammyBarType=model.WhammyType.Custom;for(const [offset,value]of [[0,0],[12,-1],[24,-2],[36,-1],[60,0]])whammy.addWhammyBarPoint(new model.BendPoint(offset,value));
    const styled=noteAt(score,0,2);styled.bendType=model.BendType.Bend;styled.bendStyle=model.BendStyle.Gradual;for(const [offset,value]of [[0,0],[60,4]])styled.addBendPoint(new model.BendPoint(offset,value));
    const plain=noteAt(score,0,3);plain.bendType=model.BendType.Bend;for(const [offset,value]of [[0,0],[60,4]])plain.addBendPoint(new model.BendPoint(offset,value));
    noteAt(score,1,1).durationPercent=0.5;noteAt(score,1,2).durationPercent=0.25;
    noteAt(score,1,3).isVisible=false;
    score.finish(settings);
    expect(gpLosses(score)).toEqual([
      '2 bends or whammy bars have more than four points and are written only for TabPlayer (first at track 1, bar 1, beat 1)',
      '1 bend or whammy bar has a style that is written only for TabPlayer (first at track 1, bar 1, beat 3)',
      '2 notes have a sounding length that is written only for TabPlayer (first at track 1, bar 2, beat 2)',
      '1 hidden note is written as hidden only for TabPlayer (first at track 1, bar 2, beat 4)',
    ]);
    const {doc}=written(exportGpInterchange(score,settings)),notes=noteNodes(doc),barOf=barOfNotes(doc);
    // The 5-point bend has no ordinary GPIF field at all; the private property holds all five points.
    const bendItems=[...doc.querySelectorAll('Property[name="TabPlayerCurves"] > Items > Bend')];
    const five=bendItems.find(item=>item.querySelectorAll('Point').length===5)!;
    expect(five).toBeDefined();
    expect(propertyNamed(notes.get(five.getAttribute('id')!),'Bend')).toBe(false);
    const whammyItem=[...doc.querySelectorAll('Property[name="TabPlayerCurves"] > Items > Whammy')].find(item=>item.querySelectorAll('Point').length===5);
    expect(whammyItem).toBeDefined();
    const beatNode=byId(doc,'Beats','Beat').get(whammyItem!.getAttribute('id')!)!;
    expect(kids(beatNode,'Whammy')).toHaveLength(0);
    // The styled two-point bend keeps its ordinary fields, but its style is in the private property alone.
    const styledItem=bendItems.find(item=>item.getAttribute('style')==='1')!;
    expect(styledItem.querySelectorAll('Point')).toHaveLength(2);
    expect(propertyNamed(notes.get(styledItem.getAttribute('id')!),'Bend')).toBe(true);
    // Duration percent and visibility are likewise only in the private property.
    const noteItems=[...doc.querySelectorAll('Property[name="TabPlayerCurves"] > Items > Note')];
    expect(noteItems.map(item=>[barOf.get(item.getAttribute('id')!),item.getAttribute('durationPercent'),item.getAttribute('isVisible')])).toEqual([[1,'0.5',null],[1,'0.25',null],[1,null,'false']]);
  });

  describe('empty chord carriers',()=>{
    const chord={name:'Dm',nameMode:'manual' as const,recipe:null,firstFret:1,frets:[1,3,2,0,-1,-1],fingers:[1,3,2,-2,-2,-2],barreFrets:[],showName:false,showDiagram:true,showFingering:false};
    function withCarriers(count:number) {
      const score=build(3),staff=new model.Staff();staff.stringTuning.tunings=[64,59,55,50,45,40];score.tracks[0].addStaff(staff);
      for(const master of score.masterBars){void master;const bar=new model.Bar(),voice=new model.Voice(),beat=new model.Beat();beat.isEmpty=true;beat.duration=model.Duration.Quarter;voice.addBeat(beat);bar.addVoice(voice);staff.addBar(bar);}
      score.finish(settings);
      for(let bar=0;bar<count;bar++)applyHarmonyEdit(score,{type:'setHarmonyChord',target:{track:0,staff:1,bar,voice:0,beat:0},chord,fillEmptyBeat:false},1);
      return score;
    }
    it('says how many are written as quarter rests',()=>{
      const score=withCarriers(2);
      expect(gpLosses(score)).toEqual(['2 empty beats that only carry a chord diagram are written as quarter rests (first at track 1, bar 1, beat 1)']);
      // The bytes: the second staff's bars 1 and 2 list a real voice, bar 3 (no chord) the empty marker.
      const {doc}=written(exportGpInterchange(score,settings)),bars=byId(doc,'Bars','Bar'),masters=kids(kids(doc.documentElement,'MasterBars')[0],'MasterBar');
      const voiceOf=(bar:number)=>(kids(bars.get((kids(masters[bar],'Bars')[0].textContent??'').trim().split(/\s+/)[1]),'Voices')[0].textContent??'').trim();
      expect(voiceOf(0)).not.toBe('-1');expect(voiceOf(1)).not.toBe('-1');expect(voiceOf(2)).toBe('-1');
      const voices=byId(doc,'Voices','Voice'),beats=byId(doc,'Beats','Beat'),rhythms=byId(doc,'Rhythms','Rhythm');
      const beat=beats.get((kids(voices.get(voiceOf(0)),'Beats')[0].textContent??'').trim())!;
      expect(kids(beat,'Notes')).toHaveLength(0);
      expect(kids(rhythms.get(kids(beat,'Rhythm')[0].getAttribute('ref')!),'NoteValue')[0].textContent).toBe('Quarter');
    });
    it('says it in the singular for one',()=>{
      expect(gpLosses(withCarriers(1))).toEqual(['1 empty beat that only carries a chord diagram is written as a quarter rest (first at track 1, bar 1, beat 1)']);
    });
  });

  describe('views of a partial export',()=>{
    // The reader of a PartConfiguration: Int32 view count; per view a multi-rest byte, an Int32 group count and one flag byte per group; a trailing Int32.
    function decodeParts(bytes:Uint8Array) {
      const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),views:{multi:number;flags:number[]}[]=[];let at=0;
      const count=view.getInt32(at);at+=4;
      for(let i=0;i<count;i++){const multi=bytes[at++],groups=view.getInt32(at);at+=4;const flags:number[]=[];for(let j=0;j<groups;j++)flags.push(bytes[at++]);views.push({multi,flags});}
      return {views,tail:view.getInt32(at),length:bytes.length,consumed:at+4};
    }
    const int32=(value:number)=>[(value>>>24)&255,(value>>>16)&255,(value>>>8)&255,value&255];
    /** Master view of three tracks, then one view per track: flags 3, 6 and 10 are standard+tab, tab+slash and tab+numbered. */
    const flags=[3,6,10];
    const authoredParts=Uint8Array.from([...int32(4),0,...int32(3),...flags,...flags.flatMap(flag=>[0,...int32(1),flag]),...int32(1)]);
    const authoredLayout=Uint8Array.from([...int32(4),0,0,255,0,255,255,255,255,255,255,255,255]);
    const sentinel=strToU8('a view the source file defined');
    function source() {
      const entries=unzipSync(exportGpInterchange(build(2,3),settings));
      entries['Content/PartConfiguration']=authoredParts;entries['Content/LayoutConfiguration']=authoredLayout;entries['Content/ScoreViews/main']=sentinel;
      return loadInterchangeScore(zipSync(entries),settings);
    }
    const exported=(score:model.Score)=>unzipSync(exportGpInterchange(score,settings));

    it('keeps the hand-authored entries byte for byte when every track is kept in order',()=>{
      const kept=exported(selectScore(source(),{tracks:[0,1,2],range:null}));
      expect(Array.from(kept['Content/PartConfiguration'])).toEqual(Array.from(authoredParts));
      expect(Array.from(kept['Content/LayoutConfiguration'])).toEqual(Array.from(authoredLayout));
      expect(Array.from(kept['Content/ScoreViews/main'])).toEqual(Array.from(sentinel));
      expect(gpLosses(selectScore(source(),{tracks:[0,1,2],range:null}))).toEqual([]);
      // A range of bars does not change which tracks the views describe.
      expect(Array.from(exported(selectScore(source(),{tracks:[0,1,2],range:{first:0,last:0}}))['Content/PartConfiguration'])).toEqual(Array.from(authoredParts));
    });
    it('does not carry views that describe three tracks into a file of one',()=>{
      const subset=selectScore(source(),{tracks:[1],range:null}),out=exported(subset);
      // The source describes 4 views of 3 tracks; the file now holds 2 views of 1 track, as alphaTab regenerates them.
      const parts=decodeParts(out['Content/PartConfiguration']);
      expect(decodeParts(authoredParts).views.map(view=>view.flags.length)).toEqual([3,1,1,1]);
      expect(parts.views.map(view=>view.flags.length)).toEqual([1,1]);
      expect(parts.consumed).toBe(parts.length);expect(parts.tail).toBe(1);
      expect(out['Content/LayoutConfiguration'].length).toBe(8);
      expect(out['Content/ScoreViews/main']).toBeUndefined();
      expect(gpLosses(subset)).toEqual(["the source file's part, layout and score views were rebuilt because tracks were added, left out or reordered"]);
    });
    it('does the same for a reordered selection',()=>{
      const reordered=selectScore(source(),{tracks:[2,1,0],range:null}),out=exported(reordered);
      const parts=decodeParts(out['Content/PartConfiguration']);
      expect(parts.views).toHaveLength(4);
      expect(Array.from(out['Content/PartConfiguration'])).not.toEqual(Array.from(authoredParts));
      expect(parts.views[0].flags).toEqual([10,6,3]);
      expect(out['Content/ScoreViews/main']).toBeUndefined();
      expect(gpLosses(reordered)).toEqual(["the source file's part, layout and score views were rebuilt because tracks were added, left out or reordered"]);
    });
    it('says nothing for a score that has no source views to rebuild',()=>{
      expect(gpLosses(selectScore(build(2,3),{tracks:[1],range:null}))).toEqual([]);
    });
  });

  it('does not throw on a score with no links, an empty voice, no bars or a half-built bar',()=>{
    expect(gpLosses(new model.Score())).toEqual([]);
    const score=build(2);score.tracks[0].staves[0].bars[0].voices[0].beats.length=0;
    expect(()=>gpLosses(score)).not.toThrow();
    const bare=new model.Score(),track=new model.Track();track.addStaff(new model.Staff());bare.addTrack(track);
    expect(gpLosses(bare)).toEqual([]);
  });
});
