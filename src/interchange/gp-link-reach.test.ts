import { readFileSync } from 'node:fs';
import { expect,it } from 'vitest';
import { exporter,model,Settings } from '@coderline/alphatab';
import { strFromU8,strToU8,unzipSync,zipSync } from 'fflate';
import { loadInterchangeScore } from './gp';

// THE-60 characterisation: how far the stock alphaTab 1.8.4 GPIF reader looks to re-link a tie or a
// hammer-on destination. The reader keeps a constant of 3 bars (Note._maxOffsetForSameLineSearch). The
// note elements below are hand-authored fragments grafted onto an alphaTab-written skeleton, so the
// link outcome is decided by the reader alone and not by our own writer.
const settings=new Settings(),path='Content/score.gpif';
const parse=(text:string)=>new DOMParser().parseFromString(text,'application/xml');

/** Bar 0 and bar `gap` each hold one whole-note beat with a note on one string; the bars between hold only rests. */
function skeleton(gap:number,slot:number):Uint8Array {
  const score=new model.Score(),track=new model.Track(),staff=new model.Staff();
  track.playbackInfo.program=25;staff.stringTuning.tunings=[64,59,55,50,45,40];track.addStaff(staff);score.addTrack(track);
  for(let index=0;index<=gap;index++) {
    score.addMasterBar(new model.MasterBar());
    const bar=new model.Bar(),voice=new model.Voice();
    // The destination bar holds `slot` rests before its note, so slot 1 puts the note on the second beat.
    for(let at=0;at<=(index===gap?slot:0);at++) {
      const beat=new model.Beat();beat.duration=index===gap&&slot>0?model.Duration.Half:model.Duration.Whole;beat.isEmpty=false;
      if(index===0||(index===gap&&at===slot)){const note=new model.Note();note.string=1;note.fret=5;beat.addNote(note);}
      voice.addBeat(beat);
    }
    bar.addVoice(voice);staff.addBar(bar);
  }
  score.finish(settings);return new exporter.Gp7Exporter().export(score,settings);
}
/** Replaces the skeleton's notes with the hand-authored fragment, giving each fragment note the id of the skeleton note at the same position (ids come from a process-wide counter). */
function loaded(fixture:string,gap:number,slot=0) {
  const entries=unzipSync(skeleton(gap,slot)),doc=parse(strFromU8(entries[path])),authored=parse(readFileSync(`src/interchange/fixtures/${fixture}`,'utf8'));
  const ids=[...doc.querySelectorAll('GPIF > Notes > Note')].map(note=>note.getAttribute('id')!),notes=doc.importNode(authored.querySelector('GPIF > Notes')!,true) as Element;
  [...notes.children].forEach((note,index)=>note.setAttribute('id',ids[index]));doc.querySelector('GPIF > Notes')!.replaceWith(notes);
  entries[path]=strToU8(new XMLSerializer().serializeToString(doc));
  const score=loadInterchangeScore(zipSync(entries),settings),bars=score.tracks[0].staves[0].bars;
  return {origin:bars[0].voices[0].beats[0].notes[0],destination:bars[gap].voices[0].beats[slot].notes[0],barCount:bars.length};
}

it.each([[1,true],[2,true],[3,true],[4,false],[5,false]])('characterizes the stock reader tie link: a destination %i bars after its origin links=%s',(gap,linked)=>{
  const {origin,destination,barCount}=loaded('link-reach-tie.gpif',gap);
  expect(barCount).toBe(gap+1);
  // A destination whose origin is out of reach also loses its own tie flag.
  expect(destination.isTieDestination).toBe(linked);
  expect(destination.tieOrigin===origin).toBe(linked);
  expect(origin.isTieOrigin).toBe(linked);
  expect(origin.tieDestination===destination).toBe(linked);
});

// Observed, and different from the 3-bar constant: the forward search runs while the file is being finished
// bar by bar, and a beat's nextBeat is only set when its own bar is finished. From the origin's bar the search
// therefore sees the following bar's first beat and nothing beyond it, so a destination 2 or 3 bars away,
// or on the second beat of the following bar, is not linked even though 3 bars is within the constant.
it.each([[1,0,true],[1,1,false],[2,0,false],[3,0,false],[4,0,false],[5,0,false]])('characterizes the stock reader hammer-on link: destination %i bars after the origin on beat %i links=%s',(gap,slot,linked)=>{
  const {origin,destination}=loaded('link-reach-hammer.gpif',gap,slot);
  expect(destination.beat.index).toBe(slot);
  expect(destination.hammerPullOrigin===origin).toBe(linked);
  expect(origin.hammerPullDestination===destination).toBe(linked);
  expect(origin.isHammerPullOrigin).toBe(linked);
  expect(destination.isHammerPullDestination).toBe(linked);
});
