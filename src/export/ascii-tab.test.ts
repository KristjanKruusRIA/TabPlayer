import { describe,expect,it } from 'vitest';
import { model, Settings } from '@coderline/alphatab';
import { music } from '../editor/fixtures';
import { exportAsciiTab } from './ascii-tab';

const text=(score:model.Score,selection:Parameters<typeof exportAsciiTab>[1]={tracks:[0],range:null})=>new TextDecoder().decode(exportAsciiTab(score,selection));
const rest='-------------',low='-3--3--3--3--';

describe('ASCII tablature export',()=>{
  it('writes the title, tuning and one system of quarter notes',()=>{
    const score=music();score.title='Song';score.artist='Band';
    expect(text(score)).toBe([
      'Song - Band','',
      'Guitar [E A D G B e]','',
      // alphaTab counts strings from the lowest, so the fixture's string 6 is the high e.
      `e|${low}|${low}|${low}|${low}|`,
      ...['B','G','D','A','E'].map(name=>`${name}|${rest}|${rest}|${rest}|${rest}|`),'',
    ].join('\n'));
  });

  it('marks techniques, repeats and sections',()=>{
    const score=music(),bars=score.tracks[0].staves[0].bars,note=(bar:number,beat:number)=>bars[bar].voices[0].beats[beat].notes[0];
    note(0,0).fret=5;note(0,0).isHammerPullOrigin=true;note(0,1).fret=7;
    note(0,2).string=1;note(0,2).fret=12;note(0,2).harmonicType=model.HarmonicType.Natural;
    note(0,3).string=2;note(0,3).fret=0;note(0,3).isGhost=true;note(0,3).vibrato=model.VibratoType.Slight;
    note(1,0).isDead=true;
    note(1,1).fret=7;note(1,1).bendType=model.BendType.Bend;note(1,1).addBendPoint(new model.BendPoint(0,0));note(1,1).addBendPoint(new model.BendPoint(60,4));
    note(1,2).fret=5;note(1,2).slideOutType=model.SlideOutType.Shift;
    score.masterBars[0].section=Object.assign(new model.Section(),{text:'Intro'});
    score.masterBars[2].isRepeatStart=true;score.masterBars[3].repeatCount=3;
    score.finish(new Settings());
    expect(text(score,{tracks:[0],range:null}).split('\n').slice(4)).toEqual([
      '  Intro                                                           x3',
      'e|-5h--7--------------|-x--7b--5\\--3--|:-3--3--3--3--|-3--3--3--3--:|',
      'B|--------------------|---------------|:-------------|-------------:|',
      'G|--------------------|---------------|:-------------|-------------:|',
      'D|--------------------|---------------|:-------------|-------------:|',
      'A|--------------(0)~--|---------------|:-------------|-------------:|',
      'E|--------<12>--------|---------------|:-------------|-------------:|',
      '',
      // The legend lists only the marks this tab uses.
      'h hammer-on, \\ slide down, b bend, ~ vibrato, x dead note, (n) ghost note',
      '<n> natural harmonic',
      '',
    ]);
  });

  it('marks pull-offs, slides in and out, releases on ties, other harmonics, grace notes and taps',()=>{
    const score=music(),bars=score.tracks[0].staves[0].bars,note=(bar:number,beat:number)=>bars[bar].voices[0].beats[beat].notes[0];
    note(0,0).fret=7;note(0,0).isHammerPullOrigin=true;note(0,1).fret=5;note(0,1).slideOutType=model.SlideOutType.OutUp;
    note(0,2).slideInType=model.SlideInType.IntoFromBelow;note(0,2).slideOutType=model.SlideOutType.OutDown;note(0,3).slideOutType=model.SlideOutType.PickSlideUp;
    note(1,0).fret=7;note(1,0).bendType=model.BendType.Bend;note(1,0).addBendPoint(new model.BendPoint(0,0));note(1,0).addBendPoint(new model.BendPoint(60,4));
    note(1,1).fret=7;note(1,1).isTieDestination=true;note(1,1).bendType=model.BendType.Release;note(1,1).addBendPoint(new model.BendPoint(0,4));note(1,1).addBendPoint(new model.BendPoint(60,0));
    note(1,2).harmonicType=model.HarmonicType.Pinch;bars[1].voices[0].beats[3].tap=true;
    const grace=new model.Beat();grace.graceType=model.GraceType.BeforeBeat;grace.duration=model.Duration.Sixteenth;const g=new model.Note();g.string=6;g.fret=2;grace.addNote(g);bars[2].voices[0].insertBeat(bars[2].voices[0].beats[0],grace);
    score.finish(new Settings());
    const lines=text(score,{tracks:[0],range:{first:0,last:2}}).split('\n');
    expect(lines[4]).toMatch(/^e\|-7p--5\/--\/3\\--3\/--\|-7b--r--\[3\]--t3--\|/);
    expect(lines[4]).toContain('g2');
    expect(lines.slice(-3)).toEqual(['p pull-off, / slide up, \\ slide down, b bend, r release, [n] other harmonic','g grace note, t tap','']);
  });

  it('writes alternate endings, directions and simile bars, and keeps long labels from hiding repeat counts',()=>{
    // The two-line section name is flattened and stops where the next bar's label starts.
    const score=music(),masters=score.masterBars,bars=score.tracks[0].staves[0].bars;
    masters[0].isRepeatStart=true;masters[0].section=Object.assign(new model.Section(),{text:'Pre-Chorus\n(second  time)'});
    masters[1].alternateEndings=0b011;masters[1].repeatCount=4;masters[2].alternateEndings=0b100;masters[3].directions=new Set([model.Direction.JumpDaCapoAlFine]);
    bars[2].simileMark=model.SimileMark.Simple;bars[2].voices[0].beats.splice(1);const rest=bars[2].voices[0].beats[0];rest.notes.splice(0);rest.isEmpty=true;
    score.finish(new Settings());
    const lines=text(score).split('\n');
    // A label that would collide moves to a second header line instead of being cut.
    expect(lines[4]).toBe('  Pre-Chorus (second time)   x4 3.            D.C. al Fine');
    expect(lines[5]).toBe(`${' '.repeat(17)}1.2.`);
    // The simile bar sounds (and is written as) the bar before it.
    expect(lines[6]).toBe(`e|:${low}|${low}:|${low}|${low}|`);
  });

  it('keeps a long direction on the last bar of a system whole',()=>{
    const score=music();score.masterBars[3].directions=new Set([model.Direction.TargetFine,model.Direction.JumpDalSegnoSegnoAlDoubleCoda]);score.finish(new Settings());
    expect(text(score).split('\n')[4]).toBe(`${' '.repeat(44)}Fine D.S.S. al Double Coda`);
  });

  it('writes prebends before the fret and no new mark on a held bend',()=>{
    const score=music(),bars=score.tracks[0].staves[0].bars,note=(beat:number)=>bars[0].voices[0].beats[beat].notes[0];
    const bend=(n:model.Note,type:model.BendType,points:number[])=>{n.bendType=type;for(const [i,value] of points.entries())n.addBendPoint(new model.BendPoint(i*60,value));};
    bend(note(0),model.BendType.Bend,[0,4]);note(1).isTieDestination=true;bend(note(1),model.BendType.Hold,[4,4]);
    bend(note(2),model.BendType.PrebendRelease,[4,0]);bend(note(3),model.BendType.PrebendBend,[4,8]);score.finish(new Settings());
    const lines=text(score,{tracks:[0],range:{first:0,last:0}}).split('\n');
    expect(lines[4]).toBe('e|-3b-----pb3r--pb3b--|');expect(lines.at(-2)).toBe('b bend, r release, pb prebend');
  });

  it('keeps a tied first-voice note over a later voice on the same string',()=>{
    const score=music(),bars=score.tracks[0].staves[0].bars;bars[0].voices[0].beats[1].notes[0].isTieDestination=true;
    for(const bar of bars){const voice=new model.Voice();for(let b=0;b<4;b++){const beat=new model.Beat();beat.duration=4;if(bar.index===0&&b===1){const n=new model.Note();n.string=6;n.fret=9;beat.addNote(n);}else beat.isEmpty=true;voice.addBeat(beat);}bar.addVoice(voice);}
    score.finish(new Settings());
    expect(text(score,{tracks:[0],range:{first:0,last:0}}).split('\n')[4]).toBe('e|-3-----3--3--|');
  });

  it('writes out double similes, also when a measure range cuts their source',()=>{
    const score=music(),bars=score.tracks[0].staves[0].bars;bars[0].voices[0].beats[0].notes[0].fret=1;bars[1].voices[0].beats[0].notes[0].fret=2;
    for(const [index,mark] of [[2,model.SimileMark.FirstOfDouble],[3,model.SimileMark.SecondOfDouble]] as const){bars[index].simileMark=mark;bars[index].voices[0].beats.splice(1);const rest=bars[index].voices[0].beats[0];rest.notes.splice(0);rest.isEmpty=true;}
    score.finish(new Settings());
    const bar=(fret:number)=>`-${fret}--3--3--3--`;
    expect(text(score).split('\n')[4]).toBe(`e|${bar(1)}|${bar(2)}|${bar(1)}|${bar(2)}|`);
    expect(text(score,{tracks:[0],range:{first:3,last:3}}).split('\n')[4]).toBe(`e|${bar(2)}|`);
  });

  it('writes a plain repeat without a count',()=>{
    const score=music();score.masterBars[0].isRepeatStart=true;score.masterBars[0].repeatCount=2;score.finish(new Settings());
    expect(text(score,{tracks:[0],range:{first:0,last:0}}).split('\n').slice(4,6)).toEqual([`e|:${low}:|`,'B|:-------------:|']);
  });

  it('keeps the first voice on a shared string, labels original staff numbers and refuses notes without strings',()=>{
    const score=music(),track=score.tracks[0];track.name='';
    for(let s=0;s<2;s++){const staff=new model.Staff();staff.stringTuning.tunings=[43,38,33,28];track.addStaff(staff);
      for(const _ of score.masterBars){const bar=new model.Bar(),voice=new model.Voice(),beat=new model.Beat();beat.duration=model.Duration.Whole;const n=new model.Note();n.string=1;n.fret=s+1;beat.addNote(n);voice.addBeat(beat);bar.addVoice(voice);staff.addBar(bar);}}
    for(const bar of track.staves[0].bars){const voice=new model.Voice();for(let b=0;b<4;b++){const beat=new model.Beat();beat.duration=4;const n=new model.Note();n.string=6;n.fret=9;beat.addNote(n);voice.addBeat(beat);}bar.addVoice(voice);}
    score.finish(new Settings());
    const lines=text(score,{tracks:[0],range:{first:0,last:0},staves:{0:[0,2]}}).split('\n');
    expect(lines[2]).toBe('Track 1 (staff 1) [E A D G B e]');expect(lines[4]).toBe(`e|${low}|`);
    expect(lines[11]).toBe('Track 1 (staff 3) [E A D G]');expect(lines[16]).toBe('E|-2--------|');
    track.staves[0].bars[0].voices[0].beats[0].notes[0].string=7;
    expect(()=>exportAsciiTab(score,{tracks:[0],range:null})).toThrow('ASCII tablature needs every note on a string; measure 1 of Track 1 has a note without one.');
  });

  it('spaces by the shortest gap across voices and keeps the measure range',()=>{
    const score=music(),bars=score.tracks[0].staves[0].bars;
    // Every bar gets a second voice (alphaTab chains voices across bars); measure 2 has two half notes on the low E.
    for(const bar of bars){const voice=new model.Voice();if(bar.index===1)for(const fret of [0,2]){const beat=new model.Beat();beat.duration=model.Duration.Half;const n=new model.Note();n.string=1;n.fret=fret;beat.addNote(n);voice.addBeat(beat);}else{const beat=new model.Beat();beat.isEmpty=true;voice.addBeat(beat);}bar.addVoice(voice);}
    const eighths=bars[1].voices[0];eighths.beats.splice(0);for(let i=0;i<8;i++){const beat=new model.Beat();beat.duration=model.Duration.Eighth;const n=new model.Note();n.string=6;n.fret=i;beat.addNote(n);eighths.addBeat(beat);}
    score.finish(new Settings());
    expect(text(score,{tracks:[0],range:{first:1,last:1}}).split('\n').slice(4)).toEqual([
      'e|-0-1-2-3-4-5-6-7-|',
      'B|-----------------|',
      'G|-----------------|',
      'D|-----------------|',
      'A|-----------------|',
      'E|-0-------2-------|',
      '',
    ]);
  });

  it('wraps long pieces into systems near 80 columns',()=>{
    const score=music();for(let i=0;i<4;i++){score.addMasterBar(new model.MasterBar());const bar=new model.Bar(),voice=new model.Voice(),beat=new model.Beat();beat.duration=model.Duration.Whole;const n=new model.Note();n.string=6;n.fret=i;beat.addNote(n);voice.addBeat(beat);bar.addVoice(voice);score.tracks[0].staves[0].addBar(bar);}
    score.finish(new Settings());
    const lines=text(score).split('\n').filter(line=>line.startsWith('e|'));
    expect(lines).toEqual([`e|${low}|${low}|${low}|${low}|-0--------|-1--------|`,'e|-2--------|-3--------|']);
    expect(Math.max(...text(score).split('\n').map(line=>line.length))).toBeLessThanOrEqual(80);
  });

  it('names repeated strings of extended-range tunings by octave, with capo',()=>{
    const score=music(),staff=score.tracks[0].staves[0];staff.stringTuning.tunings=[64,59,55,50,45,40,35];staff.capo=2;
    for(const bar of staff.bars)for(const beat of bar.voices[0].beats)beat.notes[0].string=7;
    score.finish(new Settings());
    const lines=text(score,{tracks:[0],range:{first:0,last:0}}).split('\n');
    expect(lines[2]).toBe('Guitar [B1 E2 A2 D3 G3 B3 E4] capo 2');
    expect(lines.slice(4,6)).toEqual(['E4|-3--3--3--3--|','B3|-------------|']);expect(lines[10]).toBe('B1|-------------|');
  });

  it('leaves out percussion and refuses a selection without strings',()=>{
    const score=music(),drums=new model.Track();drums.name='Drums';const staff=new model.Staff();staff.isPercussion=true;drums.addStaff(staff);
    for(const _ of score.masterBars){const bar=new model.Bar(),voice=new model.Voice(),beat=new model.Beat();beat.isEmpty=true;voice.addBeat(beat);bar.addVoice(voice);staff.addBar(bar);}
    score.addTrack(drums);score.finish(new Settings());
    expect(text(score,{tracks:[0,1],range:null})).not.toContain('Drums');
    expect(()=>exportAsciiTab(score,{tracks:[1],range:null})).toThrow('ASCII tablature needs a selected track with strings.');
  });
});
