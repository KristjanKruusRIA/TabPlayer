import { expect,it } from 'vitest';
import { kitScore } from './drum-tab-fixtures';
import { drumTabLeftOff } from './drum-tab-status';
import { defaultEngraving,projectEngraving } from './projection';

it('counts the left-off hits once per track and conversion report, not once per call',()=>{
  const {score,ids}=kitScore({crowded:true}),projected=projectEngraving(score,ids,{...defaultEngraving(),profiles:[{trackId:ids[1],profile:'tablature'}]});
  const track=score.tracks[1];let walks=0;
  const staves=track.staves;Object.defineProperty(track,'staves',{get(){walks++;return staves;}});
  expect(drumTabLeftOff(track,projected.drumTab)).toBe(1);
  const first=walks;expect(first).toBeGreaterThan(0);
  for(let call=0;call<5;call++)expect(drumTabLeftOff(track,projected.drumTab)).toBe(1);
  expect(walks).toBe(first);
  // A new conversion report (every edit makes one) is counted afresh.
  const again=projectEngraving(score,ids,{...defaultEngraving(),profiles:[{trackId:ids[1],profile:'tablature'}]});
  expect(drumTabLeftOff(track,again.drumTab)).toBe(1);expect(walks).toBeGreaterThan(first);
});
