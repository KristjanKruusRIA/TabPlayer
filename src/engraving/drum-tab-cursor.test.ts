import { describe,expect,it } from 'vitest';
import { kitScore } from './drum-tab-fixtures';
import { stepDrumTabNote } from './drum-tab-cursor';

const kit=(options?:Parameters<typeof kitScore>[0])=>{const {score}=kitScore(options);return {score,track:score.tracks[1]};};
const beatOf=(track:ReturnType<typeof kit>['track'],bar:number,beat:number)=>track.staves[0].bars[bar].voices[0].beats[beat];
const ids=(beat:ReturnType<typeof beatOf>)=>beat.notes.map(note=>note.percussionArticulation);

describe('stepDrumTabNote',()=>{
  it('goes to the neighbouring drawn line, not the neighbouring stored note',()=>{
    const {track}=kit();
    // Bar 2 beat 3 stores 47 then 45; both want the toms line, 45 keeps it and 47 moves up to the hi-hat line.
    const beat=beatOf(track,1,2);expect(ids(beat)).toEqual([47,45]);
    // 47 is drawn above 45: Down from 47 reaches 45, Up from 45 reaches 47, and Up from 47 has nothing above.
    expect(stepDrumTabNote(track,beat,0,'down')).toBe(1);
    expect(stepDrumTabNote(track,beat,1,'up')).toBe(0);
    expect(stepDrumTabNote(track,beat,0,'up')).toBe(0);
    expect(stepDrumTabNote(track,beat,1,'down')).toBe(1);
  });
  it('walks a beat from the kick up to the crash in line order',()=>{
    const {track}=kit();
    const beat=beatOf(track,0,2);expect(ids(beat)).toEqual([36,42,49]);
    const kick=0,hat=1,crash=2;
    expect(stepDrumTabNote(track,beat,kick,'up')).toBe(hat);
    expect(stepDrumTabNote(track,beat,hat,'up')).toBe(crash);
    expect(stepDrumTabNote(track,beat,crash,'up')).toBe(crash);
    expect(stepDrumTabNote(track,beat,crash,'down')).toBe(hat);
    expect(stepDrumTabNote(track,beat,kick,'down')).toBe(kick);
  });
  it('skips hits the tab leaves off, and re-enters from the far side when the cursor is on one',()=>{
    const {track}=kit({crowded:true});
    const beat=beatOf(track,1,2);expect(beat.notes.length).toBe(7);
    // Whatever is left off, a step from a drawn hit never lands on one, and a step from a left-off hit lands on a drawn one.
    const drawnAfter=(from:number,dir:'up'|'down')=>stepDrumTabNote(track,beat,from,dir);
    const seen=new Set<number>();let at=0;
    for(let i=0;i<10;i++){const next=drawnAfter(at,'up');if(next===at)break;seen.add(next);at=next;}
    expect(seen.size).toBeLessThanOrEqual(6);
    const topmost=at;expect(drawnAfter(topmost,'up')).toBe(topmost);
    let bottom=topmost;for(let i=0;i<10;i++){const next=drawnAfter(bottom,'down');if(next===bottom)break;bottom=next;}
    const offTab=beat.notes.map((_,i)=>i).filter(i=>i!==topmost&&i!==bottom&&drawnAfter(i,'up')===bottom&&drawnAfter(i,'down')===topmost);
    // The seventh hit is left off: Up from it enters at the lowest drawn hit, Down at the highest.
    expect(offTab.length).toBe(1);
  });
  it('leaves a single hit alone',()=>{
    const {track}=kit();
    const beat=beatOf(track,1,0);expect(beat.notes.length).toBe(1);
    expect(stepDrumTabNote(track,beat,0,'up')).toBe(0);expect(stepDrumTabNote(track,beat,0,'down')).toBe(0);
  });
});
