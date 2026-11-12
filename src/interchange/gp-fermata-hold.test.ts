import { readFileSync } from 'node:fs';
import { expect,it } from 'vitest';
import { exporter,model,Settings } from '@coderline/alphatab';
import { strFromU8,strToU8,unzipSync,zipSync } from 'fflate';
import { music } from '../editor/fixtures';
import { buildPlaybackPlan } from '../audio/plan';
import { loadInterchangeScore } from './gp';

// THE-60 characterisation: a Guitar Pro fermata is read and written exactly (see notation.test.ts) but the native
// playback plan does not hold the note or stretch the bar for it. The fermata comes from the hand-authored fragment
// in fixtures/fermata-long.gpif, grafted onto an alphaTab-written skeleton; the plan is built from the loaded score
// with and without it. No .analysis/compatibility folder is needed.
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
/** Everything a player would act on, without the per-run note ids. */
const timing=(score:model.Score)=>{
  const plan=buildPlaybackPlan(score,1);
  return {notes:plan.notes.map(note=>[note.startTick,note.endTick,note.key,note.velocity]),durationTick:plan.durationTick,durationMs:plan.durationMs,tempos:plan.tempos,occurrences:plan.occurrences,midi:plan.midi};
};

it('characterizes the fermata hold as not implemented: the loaded fermata keeps its type, offset and Length value, and the playback plan is identical with and without it',()=>{
  const plain=load(false),held=load(true);
  expect(plain.masterBars[0].fermata?.size??0).toBe(0);
  // The file value is kept exactly. Its unit is not established here, so it is not read as seconds or beats.
  expect([...held.masterBars[0].fermata!].map(([offset,fermata])=>[offset,fermata.type,fermata.length])).toEqual([[480,model.FermataType.Long,1.75]]);
  expect(held.masterBars.slice(1).every(master=>!master.fermata?.size)).toBe(true);
  const before=timing(plain),after=timing(held);
  expect(before.notes).toHaveLength(16);
  expect(after).toEqual(before);
});
