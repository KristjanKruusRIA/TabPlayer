import { expect,it } from 'vitest';
import { model,Settings } from '@coderline/alphatab';
import { asciiTabFileName,parseAsciiTab } from './ascii-tab';
import { exportGpInterchange,loadInterchangeScore } from './gp';

const settings=new Settings();
const beats=(score:model.Score,bar:number)=>score.tracks[0].staves[0].bars[bar].voices[0].beats.map(beat=>[beat.duration,beat.dots,beat.isRest?'rest':beat.notes.map(note=>`${note.string}:${note.fret}`).sort().join(' ')]);
const block=(...lines:string[])=>lines.join('\n');

it('reads header fields, named standard tuning, spacing rhythm and chords',()=>{
  const {score,summary}=parseAsciiTab(block(
    'Title: Test riff','Artist: Someone','Tempo: 96','',
    'e|----------------|0---------------|',
    'B|----------------|1---------------|',
    'G|----------------|0---------------|',
    'D|----------------|2---------------|',
    'A|----3-------3---|3---------------|',
    'E|0-------0-------|----------------|',
  ));
  expect(summary).toEqual({title:'Test riff',strings:6,tuning:[64,59,55,50,45,40],measures:2,ignored:0,notes:[]});
  expect([score.title,score.artist,score.tempo]).toEqual(['Test riff','Someone',96]);
  expect(score.tracks[0].staves[0].tuning).toEqual([64,59,55,50,45,40]);
  expect(beats(score,0)).toEqual([[4,0,'1:0'],[4,0,'2:3'],[4,0,'1:0'],[4,0,'2:3']]);
  expect(beats(score,1)).toEqual([[1,0,'2:3 3:2 4:0 5:1 6:0']]);
});

it('joins tab blocks, derives an alternate tuning from string names and aligns two-digit frets',()=>{
  const drop=['e|----------------|','B|----------------|','G|----------------|','D|12------12------|','A|12------12------|','D|10------10------|'];
  const chorus=['e|----------------|','B|----------------|','G|----------------|','D|----------------|','A|--------0-0-0-0-|','D|0-0-0-0---------|'];
  const {score,summary}=parseAsciiTab(block(...drop,'','Chorus',...chorus),'Drop riff');
  expect(summary).toEqual({title:'Drop riff',strings:6,tuning:[64,59,55,50,45,38],measures:2,ignored:0,notes:[]});
  expect(beats(score,0)).toEqual([[2,0,'1:10 2:12 3:12'],[2,0,'1:10 2:12 3:12']]);
  expect(beats(score,1)).toEqual([...Array(4).fill([8,0,'1:0']),...Array(4).fill([8,0,'2:0'])]);
});

it('fills leading and trailing space with rests and dotted values, and honours a time signature',()=>{
  const lines=(body:string)=>[...Array(5).fill(`|${'-'.repeat(body.length)}|`),`|${body}|`];
  const {score,summary}=parseAsciiTab(block(...lines('--------3-----------5-------7---')));
  expect(summary.tuning).toEqual([64,59,55,50,45,40]);
  expect(beats(score,0)).toEqual([[4,0,'rest'],[4,1,'1:3'],[4,0,'1:5'],[8,0,'1:7']]);
  const waltz=parseAsciiTab(block('Time: 3/4',...lines('0-----2-----3-----'))).score;
  expect([waltz.masterBars[0].timeSignatureNumerator,waltz.masterBars[0].timeSignatureDenominator]).toEqual([3,4]);
  expect(beats(waltz,0)).toEqual([[4,0,'1:0'],[4,0,'1:2'],[4,0,'1:3']]);
  const gap=parseAsciiTab(block(...Array(5).fill('|--------|--------|--------|'),'|0-------|--------|3-------|'));
  expect([gap.summary.measures,beats(gap.score,1)]).toEqual([3,Array(4).fill([4,0,'rest'])]);
});

it('reads techniques and survives a GP round trip',()=>{
  const {score,summary}=parseAsciiTab(block(
    'e|----------------|----------------|----------------|----------------|',
    'B|----------------|----------------|----------------|----------------|',
    'G|5h7-5p3-3/5-5\\3-|7b9s5~~-x---<12>|(5)-----/7------|7b9r7---9b7-----|',
    'D|----------------|----------------|----------------|----------------|',
    'A|----------------|----------------|----------------|----------------|',
    'E|----------------|----------------|----------------|----------------|',
  ));
  // "s" is not a sign this import reads, and 9b7 bends down, which a bend cannot write.
  expect(summary.ignored).toBe(2);
  const check=(value:model.Score)=>{
    const notes=(bar:number)=>value.tracks[0].staves[0].bars[bar].voices[0].beats.flatMap(beat=>beat.notes);
    expect(notes(0).map(note=>note.fret)).toEqual([5,7,5,3,3,5,5,3]);
    expect(notes(0).map(note=>note.isHammerPullOrigin)).toEqual([true,false,true,false,false,false,false,false]);
    expect(notes(0).map(note=>note.slideOutType)).toEqual([0,0,0,0,model.SlideOutType.Legato,0,model.SlideOutType.Legato,0].map(Number));
    const [bend,vibrato,dead,harmonic]=notes(1);
    expect([bend.fret,bend.hasBend,Math.max(...bend.bendPoints!.map(point=>point.value))]).toEqual([7,true,4]);
    expect([vibrato.fret,vibrato.vibrato]).toEqual([5,model.VibratoType.Slight]);
    expect([dead.isDead,harmonic.fret,harmonic.harmonicType]).toEqual([true,12,model.HarmonicType.Natural]);
    const [ghost,slid]=notes(2);
    expect([ghost.fret,ghost.isGhost,slid.fret,slid.slideInType]).toEqual([5,true,7,model.SlideInType.IntoFromBelow]);
    const [released,flat]=notes(3);
    expect([released.hasBend,released.bendPoints!.map(point=>point.value)]).toEqual([true,[0,4,4,0]]);
    expect([flat.fret,flat.hasBend]).toEqual([9,false]);
  };
  check(score);
  check(loadInterchangeScore(exportGpInterchange(score,settings),settings));
  expect(beats(score,2)).toEqual([[2,0,'4:5'],[2,0,'4:7']]);
});

it('reads evenly spaced notes with any padding as even values',()=>{
  const low=(body:string)=>parseAsciiTab(block(...Array(5).fill(`|${'-'.repeat(body.length)}|`),`|${body}|`)).score;
  expect(beats(low('-0---0---0---0-'),0)).toEqual(Array(4).fill([4,0,'1:0']));
  expect(beats(low('-0---0---0---0----'),0)).toEqual(Array(4).fill([4,0,'1:0']));
  expect(beats(low('0---0---0---0')        ,0)).toEqual(Array(4).fill([4,0,'1:0']));
  expect(beats(low('--3-5-7-8-7-5-3--'),0)).toEqual([...[3,5,7,8,7,5,3].map(fret=>[8,0,`1:${fret}`]),[8,0,'rest']]);
  // The second note rings until the bar fills.
  expect(beats(low('5h7-------------'),0)).toEqual([[8,0,'1:5'],[2,1,'1:7'],[8,0,'rest']]);
});

it('keeps dense lines, lines of uneven length, and ignores notes written beside the tab',()=>{
  const {score,summary}=parseAsciiTab(block(
    '|Am--|C---|G---|F---|','',
    'e|5h7p5h7p5h7p5h7|',
    'B|----------------|',
    'G|-----------------|',
    'D|----------------|   x2',
    'A|----------------|',
    'E|--------0------|  Repeat this whole section 3 times',
  ));
  expect(summary).toMatchObject({strings:6,tuning:[64,59,55,50,45,40],measures:1,ignored:0,notes:[]});
  expect(beats(score,0).map(beat=>beat[2])).toEqual(['6:5','6:7','6:5','6:7','1:0 6:5','6:7','6:5','6:7']);
  // A short run of tab lines beside full blocks is skipped and reported, not fatal.
  const extra=parseAsciiTab(block('PM|--------|','  |--------|','',...['e','B','G','D','A','E'].map(name=>`${name}|0-------|`)));
  expect([extra.summary.measures,extra.summary.notes]).toEqual([1,['1 line group that is not a string block was skipped']]);
});

it('reads loose headers, reversed string order and lowered tunings',()=>{
  const six=(names:string[])=>names.map((name,index)=>`${name}|${index===5?'0':'-'}-------|`);
  expect(parseAsciiTab(block('Tempo: 120 BPM','Time: 3/4 waltz',...six(['e','B','G','D','A','E']))).summary.notes).toEqual([]);
  const loose=parseAsciiTab(block('Tempo: Moderate','Time: 3:45',...six(['e','B','G','D','A','E'])));
  expect([loose.score.tempo,loose.score.masterBars[0].timeSignatureNumerator,loose.summary.notes]).toEqual([120,4,['the time "3:45" was not understood, so 4/4 is used','the tempo "Moderate" was not understood, so 120 BPM is used']]);
  // Lowest string written first: the bottom line is the high e, so its 0 is string 6.
  const reversed=parseAsciiTab(block(...six(['E','A','D','G','B','e'])));
  expect([reversed.summary.tuning,beats(reversed.score,0)]).toEqual([[64,59,55,50,45,40],[[1,0,'6:0']]]);
  expect(parseAsciiTab(block(...six(['b','F#','D','A','E','A']))).summary.tuning).toEqual([59,54,50,45,40,33]);
});

it('uses standard tunings for unnamed four- and seven-string blocks',()=>{
  const lines=(count:number)=>Array.from({length:count},(_,index)=>index===count-1?'|0-------|':'|--------|');
  expect(parseAsciiTab(block(...lines(4))).summary.tuning).toEqual([43,38,33,28]);
  expect(parseAsciiTab(block(...lines(7))).summary.tuning).toEqual([64,59,55,50,45,40,35]);
  expect(parseAsciiTab(block(...lines(4))).score.tracks[0].playbackInfo.program).toBe(33);
});

it('explains text it cannot import',()=>{
  expect(()=>parseAsciiTab('Just some words\nwithout any tab')).toThrow('No tab lines were found. Paste one line per string, such as e|--0--3--|.');
  expect(()=>parseAsciiTab(block('G|--0--|','D|--2--|','A|--2--|'))).toThrow('Each tab block needs 4 to 8 string lines.');
  expect(()=>parseAsciiTab(block('e|--0--|','B|--1--|','G|--0--|','D|--2--|','','|--0--|','|--0--|','|--0--|','|--0--|','|--0--|'))).toThrow('Every tab block must have the same number of strings.');
  expect(()=>parseAsciiTab('-'.repeat(300_000))).toThrow('ASCII tab text is limited to 256 KB.');
});

it('names the imported score file from the source file',()=>{
  expect(asciiTabFileName('riff.txt')).toBe('riff.gp');
  expect(asciiTabFileName('song.final.tab')).toBe('song.final.gp');
  expect(asciiTabFileName('')).toBe('Imported tab.gp');
  expect(asciiTabFileName('a/b\\c:d.txt')).toBe('a b c d.gp');
  // The native side takes names of at most 200 bytes, so long names are cut on whole characters.
  const long=asciiTabFileName(`${'譜'.repeat(100)}.txt`);
  expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(200);expect(long).toBe(`${'譜'.repeat(63)}.gp`);
});
