import type { model } from '@coderline/alphatab';
import type { EditCommand } from '../edit-types';
import type { BeatTarget } from '../project';
import { readExpression } from './expressions';

/** What a palette command does: an undoable edit, a selection move, or an application command. */
export type PaletteAction={kind:'edit';command:EditCommand}|{kind:'select';target:BeatTarget}|{kind:'app';name:'undo'|'redo'|'play'|'new'|'open'|'importAscii'|'save'|'saveAs'|'export'|'help'|'about'};
export interface PaletteContext {score:model.Score;target:BeatTarget;string:number;canUndo:boolean;canRedo:boolean;/** The document is finalized: edit actions, undo and redo cannot run. */locked?:boolean;/** The score is hidden (e.g. in Sound view): score editing commands cannot run. */scoreHidden?:boolean}
/** A command matching the typed text, with either a ready action or the reason it cannot run. */
export interface PaletteMatch {id:string;title:string;hint:string;keys?:string;action?:PaletteAction;error?:string}

type Result={action:PaletteAction}|{error:string};
interface Command {id:string;title:string;words:string;hint:string;keys?:string;
  /** Builds the action from the typed argument, which is empty when none was typed. */
  run:(argument:string,context:PaletteContext)=>Result}

const durations=[1,2,4,8,16,32,64];
/** The modifier the app's shortcuts use on a platform: Cmd on Apple systems, Ctrl elsewhere. The app accepts either key. */
export function shortcutModifier(platform:string|undefined):'Cmd'|'Ctrl' {return /Mac|iPhone|iPad/.test(platform??'')?'Cmd':'Ctrl';}
const mod=shortcutModifier(typeof navigator!=='undefined'?navigator.platform:undefined);
const integer=(text:string,min:number,max:number)=>/^\d+$/.test(text)&&Number(text)>=min&&Number(text)<=max?Number(text):null;
const beatAt=(context:PaletteContext)=>{const {track,staff,bar,voice,beat}=context.target,value=context.score.tracks[track]?.staves[staff]?.bars[bar]?.voices[voice]?.beats[beat];return value&&!value.isEmpty?value:null;};
const edit=(command:EditCommand):Result=>({action:{kind:'edit',command}});
const app=(name:Extract<PaletteAction,{kind:'app'}>['name']):Result=>({action:{kind:'app',name}});
const needsBeat=(context:PaletteContext,build:(beat:model.Beat)=>Result):Result=>{const beat=beatAt(context);return beat?build(beat):{error:'Select an existing beat.'};};

const commands:Command[]=[
  {id:'measure',title:'Go to measure',words:'go to goto jump measure bar',hint:'measure 12',run:(argument,{score,target})=>{
    const bar=integer(argument,1,score.masterBars.length);
    return bar===null?{error:`Type a measure number from 1 to ${score.masterBars.length}.`}:{action:{kind:'select',target:{...target,bar:bar-1,beat:0}}};
  }},
  {id:'track',title:'Go to track',words:'go to goto jump track instrument',hint:'track 2',run:(argument,{score,target})=>{
    const track=integer(argument,1,score.tracks.length);
    // Every track shares the measures, so the current measure is kept, as clicking a track does.
    return track===null?{error:`Type a track number from 1 to ${score.tracks.length}.`}:{action:{kind:'select',target:{...target,track:track-1,staff:0,voice:0,beat:0}}};
  }},
  {id:'fret',title:'Set fret',words:'set fret note',hint:'fret 5',run:(argument,context)=>{
    const staff=context.score.tracks[context.target.track]?.staves[context.target.staff];
    if(!staff||staff.isPercussion||!staff.tuning.length)return {error:'Frets apply to fretted tracks.'};
    const fret=integer(argument,0,99);
    if(fret===null)return {error:'Type a fret from 0 to 99.'};
    // staff.tuning[0] is the highest string, while string 1 is the lowest.
    if(staff.tuning[staff.tuning.length-context.string]+fret>127)return {error:'That fret would sound above the highest MIDI pitch.'};
    return edit({type:'setNote',target:context.target,string:context.string,fret});
  }},
  {id:'duration',title:'Set duration',words:'set duration rhythm length note value',hint:'duration 8 or 1/8',run:(argument,context)=>{
    const value=/^1\/\d+$/.test(argument)?Number(argument.slice(2)):integer(argument,1,64);
    if(value===null||!durations.includes(value))return {error:'Type a duration: 1, 2, 4, 8, 16, 32 or 64 (or 1/8).'};
    // The edit wants 1/1 for a plain beat, where alphaTab stores -1/-1.
    return needsBeat(context,beat=>edit({type:'setBeatRhythm',target:context.target,duration:value,dots:beat.dots,tupletNumerator:beat.tupletNumerator>0?beat.tupletNumerator:1,tupletDenominator:beat.tupletDenominator>0?beat.tupletDenominator:1,graceType:beat.graceType}));
  }},
  {id:'tempo',title:'Set initial tempo',words:'set tempo bpm speed initial start',hint:'tempo 96',run:(argument,{score})=>{
    const tempo=/^\d+(\.\d+)?$/.test(argument)&&Number(argument)>=1&&Number(argument)<=999?Number(argument):null;
    return tempo===null?{error:'Type a tempo from 1 to 999 BPM.'}:edit({type:'setScoreInfo',title:score.title,artist:score.artist,tempo});
  }},
  {id:'insertBeat',title:'Insert beat',words:'insert add beat',hint:'',run:(_,context)=>{
    const beat=beatAt(context);return edit({type:'insertBeat',target:context.target,duration:beat?.duration??4,dots:beat?.dots??0});
  }},
  {id:'deleteBeat',title:'Delete beat',words:'delete beat',hint:'',run:(_,context)=>needsBeat(context,()=>edit({type:'deleteBeat',target:context.target}))},
  {id:'rest',title:'Make rest',words:'make set rest silence',hint:'',run:(_,context)=>needsBeat(context,()=>edit({type:'setRest',target:context.target}))},
  {id:'appendMeasure',title:'Append measure',words:'append add measure bar',hint:'',run:()=>edit({type:'appendMeasure'})},
  {id:'removeMeasure',title:'Remove measure',words:'remove delete measure bar',hint:'',run:(_,{score,target})=>score.masterBars.length>1?edit({type:'removeMeasure',bar:target.bar}):{error:'A score needs at least one measure.'}},
  {id:'undo',keys:`${mod}+Z`,title:'Undo',words:'undo',hint:'',run:(_,{canUndo})=>canUndo?app('undo'):{error:'Nothing to undo.'}},
  {id:'redo',keys:`${mod}+Shift+Z`,title:'Redo',words:'redo',hint:'',run:(_,{canRedo})=>canRedo?app('redo'):{error:'Nothing to redo.'}},
  {id:'play',keys:`Space`,title:'Play or pause',words:'play pause stop playback',hint:'',run:()=>app('play')},
  {id:'new',keys:`${mod}+N`,title:'New score',words:'new score file',hint:'',run:()=>app('new')},
  {id:'open',keys:`${mod}+O`,title:'Open score',words:'open score file',hint:'',run:()=>app('open')},
  {id:'importAscii',title:'Import ASCII tab',words:'import ascii text tab tablature file',hint:'',run:()=>app('importAscii')},
  {id:'save',keys:`${mod}+S`,title:'Save',words:'save file',hint:'',run:()=>app('save')},
  {id:'saveAs',keys:`${mod}+Shift+S`,title:'Save As',words:'save as file',hint:'',run:()=>app('saveAs')},
  {id:'help',keys:`F1`,title:'Help topics',words:'help manual guide topics',hint:'',run:()=>app('help')},
  {id:'about',title:'About and updates',words:'about version updates check',hint:'',run:()=>app('about')},
  {id:'export',title:'Export score',words:'export score file pdf midi audio',hint:'',run:()=>app('export')},
];

/**
 * Matches typed text against command words by prefix; one trailing number or fraction is the command's argument.
 * Text that reads as an expression, such as ff, 3/4 or Am7, comes first, except after commands whose title holds every
 * typed word, so p still plays and f still sets a fret.
 */
export function searchCommands(query:string,context:PaletteContext):PaletteMatch[] {
  const tokens=query.trim().toLowerCase().replace(/\s*\/\s*/g,'/').split(/\s+/).filter(Boolean),argumentIndex=tokens.findIndex(token=>/^-?[\d./]+$/.test(token));
  const words=argumentIndex<0?tokens:tokens.slice(0,argumentIndex),argument=argumentIndex<0?'':tokens.slice(argumentIndex).join(' ');
  const ranked=commands.flatMap((command,order)=>{
    const titleWords=command.title.toLowerCase().split(/\s+/),own=[...titleWords,...command.words.split(/\s+/)];
    // Commands without a parameter, shown by an empty hint, drop out once one is typed.
    if(argument&&!command.hint||!words.every(word=>own.some(candidate=>candidate.startsWith(word))))return [];
    // Separate numbers are refused rather than merged, so "measure 1 2" never means measure 12.
    const result:Result=argument.includes(' ')?{error:'Type a single value after the command.'}:command.run(argument,context);
    const titleHits=words.filter(word=>titleWords.some(candidate=>candidate.startsWith(word))).length;
    return [{order,titleHits,match:{id:command.id,title:command.title,hint:command.hint,...(command.keys?{keys:command.keys}:{}),...('action' in result?{action:result.action}:{error:result.error})}}];
  });
  // Commands whose title holds the typed words come before those matched only by an alias.
  const sorted=ranked.sort((a,b)=>b.titleHits-a.titleHits||a.order-b.order),expression=readExpression(query,context);
  if(!expression)return sorted.map(entry=>entry.match);
  const lead=words.length?sorted.filter(entry=>entry.titleHits===words.length).length:0;
  return [...sorted.slice(0,lead).map(entry=>entry.match),expression,...sorted.slice(lead).map(entry=>entry.match)];
}
