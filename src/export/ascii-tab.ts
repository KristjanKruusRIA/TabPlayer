import { model } from '@coderline/alphatab';
import { selectScore } from './selection';
import type { ExportSelection } from './types';

const NAMES=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const LINE_WIDTH=80;
const DIRECTIONS:Record<number,string>={
  [model.Direction.TargetFine]:'Fine',[model.Direction.TargetSegno]:'Segno',[model.Direction.TargetSegnoSegno]:'Segno Segno',
  [model.Direction.TargetCoda]:'Coda',[model.Direction.TargetDoubleCoda]:'Double Coda',
  [model.Direction.JumpDaCapo]:'D.C.',[model.Direction.JumpDaCapoAlCoda]:'D.C. al Coda',[model.Direction.JumpDaCapoAlDoubleCoda]:'D.C. al Double Coda',[model.Direction.JumpDaCapoAlFine]:'D.C. al Fine',
  [model.Direction.JumpDalSegno]:'D.S.',[model.Direction.JumpDalSegnoAlCoda]:'D.S. al Coda',[model.Direction.JumpDalSegnoAlDoubleCoda]:'D.S. al Double Coda',[model.Direction.JumpDalSegnoAlFine]:'D.S. al Fine',
  [model.Direction.JumpDalSegnoSegno]:'D.S.S.',[model.Direction.JumpDalSegnoSegnoAlCoda]:'D.S.S. al Coda',[model.Direction.JumpDalSegnoSegnoAlDoubleCoda]:'D.S.S. al Double Coda',[model.Direction.JumpDalSegnoSegnoAlFine]:'D.S.S. al Fine',
  [model.Direction.JumpDaCoda]:'To Coda',[model.Direction.JumpDaDoubleCoda]:'To Double Coda',
};
const LEGEND:[string,string][]=[['h','hammer-on'],['p','pull-off'],['/','slide up'],['\\','slide down'],['b','bend'],['r','release'],['pb','prebend'],['~','vibrato'],['x','dead note'],['(n)','ghost note'],['<n>','natural harmonic'],['[n]','other harmonic'],['g','grace note'],['t','tap']];
/** Free text on one line: newlines and runs of spaces would break the tab layout. */
const flat=(text:string|null|undefined)=>(text??'').replace(/\s+/g,' ').trim();

/** Fret text for one note: x dead, (n) ghost, <n> natural and [n] other harmonics, g grace, t tap,
 * then h/p, / or \, b/r and ~ for hammer-ons, pull-offs, slides, bends and releases, and vibrato.
 * A tied continuation has no fret of its own, so only its bend or release shows. */
function label(note:model.Note,used:Set<string>):string {
  const mark=(symbol:string)=>{used.add(symbol);return symbol;};
  let text='';
  if(!note.isTieDestination){
    text=note.isDead?mark('x'):String(note.fret);
    if(note.isGhost){text=`(${text})`;used.add('(n)');}
    if(note.harmonicType===model.HarmonicType.Natural){text=`<${text}>`;used.add('<n>');}
    else if(note.harmonicType!==model.HarmonicType.None){text=`[${text}]`;used.add('[n]');}
    if(note.beat.graceType!==model.GraceType.None)text=mark('g')+text;
    if(note.beat.tap)text=mark('t')+text;
    if(note.slideInType===model.SlideInType.IntoFromBelow)text=mark('/')+text;
    else if(note.slideInType===model.SlideInType.IntoFromAbove)text=mark('\\')+text;
  }
  const hammer=note.hammerPullDestination;
  if(note.isHammerPullOrigin&&hammer)text+=mark(hammer.fret>=note.fret?'h':'p');
  const slide=note.slideOutType;
  if(slide===model.SlideOutType.Shift||slide===model.SlideOutType.Legato)text+=mark((note.slideTarget?.fret??note.fret)>=note.fret?'/':'\\');
  else if(slide===model.SlideOutType.OutUp||slide===model.SlideOutType.PickSlideUp)text+=mark('/');
  else if(slide===model.SlideOutType.OutDown||slide===model.SlideOutType.PickSlideDown)text+=mark('\\');
  // A prebend is written before the fret (pb7); a held bend on a tied note needs no new mark.
  const bend=note.hasBend?note.bendType:model.BendType.None,{Prebend,PrebendBend,PrebendRelease,Release,BendRelease,Bend,Custom}=model.BendType;
  if(bend===Prebend||bend===PrebendBend||bend===PrebendRelease)text=mark('pb')+text;
  if(bend===Bend||bend===Custom||bend===PrebendBend||bend===BendRelease)text+=mark('b');
  if(bend===Release||bend===PrebendRelease||bend===BendRelease)text+=mark('r');
  if(note.vibrato!==model.VibratoType.None)text+=mark('~');
  return text;
}

/** String names from high to low. The highest string is lower-cased when only it repeats the lowest
 * (e over E); any other repeat, as on 7-, 8- and 9-string tunings, uses octave names (E4, B1). */
function stringNames(tuning:number[]):string[] {
  let names=tuning.map(pitch=>NAMES[((pitch%12)+12)%12]);
  const repeated=(list:string[])=>new Set(list).size!==list.length;
  if(names.length>1&&names[0]===names.at(-1)&&!repeated(names.slice(1)))names[0]=names[0].toLowerCase();
  else if(repeated(names))names=tuning.map(pitch=>`${NAMES[((pitch%12)+12)%12]}${Math.floor(pitch/12)-1}`);
  const width=Math.max(...names.map(name=>name.length));
  return names.map(name=>name.padEnd(width));
}

/** The bar whose notes sound here: a simile (%) bar repeats the bar or two bars before it. */
function soundingBar(bar:model.Bar):model.Bar {
  const back=bar.simileMark===model.SimileMark.Simple?1:bar.simileMark===model.SimileMark.None?0:2;
  let source:model.Bar|null=bar;for(let i=0;i<back&&source;i++)source=source.previousBar;
  return source&&source!==bar?soundingBar(source):bar;
}

type BarText={rows:string[];header:string;count:string};

/** One bar as text per string (top string first), with its header label (endings, section and
 * directions) and repeat count, which the system lays out above it. */
function barText(bar:model.Bar,strings:number,where:string,used:Set<string>):BarText {
  const master=bar.masterBar,length=master.calculateDuration(),source=soundingBar(bar);
  const onsets=new Map<number,model.Note[]>();
  for(const voice of source.voices)for(const beat of voice.beats){
    if(beat.isEmpty)continue;
    const notes=onsets.get(beat.playbackStart)??[];notes.push(...beat.notes);onsets.set(beat.playbackStart,notes);
  }
  const starts=[...onsets.keys()].sort((a,b)=>a-b),rows=Array.from({length:strings},()=>'-');
  for(const [index,start] of starts.entries()){
    const next=starts[index+1]??length,cells=Array.from({length:strings},()=>''),claimed=new Set<number>();
    for(const note of onsets.get(start)!){
      if(note.string<1||note.string>strings)throw new Error(`ASCII tablature needs every note on a string; ${where} has a note without one.`);
      // Voices sharing a string at one moment keep the first voice's note, even a tied one.
      const row=strings-note.string;if(!claimed.has(row)){claimed.add(row);cells[row]=label(note,used);}
    }
    // Longer notes get more room: an eighth one dash, a quarter two, up to eight for a whole note.
    const width=Math.max(1,...cells.map(cell=>cell.length))+Math.min(8,Math.max(1,Math.round((next-start)/480)));
    cells.forEach((cell,row)=>rows[row]+=cell.padEnd(width,'-'));
  }
  if(!starts.length)rows.forEach((_,row)=>rows[row]+='-'.repeat(8));
  const open=master.isRepeatStart?':':'',close=master.repeatCount>0?':':'';
  const endings=[...Array(32).keys()].filter(bit=>master.alternateEndings&(1<<bit)).map(bit=>`${bit+1}.`).join('');
  const directions=[...(master.directions??[])].sort((a,b)=>a-b).map(direction=>DIRECTIONS[direction]).filter(Boolean);
  return {rows:rows.map(row=>open+row+close),header:[endings,flat(master.section?.text),...directions].filter(Boolean).join(' '),count:master.repeatCount>2?`x${master.repeatCount}`:''};
}

/** The header lines over a system: each bar's label starts at its bar and may run on into the
 * space of following bars; repeat counts sit at the right end of their bar. A label that would
 * collide with one already placed goes on another line above the tab rather than being cut. */
function headerLines(labels:{start:number;end:number;text:string;count:string}[]):string[] {
  const placed:{at:number;text:string}[]=[];
  for(const label of labels){
    if(label.text)placed.push({at:label.start,text:label.text});
    if(label.count)placed.push({at:Math.max(label.start,label.end-label.count.length),text:label.count});
  }
  const lines:string[][]=[];
  for(const item of placed){
    const chars=[...item.text].slice(0,Math.max(1,LINE_WIDTH-item.at));
    let line=lines.find(line=>line.length<item.at);
    if(!line)lines.push(line=[]);
    while(line.length<item.at)line.push(' ');
    line.push(...chars);
  }
  return lines.map(line=>line.join(''));
}

/** Plain-text tablature for the selected stringed tracks and measures, systems wrapped near
 * 80 columns. Percussion and staves without strings have no tablature and are left out. */
export function exportAsciiTab(score:model.Score,selection:ExportSelection):Uint8Array {
  const selected=selectScore(score,selection),lines:string[]=[],used=new Set<string>();
  lines.push([flat(selected.title),flat(selected.artist)].filter(Boolean).join(' - ')||'Untitled');
  let written=0;
  for(const [position,track] of selected.tracks.entries()){
    // Labels use the score's own track and staff numbers, as the export dialog shows them.
    const original=selection.tracks[position],staffCount=score.tracks[original].staves.length;
    for(const [index,staff] of track.staves.entries()){
      if(staff.isPercussion||!staff.tuning.length)continue;
      written++;
      const names=stringNames(staff.tuning),low=names.map(name=>name.trim()).reverse().join(' ');
      const name=flat(track.name)||`Track ${original+1}`,staffNumber=(selection.staves?.[original]?.[index]??index)+1;
      lines.push('',`${name}${staffCount>1?` (staff ${staffNumber})`:''} [${low}]${staff.capo?` capo ${staff.capo}`:''}`);
      const fresh=()=>({rows:names.map(label=>`${label}|`),labels:[] as {start:number;end:number;text:string;count:string}[]});
      let system=fresh();
      const flush=()=>{
        if(!system.labels.length)return;
        lines.push('',...headerLines(system.labels),...system.rows);system=fresh();
      };
      for(const bar of staff.bars){
        const text=barText(bar,staff.tuning.length,`measure ${bar.masterBar.index+1+(selection.range?.first??0)} of ${name}`,used);
        if(system.labels.length&&system.rows[0].length+text.rows[0].length+1>LINE_WIDTH)flush();
        const start=system.rows[0].length;
        system.rows=system.rows.map((row,line)=>`${row}${text.rows[line]}|`);
        system.labels.push({start,end:start+text.rows[0].length,text:text.header,count:text.count});
      }
      flush();
    }
  }
  if(!written)throw new Error('ASCII tablature needs a selected track with strings.');
  const legend=LEGEND.filter(([symbol])=>used.has(symbol)).map(([symbol,meaning])=>`${symbol} ${meaning}`);
  if(legend.length){
    lines.push('');let line='';
    for(const item of legend){if(line&&line.length+item.length+2>LINE_WIDTH){lines.push(line);line='';}line=line?`${line}, ${item}`:item;}
    lines.push(line);
  }
  return new TextEncoder().encode(`${lines.join('\n')}\n`);
}
