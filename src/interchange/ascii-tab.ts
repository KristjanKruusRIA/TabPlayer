import { model,Settings } from '@coderline/alphatab';

/** What an import found, shown before the score is opened. */
export interface AsciiTabSummary {title:string;strings:number;tuning:number[];measures:number;ignored:number;notes:string[]}
export interface AsciiTabImport {score:model.Score;summary:AsciiTabSummary}

const TEXT_LIMIT=256*1024,MEASURE_LIMIT=2000,FRET_LIMIT=30,NAME_BYTES=190;
const pitchClasses:Record<string,number>={c:0,d:2,e:4,f:5,g:7,a:9,b:11};
/** Lowest string of the usual tuning for each string count, used to place named tunings in the right octave. */
const lowestString:Record<number,number>={4:28,5:23,6:40,7:35,8:30};
const standardTunings:Record<number,number[]>={4:[43,38,33,28],5:[43,38,33,28,23],6:[64,59,55,50,45,40],7:[64,59,55,50,45,40,35],8:[64,59,55,50,45,40,35,30]};
const durations=[1,2,4,8,16,32];
const settings=new Settings();
/** Characters that belong in tab: dashes, frets, bar lines, technique signs and spacing. */
const tabCharacters=/[-\d|hpbrxX/\\~()<>:. *]/;

const fail=(message:string):never=>{throw new Error(message);};

interface TabLine {name:string|null;body:string;dashes:number}
interface Note {string:number;fret:number;start:number;end:number;hammer?:boolean;slideOut?:boolean;slideIn?:'below'|'above';bend?:number;release?:boolean;vibrato?:boolean;dead?:boolean;ghost?:boolean;harmonic?:boolean}

/**
 * A tab line is an optional string name, a bar line, then mostly tab characters. Text after the
 * last bar line, such as "x2" or "Repeat 3 times", is a note to the reader unless it continues the tab.
 */
function tabLine(line:string):TabLine|null {
  const match=/^\s*([A-Ga-g][#b]?)?\s*\|(.*)$/.exec(line.trimEnd());if(!match)return null;
  let body=match[2];const last=body.lastIndexOf('|');
  if(last>=0&&!/^[-\d|hpbrxX/\\~()<>:.]*-[-\d|hpbrxX/\\~()<>:.]*$/.test(body.slice(last+1).trim()))body=body.slice(0,last+1);
  const marks=[...body].filter(char=>char!==' '),tab=marks.filter(char=>tabCharacters.test(char)).length;
  if(!marks.length||!/[-\d]/.test(body)||tab<marks.length*0.8)return null;
  return {name:match[1]??null,body,dashes:body.match(/-/g)?.length??0};
}

/** True when names run from the lowest string at the top, such as E A D G B e. */
const lowFirst=(lines:TabLine[])=>/^[A-G]/.test(lines[0].name??'')&&/^[a-g]/.test(lines.at(-1)!.name??'');

function tuningFor(lines:TabLine[]):number[] {
  if(lines.some(line=>!line.name))return standardTunings[lines.length];
  const ordered=lowFirst(lines)?lines:[...lines].reverse();
  const classes=ordered.map(line=>{const name=line.name!;return (pitchClasses[name[0].toLowerCase()]+(name[1]==='#'?1:name[1]==='b'?11:0))%12;});
  // The lowest string takes the highest pitch at most a whole step above the usual one, so lowered
  // tunings such as A standard stay low; each higher string is the next pitch up with its name.
  const limit=lowestString[lines.length]+2,first=limit-((limit-classes[0])%12+12)%12;
  const pitches=[first];for(const pitchClass of classes.slice(1)){const previous=pitches.at(-1)!;pitches.push(previous+(((pitchClass-previous%12)+12)%12||12));}
  if(pitches.at(-1)!>127)fail('That tuning goes above the highest MIDI pitch.');
  return pitches.reverse();
}

/** Reads the notes of one string in one measure; columns are relative to the measure. */
function readNotes(text:string,string:number,ignored:{count:number}):Note[] {
  const notes:Note[]=[];let index=0,lastEnd=-2;
  const number=(at:number)=>{const digits=/^\d{1,2}/.exec(text.slice(at,at+2))?.[0]??'';const value=Number(digits);return digits.length===2&&value>FRET_LIMIT?{value:Number(digits[0]),length:1}:{value,length:digits.length};};
  while(index<text.length){
    const char=text[index];
    if(char==='-'||char===' '||char===':'||char==='|'||char==='.'||char==='*'){index++;continue;}
    let note:Note|null=null;
    if(/\d/.test(char)){const {value,length}=number(index);note={string,fret:value,start:index,end:index+length-1};index+=length;}
    else if(char==='x'||char==='X'){note={string,fret:0,start:index,end:index,dead:true};index++;}
    else if((char==='('||char==='<')&&/\d/.test(text[index+1]??'')){
      const {value,length}=number(index+1),close=char==='('?')':'>';
      if(text[index+1+length]===close){note={string,fret:value,start:index,end:index+1+length,...(char==='('?{ghost:true}:{harmonic:true})};index+=length+2;}
    }else if((char==='/'||char==='\\')&&/\d/.test(text[index+1]??'')&&lastEnd!==index-1){
      // A slide sign with no note before it slides into the next note.
      const {value,length}=number(index+1);note={string,fret:value,start:index+1,end:index+length,slideIn:char==='/'?'below':'above'};index+=length+1;
    }
    if(!note){ignored.count++;index++;continue;}
    // Signs written after a note describe that note, or link it to the next one.
    if(text[index]==='b'){
      index++;const target=number(index);index+=target.length;
      // A bend aims above the fret; a lower target is not a bend this import can write.
      if(!target.length)note.bend=4;else if(target.value>note.fret)note.bend=(target.value-note.fret)*2;else ignored.count++;
      if(text[index]==='r'){index++;index+=number(index).length;if(note.bend)note.release=true;else ignored.count++;}
    }
    if(text[index]==='~'){note.vibrato=true;while(text[index]==='~')index++;}
    const link=text[index];
    if((link==='h'||link==='p')&&/\d/.test(text[index+1]??'')){note.hammer=true;index++;}
    else if((link==='/'||link==='\\')&&/\d/.test(text[index+1]??'')){note.slideOut=true;index++;}
    lastEnd=note.end;notes.push(note);
  }
  return notes;
}

/** Groups notes that overlap in columns into beats; a string sounds once per beat. */
function clusters(notes:Note[]):{start:number;notes:Note[]}[] {
  const result:{start:number;end:number;notes:Note[]}[]=[];
  for(const note of [...notes].sort((a,b)=>a.start-b.start||a.string-b.string)){
    const last=result.at(-1);
    if(last&&note.start<=last.end&&!last.notes.some(other=>other.string===note.string)){last.notes.push(note);last.end=Math.max(last.end,note.end);}
    else result.push({start:note.start,end:note.end,notes:[note]});
  }
  return result;
}

/**
 * Turns column spacing into rhythm. The step is the widest column count that every gap is close to a whole
 * multiple of. Padding after the last beat of up to one and a half steps makes that beat one step long; longer
 * padding is part of the beat, and padding under a quarter step rules the step out. Each step is then the
 * longest note value that fits every step into the bar; any rest of the bar is a rest.
 * Returns onset and end slots on a grid of 1/grid whole notes, and the bar length in slots.
 */
function rhythm(starts:number[],width:number,numerator:number,denominator:number):{slots:number[];end:number;total:number;grid:number} {
  const last=starts.at(-1)!,trailing=width-last,firstGap=starts.length>1?starts[1]-starts[0]:trailing;
  // A short lead-in is padding; a long one is a rest before the first beat.
  const origin=starts[0]<=Math.max(2,firstGap/2)?starts[0]:0;
  const points=origin<starts[0]?[origin,...starts]:starts;
  const gaps=points.slice(1).map((point,index)=>point-points[index]);
  const ending=(step:number)=>trailing<=step*1.5?last+step:width;
  const fits=(step:number)=>trailing>=step/4&&[...gaps,ending(step)-last].every(gap=>Math.round(gap/step)>=1&&Math.abs(gap/step-Math.round(gap/step))<=0.25);
  let step=1;
  for(let candidate=Math.max(1,gaps.length?Math.min(...gaps):trailing);candidate>1;candidate--)if(fits(candidate)){step=candidate;break;}
  const positions=[...starts,ending(step)].map(point=>Math.round((point-origin)/step));
  for(let index=1;index<positions.length;index++)positions[index]=Math.max(positions[index],positions[index-1]+1);
  const steps=positions.at(-1)!;
  for(const grid of durations.filter(value=>Number.isInteger(numerator*value/denominator))){
    const total=numerator*grid/denominator;
    if(steps<=total)return {slots:positions.slice(0,-1),end:steps,total,grid};
  }
  return fail('A measure has more beats than fit as 32nd notes. Space the notes out or split the measure.');
}

/** Splits a span of grid slots into the longest written values, dotted where that fits. */
function values(slots:number,grid:number):{duration:number;dots:number}[] {
  const result:{duration:number;dots:number}[]=[];
  while(slots>0){
    const choice=durations.flatMap(duration=>[{duration,dots:1},{duration,dots:0}]).map(value=>({...value,size:grid/value.duration*(value.dots?1.5:1)}))
      .filter(value=>Number.isInteger(value.size)&&value.size<=slots).sort((a,b)=>b.size-a.size)[0];
    result.push({duration:choice.duration,dots:choice.dots});slots-=choice.size;
  }
  return result;
}

function header(lines:string[],name:string):string|undefined {
  const pattern=new RegExp(`^\\s*${name}\\s*[:=]\\s*(.+?)\\s*$`,'i');
  for(const line of lines){const match=pattern.exec(line);if(match)return match[1];}
  return undefined;
}

/** Collects runs of tab lines; runs that cannot be a string block, such as a chord chart line, are skipped. */
function readBlocks(lines:string[]):{blocks:TabLine[][];skipped:number} {
  const runs:TabLine[][]=[];let current:TabLine[]=[];
  for(const line of lines){const tab=tabLine(line);if(tab)current.push(tab);else if(current.length){runs.push(current);current=[];}}
  if(current.length)runs.push(current);
  // A block needs at least one line that is clearly tab; the others may be dense licks with few dashes.
  const candidates=runs.filter(run=>run.some(line=>line.dashes>=4));
  if(!candidates.length)fail('No tab lines were found. Paste one line per string, such as e|--0--3--|.');
  const blocks=candidates.filter(run=>run.length>=4&&run.length<=8);
  if(!blocks.length)fail('Each tab block needs 4 to 8 string lines.');
  if(blocks.some(run=>run.length!==blocks[0].length))fail('Every tab block must have the same number of strings.');
  return {blocks,skipped:runs.length-blocks.length};
}

/** Converts ASCII tablature into an editable score: tuning from string names, rhythm from column spacing. */
export function parseAsciiTab(text:string,fallbackTitle=''):AsciiTabImport {
  if(text.length>TEXT_LIMIT)fail('ASCII tab text is limited to 256 KB.');
  const lines=text.split(/\r?\n/),{blocks,skipped}=readBlocks(lines),notes:string[]=[];
  if(skipped)notes.push(`${skipped} ${skipped===1?'line group that is not a string block was':'line groups that are not string blocks were'} skipped`);
  const strings=blocks[0].length,tuning=tuningFor(blocks[0]);
  const timeText=header(lines,'time'),time=/^(\d{1,2})\s*\/\s*(\d{1,2})(?!\d)/.exec(timeText??'4/4');
  let numerator=Number(time?.[1]),denominator=Number(time?.[2]);
  if(!time||numerator<1||numerator>32||![1,2,4,8,16,32].includes(denominator)){numerator=4;denominator=4;notes.push(`the time "${timeText}" was not understood, so 4/4 is used`);}
  const tempoText=header(lines,'tempo'),tempoMatch=/^\d+(\.\d+)?/.exec(tempoText??'120');let tempo=Number(tempoMatch?.[0]);
  if(!tempoMatch||tempo<1||tempo>999){tempo=120;notes.push(`the tempo "${tempoText}" was not understood, so 120 BPM is used`);}
  const ignored={count:0},measures:{width:number;notes:Note[]}[]=[];
  for(const block of blocks){
    // Each line is split on its own bar lines, so a line one column longer does not shift the others.
    const segments=block.map(line=>line.body.split('|'));
    const count=Math.max(...segments.map(parts=>parts.length)),reversed=lowFirst(block);
    for(let index=0;index<count;index++){
      const parts=segments.map(line=>line[index]??'');
      // Doubled bar lines and the space before the first bar line hold nothing.
      if(parts.every(part=>!part.trim()))continue;
      const found=parts.flatMap((part,line)=>readNotes(part,reversed?line+1:strings-line,ignored));
      if(index===count-1&&!found.length)continue;
      measures.push({width:Math.max(...parts.map(part=>part.length)),notes:found});
    }
  }
  if(!measures.length)fail('No measures were found between the bar lines.');
  if(measures.length>MEASURE_LIMIT)fail(`ASCII tab import is limited to ${MEASURE_LIMIT} measures.`);
  const title=header(lines,'title')??fallbackTitle,artist=header(lines,'artist')??'';
  const score=new model.Score();score.title=title;score.artist=artist;
  const track=new model.Track(),bass=strings<=5;track.name=bass?'Bass':'Guitar';track.shortName=track.name;
  track.playbackInfo.program=bass?33:25;track.playbackInfo.primaryChannel=0;track.playbackInfo.secondaryChannel=1;
  const staff=new model.Staff();staff.stringTuning.tunings=[...tuning];staff.showTablature=true;staff.showStandardNotation=true;track.addStaff(staff);score.addTrack(track);
  for(const [index,measure] of measures.entries()){
    const master=new model.MasterBar();master.timeSignatureNumerator=numerator;master.timeSignatureDenominator=denominator;score.addMasterBar(master);
    if(index===0)master.tempoAutomations=[model.Automation.buildTempoAutomation(false,0,tempo,2)];
    const bar=new model.Bar();bar.clef=tuning[0]<55?model.Clef.F4:model.Clef.G2;const voice=new model.Voice();bar.addVoice(voice);staff.addBar(bar);
    const add=(value:{duration:number;dots:number},notes:Note[])=>{
      const beat=new model.Beat();beat.duration=value.duration as model.Duration;beat.dots=value.dots;
      for(const source of notes)beat.addNote(note(source));voice.addBeat(beat);
    };
    const beats=clusters(measure.notes);
    // An empty measure holds one rest per beat of the time signature.
    if(!beats.length){for(let rest=0;rest<numerator;rest++)add({duration:denominator,dots:0},[]);continue;}
    const plan=rhythm(beats.map(beat=>beat.start),measure.width,numerator,denominator);
    if(plan.slots[0]>0)values(plan.slots[0],plan.grid).forEach(value=>add(value,[]));
    beats.forEach((beat,position)=>{
      const [sounding,...rest]=values((plan.slots[position+1]??plan.end)-plan.slots[position],plan.grid);
      add(sounding,beat.notes);rest.forEach(value=>add(value,[]));
    });
    values(plan.total-plan.end,plan.grid).forEach(value=>add(value,[]));
  }
  score.finish(settings);
  return {score,summary:{title,strings,tuning,measures:measures.length,ignored:ignored.count,notes}};
}

function note(source:Note):model.Note {
  const value=new model.Note();value.string=source.string;value.fret=source.fret;
  if(source.dead)value.isDead=true;
  if(source.ghost)value.isGhost=true;
  if(source.harmonic){value.harmonicType=model.HarmonicType.Natural;value.harmonicValue=source.fret;}
  if(source.hammer)value.isHammerPullOrigin=true;
  if(source.slideOut)value.slideOutType=model.SlideOutType.Legato;
  if(source.slideIn)value.slideInType=source.slideIn==='below'?model.SlideInType.IntoFromBelow:model.SlideInType.IntoFromAbove;
  if(source.vibrato)value.vibrato=model.VibratoType.Slight;
  if(source.bend){
    // GP files keep at most four bend points, so a release uses exactly four.
    const points=source.release?[[0,0],[20,source.bend],[40,source.bend],[60,0]]:[[0,0],[15,source.bend],[60,source.bend]];
    for(const [offset,amount] of points)value.addBendPoint(new model.BendPoint(offset,amount));
  }
  return value;
}

/** The score file name for an import: the text file's name with a .gp extension, short enough for the native limit. */
export function asciiTabFileName(source:string):string {
  let base=source.replace(/\.[^.\\/]*$/,'').replace(/[\\/:*?"<>|\p{Cc}]+/gu,' ').trim();
  const encoder=new TextEncoder();
  while(encoder.encode(base).length>NAME_BYTES)base=[...base].slice(0,-1).join('').trimEnd();
  return `${base||'Imported tab'}.gp`;
}
