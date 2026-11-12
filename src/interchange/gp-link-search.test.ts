import { readFileSync } from 'node:fs';
import { expect,it } from 'vitest';
import { exporter,model,Settings } from '@coderline/alphatab';
import { strFromU8,strToU8,unzipSync,zipSync } from 'fflate';
import { loadInterchangeScore } from './gp';

// THE-60 characterisation of where the stock alphaTab 1.8.4 GPIF reader looks for the destination of a
// hammer-on/pull-off and for the target of a slide (Note.findHammerPullDestination, Note.nextNoteOnSameLine, both
// run from Note.finish). The reader's "three bars" constant does not decide it. Bars are finished one after another,
// so while a note is finished only its own bar is chained to its own beats, plus the link from that bar's last beat
// to the next bar's first beat; the next bar's other beats are not linked yet. The search sees the later beats of the
// origin's bar and the first beat of the next bar, nothing else. The fragments are hand-authored and grafted onto an
// alphaTab-written skeleton, so the reader alone decides the outcome. A beat is a fixture note index or null (rest).
const settings=new Settings(),path='Content/score.gpif';
const parse=(text:string)=>new DOMParser().parseFromString(text,'application/xml');
type Layout=(number|null)[][];
const ORIGIN_HAMMER=0,PLAIN=1,OTHER=2,TAPPED=3,LEGATO=4,SHIFT=5,OUT_DOWN=6;

function skeleton(layout:Layout):Uint8Array {
  const score=new model.Score(),track=new model.Track(),staff=new model.Staff();
  track.playbackInfo.program=25;staff.stringTuning.tunings=[64,59,55,50,45,40];track.addStaff(staff);score.addTrack(track);
  for(const slots of layout) {
    score.addMasterBar(new model.MasterBar());
    const bar=new model.Bar(),voice=new model.Voice();
    for(const slot of slots) {
      const beat=new model.Beat();beat.duration=model.Duration.Quarter;beat.isEmpty=false;
      if(slot!==null){const note=new model.Note();note.string=1;note.fret=5;beat.addNote(note);}
      voice.addBeat(beat);
    }
    bar.addVoice(voice);staff.addBar(bar);
  }
  score.finish(settings);return new exporter.Gp7Exporter().export(score,settings);
}
/** The skeleton's notes, in document order, are replaced by the fixture notes the layout names, each keeping the skeleton note's id. */
function loaded(layout:Layout) {
  const entries=unzipSync(skeleton(layout)),doc=parse(strFromU8(entries[path])),authored=parse(readFileSync('src/interchange/fixtures/link-reach-search.gpif','utf8'));
  const ids=[...doc.querySelectorAll('GPIF > Notes > Note')].map(note=>note.getAttribute('id')!),roles=layout.flat().filter((slot):slot is number=>slot!==null);
  const source=[...authored.querySelectorAll('GPIF > Notes > Note')],notes=doc.querySelector('GPIF > Notes')!;
  [...notes.children].forEach(child=>child.remove());
  roles.forEach((role,index)=>{const copy=doc.importNode(source[role],true) as Element;copy.setAttribute('id',ids[index]);notes.append(copy);});
  entries[path]=strToU8(new XMLSerializer().serializeToString(doc));
  const bars=loadInterchangeScore(zipSync(entries),settings).tracks[0].staves[0].bars;
  return (bar:number,beat:number)=>bars[bar].voices[0].beats[beat].notes[0];
}
const at=(position:string)=>position.split(':').map(Number) as [number,number];

// Each case: description, layout (the origin is the only note with role 0, 4, 5 or 6), and the position the origin
// ends up linked to, or null when it is not linked.
const hammerCases:[string,Layout,string|null][]=[
  ['the next beat of the same bar',[[0,1]],'0:1'],
  ['a later beat with a rest between',[[0,null,1]],'0:2'],
  ['a later beat with a note on another string between',[[0,2,1]],'0:2'],
  ['a left-hand-tapped note on another string is itself the destination',[[0,3,1]],'0:1'],
  ['a left-hand-tapped note on another string and nothing on the same string',[[0,3]],'0:1'],
  ['only another string after it',[[0,2]],null],
  ['another note on the same string between (the nearer note is the destination)',[[0,1,1]],'0:1'],
  ['the first beat of the next bar',[[0],[1]],'1:0'],
  ['the first beat of the next bar, origin on the last beat of its bar',[[null,0],[1]],'1:0'],
  ['the first beat of the next bar after a rest in the origin bar',[[0,null],[1]],'1:0'],
  ['a left-hand-tapped note on the first beat of the next bar',[[0],[3]],'1:0'],
  ['the second beat of the next bar',[[0],[null,1]],null],
  ['the second beat of the next bar after a rest in the origin bar',[[0,null],[null,1]],null],
  ['the second beat of the next bar after another string on its first beat',[[0],[2,1]],null],
  ['the first beat of the bar after next',[[0],[null],[1]],null],
  ['the first beat of the bar after next past another string in the next bar',[[0],[2],[1]],null],
];
it.each(hammerCases)('characterizes the stock reader hammer-on search: %s',(_name,layout,expected)=>{
  const find=loaded(layout),origin=find(0,layout[0].indexOf(ORIGIN_HAMMER));
  if(expected===null){expect(origin.hammerPullDestination).toBeNull();expect(origin.isHammerPullOrigin).toBe(false);return;}
  const destination=find(...at(expected));
  expect(origin.hammerPullDestination===destination).toBe(true);expect(origin.isHammerPullOrigin).toBe(true);expect(destination.hammerPullOrigin===origin).toBe(true);
});

// Only a shift or legato slide has a target; out-and-down (and the other out types) never do. A slide that finds no
// target loses its out type altogether. The search is for the same string only: tapping does not enter into it.
const slideCases:[string,number,Layout,string|null][]=[
  ['legato to the next beat',LEGATO,[[LEGATO,1]],'0:1'],
  ['legato across a rest',LEGATO,[[LEGATO,null,1]],'0:2'],
  ['legato past a note on another string',LEGATO,[[LEGATO,2,1]],'0:2'],
  ['legato past a left-hand-tapped note on another string',LEGATO,[[LEGATO,TAPPED,1]],'0:2'],
  ['legato with only another string after it',LEGATO,[[LEGATO,2]],null],
  ['legato with only a left-hand-tapped note on another string after it',LEGATO,[[LEGATO,TAPPED]],null],
  ['legato past another note on the same string (the nearer note is the target)',LEGATO,[[LEGATO,1,1]],'0:1'],
  ['legato to the first beat of the next bar',LEGATO,[[LEGATO],[1]],'1:0'],
  ['legato to the first beat of the next bar from the last beat of its bar',LEGATO,[[null,LEGATO],[1]],'1:0'],
  ['legato to the second beat of the next bar',LEGATO,[[LEGATO],[null,1]],null],
  ['legato to the first beat of the bar after next',LEGATO,[[LEGATO],[null],[1]],null],
  ['shift to the next beat',SHIFT,[[SHIFT,1]],'0:1'],
  ['shift to the first beat of the next bar',SHIFT,[[SHIFT],[1]],'1:0'],
  ['shift to the second beat of the next bar',SHIFT,[[SHIFT],[null,1]],null],
];
it.each(slideCases)('characterizes the stock reader slide target: %s',(_name,role,layout,expected)=>{
  const find=loaded(layout),origin=find(0,layout[0].indexOf(role)),type=role===LEGATO?model.SlideOutType.Legato:model.SlideOutType.Shift;
  if(expected===null){expect(origin.slideTarget).toBeNull();expect(origin.slideOutType).toBe(model.SlideOutType.None);return;}
  const target=find(...at(expected));
  expect(origin.slideTarget===target).toBe(true);expect(target.slideOrigin===origin).toBe(true);expect(origin.slideOutType).toBe(type);
});
it('characterizes the stock reader: an out-and-down slide has no target even beside a note on its string',()=>{
  const find=loaded([[OUT_DOWN,PLAIN]]),origin=find(0,0);
  expect(origin.slideOutType).toBe(model.SlideOutType.OutDown);expect(origin.slideTarget).toBeNull();expect(find(0,1).slideOrigin).toBeNull();
});
