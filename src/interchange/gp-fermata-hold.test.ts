import { readFileSync } from 'node:fs';
import { expect,it } from 'vitest';
import { exporter,model,Settings } from '@coderline/alphatab';
import { strFromU8,strToU8,unzipSync,zipSync } from 'fflate';
import { music } from '../editor/fixtures';
import { buildPlaybackPlan } from '../audio/plan';
import { loadInterchangeScore } from './gp';

// A Guitar Pro fermata is read and written exactly (see notation.test.ts), leaves written note and MIDI ticks
// unchanged, and stretches the playback timeline during the marked beat's written duration.
const settings=new Settings(),path='Content/score.gpif';
const parse=(text:string)=>new DOMParser().parseFromString(text,'application/xml');
function load(withFermata:boolean) {
  const entries=unzipSync(new exporter.Gp7Exporter().export(music(),settings));
  if(withFermata) {
    const doc=parse(strFromU8(entries[path])),authored=parse(readFileSync('src/interchange/fixtures/fermata-long.gpif','utf8'));
    doc.querySelector('GPIF > MasterBars > MasterBar > Bars')!.after(doc.importNode(authored.querySelector('GPIF > MasterBars > MasterBar > Fermatas')!,true));
    entries[path]=strToU8(new XMLSerializer().serializeToString(doc));
  }
  return loadInterchangeScore(zipSync(entries),settings);
}
/** Written grid and MIDI events, without per-run note ids. */
const timing=(score:model.Score)=>{
  const plan=buildPlaybackPlan(score,1);
  return {notes:plan.notes.map(note=>[note.startTick,note.endTick,note.key,note.velocity]),durationTick:plan.durationTick,tempos:plan.tempos,midi:plan.midi};
};

it('holds the loaded fermata on the playback timeline while keeping written note and MIDI ticks unchanged',()=>{
  const plain=load(false),held=load(true);
  expect(plain.masterBars[0].fermata?.size??0).toBe(0);
  expect([...held.masterBars[0].fermata!].map(([offset,fermata])=>[offset,fermata.type,fermata.length])).toEqual([[480,model.FermataType.Long,1.75]]);
  expect(held.masterBars.slice(1).every(master=>!master.fermata?.size)).toBe(true);
  const plainPlan=buildPlaybackPlan(plain,1),heldPlan=buildPlaybackPlan(held,1);
  expect(timing(held)).toEqual(timing(plain));
  expect(heldPlan.fermatas).toEqual([{startTick:480,endTick:960,length:1.75}]);
  // Length 1.75 at 120 BPM clamps effective BPM to 1, turning a 0.5-beat eighth (0.25 s at 120 BPM) into 30 s (+29,750 ms).
  expect(heldPlan.durationMs-plainPlan.durationMs).toBeCloseTo(29750,6);
  expect(heldPlan.occurrences[0].endMs-plainPlan.occurrences[0].endMs).toBeCloseTo(29750,6);
});
