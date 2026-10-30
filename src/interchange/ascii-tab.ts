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
/** Characters that belong in tab: dashes, frets, bar lines, technique signs and letters, and spacing. */
const tabCharacters=/[-\d|hpbrxX/\\~()<>:. *sStTvV^=,]/;
/** What may follow the last bar line and still be tab rather than a note to the reader. */
const tailCharacters=/^[-\d|hpbrxX/\\~()<>:.]*$/;
/** A remark after the tab, such as "x2", "3x" or "(let ring)"; bounded so long lines are checked in linear time. */
const remark=/\s{1,8}(?:[xX×]\s?\d{1,3}|\d{1,3}\s?[xX×]|\(?[A-Za-z][A-Za-z .,'!]{0,40}\)?)$/;

const fail=(message:string):never=>{throw new Error(message);};

interface TabLine {name:string|null;body:string;dashes:number}
interface Note {string:number;fret:number;start:number;end:number;hammer?:boolean;slideOut?:boolean;slideIn?:'below'|'above';bend?:number;release?:boolean;vibrato?:boolean;dead?:boolean;ghost?:boolean;harmonic?:boolean}

/**
 * A tab line is an optional string name, a bar line, then mostly tab characters. Text after the
 * last bar line, such as "x2" or "Repeat 3 times", is a note to the reader unless it continues the tab.
 */
function tabLine(line:string):TabLine|null {
  const match=/^\s*([A-Ga-g][#b]?)?\s*\|(.*)$/.exec(line.trimEnd());if(!match)return null;
  let body=match[2].replace(remark,'');const last=body.lastIndexOf('|');
  if(last>=0){const tail=body.slice(last+1).trim();if(!tailCharacters.test(tail)||!tail.includes('-'))body=body.slice(0,last+1);}
  const marks=[...body].filter(char=>char!==' '),tab=marks.filter(char=>tabCharacters.test(char)).length;
  if(!marks.length||!/[-\d]/.test(body)||tab<marks.length*0.8)return null;
  return {name:match[1]??null,body,dashes:body.match(/-/g)?.length??0};
}

const pitchClass=(name:string)=>(pitchClasses[name[0].toLowerCase()]+(name[1]==='#'?1:name[1]==='b'?11:0))%12;

/**
 * True when names run from the lowest string at the top. E A D G B e says so by its case; when the case
 * does not, the order in which neighbouring strings rise by thirds and fourths wins.
 */
function lowFirst(lines:TabLine[]):boolean {
  if(lines.some(line=>!line.name))return false;
  const upper=(line:TabLine)=>/^[A-G]/.test(line.name!);
  if(upper(lines[0])!==upper(lines.at(-1)!))return upper(lines[0]);
  const classes=lines.map(line=>pitchClass(line.name!));
  const rising=(list:number[])=>list.slice(1).filter((value,index)=>[4,5].includes((value-list[index]+12)%12)).length;
  return rising(classes)>rising([...classes].reverse());
}

function tuningFor(lines:TabLine[]):number[] {
  if(lines.some(line=>!line.name))return standardTunings[lines.length];
  const ordered=lowFirst(lines)?lines:[...lines].reverse();
  const classes=ordered.map(line=>pitchClass(line.name!));
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
  // A bend or release target may be written in brackets, as in 7b(9)r(7).
  const target=(at:number)=>{if(text[at]==='('){const inner=number(at+1);if(inner.length&&text[at+1+inner.length]===')')return {value:inner.value,length:inner.length+2};}return number(at);};
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
    if(text[index]==='b'||text[index]==='^'){
      index++;const aim=target(index);index+=aim.length;
      // A bend aims above the fret; a lower target is not a bend this import can write.
      if(!aim.length)note.bend=4;else if(aim.value>note.fret)note.bend=(aim.value-note.fret)*2;else ignored.count++;
      if(text[index]==='r'){index++;index+=target(index).length;if(note.bend)note.release=true;else ignored.count++;}
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
 * Turns column spacing into rhythm. The step is the widest column count that every gap between beats is close
 * to a whole multiple of. A lead-in of up to one step is padding; a longer one is a rest. The grid is the note
 * value whose bar length is nearest the bar's width in steps while holding every beat. Padding after the last
 * beat of up to one and a half steps makes it one step long; longer padding lets it ring, at most to the bar's
 * end. A lone note in the first half of a bar fills the bar. Returns onset and end slots on a grid of 1/grid
 * whole notes, and the bar length in slots.
 */
function rhythm(starts:number[],width:number,numerator:number,denominator:number):{slots:number[];end:number;total:number;grid:number} {
  const last=starts.at(-1)!,trailing=width-last,gaps=starts.slice(1).map((start,index)=>start-starts[index]);
  const lone=gaps.length===0&&starts[0]*2<width;
  const fits=(step:number)=>gaps.every(gap=>Math.round(gap/step)>=1&&Math.abs(gap/step-Math.round(gap/step))<=0.25);
  let step=1;
  if(!gaps.length)step=Math.max(1,trailing);
  else for(let candidate=Math.min(...gaps);candidate>1;candidate--)if(fits(candidate)){step=candidate;break;}
  const origin=lone||(gaps.length&&starts[0]<=step)?starts[0]:0;
  const positions=starts.map(point=>Math.round((point-origin)/step));
  for(let index=1;index<positions.length;index++)positions[index]=Math.max(positions[index],positions[index-1]+1);
  const need=positions.at(-1)!+1,span=Math.max(need,Math.round((width-origin)/step));
  const choice=durations.filter(value=>Number.isInteger(numerator*value/denominator)).map(grid=>({grid,total:numerator*grid/denominator}))
    .filter(option=>option.total>=need).sort((a,b)=>Math.abs(a.total-span)-Math.abs(b.total-span)||a.total-b.total)[0];
  if(!choice)return fail('A measure has more beats than fit as 32nd notes. Space the notes out or split the measure.');
  const end=lone?choice.total:trailing<=step*1.5?need:Math.min(choice.total,span);
  return {slots:positions,end,total:choice.total,grid:choice.grid};
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
  const pattern=new RegExp(`^\\s*${name}\\s*[:=](.*)$`,'i');
  for(const line of lines){const value=pattern.exec(line)?.[1].trim();if(value)return value;}
  return undefined;
}

/**
 * Collects runs of tab lines; runs that cannot be a string block, such as a chord chart line, are skipped.
 * When most lines of a run are named strings, unnamed lines at its edges, such as a PM or chord line, are dropped.
 */
function readBlocks(lines:string[]):{blocks:TabLine[][];skipped:number;unnamed:number} {
  const runs:TabLine[][]=[];let current:TabLine[]=[],unnamed=0;
  const finish=()=>{
    if(current.filter(line=>line.name).length*2>current.length){
      let start=0,end=current.length;while(!current[start].name)start++;while(!current[end-1].name)end--;
      unnamed+=current.length-(end-start);current=current.slice(start,end);
    }
    runs.push(current);current=[];
  };
  for(const line of lines){const tab=tabLine(line);if(tab)current.push(tab);else if(current.length)finish();}
  if(current.length)finish();
  // A block needs at least one line that is clearly tab; the others may be dense licks with few dashes.
  const candidates=runs.filter(run=>run.some(line=>line.dashes>=4));
  if(!candidates.length)fail('No tab lines were found. Paste one line per string, such as e|--0--3--|.');
  const blocks=candidates.filter(run=>run.length>=4&&run.length<=8);
  if(!blocks.length)fail('Each tab block needs 4 to 8 string lines.');
  if(blocks.some(run=>run.length!==blocks[0].length))fail('Every tab block must have the same number of strings.');
  return {blocks,skipped:runs.length-blocks.length,unnamed};
}

/**
 * Splits each line of a block into measures at its own bar lines, so a line one column longer does not shift
 * the others. When the lines disagree on the number of bars, all are split at the columns of the most common count.
 */
function measureParts(block:TabLine[]):{segments:string[][];byColumn:boolean} {
  const own=block.map(line=>line.body.split('|'));
  const bars=own.map(parts=>parts.length-(parts.at(-1)!.trim()?0:1));
  if(bars.every(count=>count===bars[0]))return {segments:own,byColumn:false};
  const tally=new Map<number,number>();for(const count of bars)tally.set(count,(tally.get(count)??0)+1);
  const common=[...tally].sort((a,b)=>b[1]-a[1]||b[0]-a[0])[0][0],reference=block[bars.indexOf(common)].body;
  const columns=[...reference].flatMap((char,index)=>char==='|'?[index]:[]);
  return {segments:block.map(line=>[...columns,line.body.length].map((column,index)=>line.body.slice(index?columns[index-1]+1:0,column))),byColumn:true};
}

/** Converts ASCII tablature into an editable score: tuning from string names, rhythm from column spacing. */
export function parseAsciiTab(text:string,fallbackTitle=''):AsciiTabImport {
  if(text.length>TEXT_LIMIT)fail('ASCII tab text is limited to 256 KB.');
  const lines=text.split(/\r?\n/),{blocks,skipped,unnamed}=readBlocks(lines),notes:string[]=[];
  if(skipped)notes.push(`${skipped} ${skipped===1?'line group that is not a string block was':'line groups that are not string blocks were'} skipped`);
  if(unnamed)notes.push(`${unnamed} unnamed ${unnamed===1?'line beside the named strings was':'lines beside the named strings were'} skipped`);
  const strings=blocks[0].length,tuning=tuningFor(blocks[0]);
  const timeText=header(lines,'time'),time=/^(\d{1,2})\s*\/\s*(\d{1,2})(?!\d)/.exec(timeText??'4/4');
  let numerator=Number(time?.[1]),denominator=Number(time?.[2]);
  if(!time||numerator<1||numerator>32||![1,2,4,8,16,32].includes(denominator)){numerator=4;denominator=4;notes.push(`the time "${timeText}" was not understood, so 4/4 is used`);}
  const tempoText=header(lines,'tempo'),tempoMatch=/^\d+(\.\d+)?/.exec(tempoText??'120');let tempo=Number(tempoMatch?.[0]);
  if(!tempoMatch||tempo<1||tempo>999){tempo=120;notes.push(`the tempo "${tempoText}" was not understood, so 120 BPM is used`);}
  const ignored={count:0},measures:{width:number;notes:Note[]}[]=[];let byColumn=false;
  for(const block of blocks){
    const parts=measureParts(block),segments=parts.segments;byColumn||=parts.byColumn;
    const count=Math.max(...segments.map(line=>line.length)),reversed=lowFirst(block);
    for(let index=0;index<count;index++){
      const parts=segments.map(line=>line[index]??'');
      // Doubled bar lines and the space before the first bar line hold nothing.
      if(parts.every(part=>!part.trim()))continue;
      const found=parts.flatMap((part,line)=>readNotes(part,reversed?line+1:strings-line,ignored));
      if(index===count-1&&!found.length)continue;
      measures.push({width:Math.max(...parts.map(part=>part.length)),notes:found});
    }
  }
  if(byColumn)notes.push('some lines have a different number of bar lines, so their notes were placed by column');
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
