import type { model } from '@coderline/alphatab';
import type { EditCommand } from '../edit-types';
import type { BeatTarget } from '../project';
import { readExpression } from './expressions';
import { getMessage,type MessageKey } from '../i18n';

/** What a palette command does: an undoable edit, a selection move, or an application command. */
export type PaletteAction={kind:'edit';command:EditCommand}|{kind:'select';target:BeatTarget}|{kind:'app';name:'undo'|'redo'|'play'|'loop'|'slower'|'faster'|'new'|'open'|'importAscii'|'save'|'saveAs'|'export'|'help'|'about'};
export interface PaletteContext {score:model.Score;target:BeatTarget;string:number;canUndo:boolean;canRedo:boolean;/** The document is finalized: edit actions, undo and redo cannot run. */locked?:boolean;/** The score is hidden (e.g. in Sound view): score editing commands cannot run. */scoreHidden?:boolean}
/** A command matching the typed text, with either a ready action or the reason it cannot run. */
export interface PaletteMatch {id:string;title:string;hint:string;keys?:string;action?:PaletteAction;error?:string}

type Result={action:PaletteAction}|{error:string};
/** Looks a catalog text up in one language; the palette is given the app's current one. */
export type Translate=(key:MessageKey,params?:Record<string,string|number>)=>string;
const english:Translate=(key,params)=>getMessage('en',key,params);
/**
 * A command's title is the catalog text palette.command_<id> and its hint, when it takes a typed value, palette.hint_<id>.
 * `words` are English search aliases that stay the same in every language.
 */
interface Command {id:string;words:string;hint?:true;keys?:string;
  /** Builds the action from the typed argument, which is empty when none was typed. */
  run:(argument:string,context:PaletteContext,t:Translate)=>Result}

const durations=[1,2,4,8,16,32,64];
/** The modifier the app's shortcuts use on a platform: Cmd on Apple systems, Ctrl elsewhere. The app accepts either key. */
export function shortcutModifier(platform:string|undefined):'Cmd'|'Ctrl' {return /Mac|iPhone|iPad/.test(platform??'')?'Cmd':'Ctrl';}
const mod=shortcutModifier(typeof navigator!=='undefined'?navigator.platform:undefined);
const integer=(text:string,min:number,max:number)=>/^\d+$/.test(text)&&Number(text)>=min&&Number(text)<=max?Number(text):null;
const beatAt=(context:PaletteContext)=>{const {track,staff,bar,voice,beat}=context.target,value=context.score.tracks[track]?.staves[staff]?.bars[bar]?.voices[voice]?.beats[beat];return value&&!value.isEmpty?value:null;};
const edit=(command:EditCommand):Result=>({action:{kind:'edit',command}});
const app=(name:Extract<PaletteAction,{kind:'app'}>['name']):Result=>({action:{kind:'app',name}});
const needsBeat=(context:PaletteContext,t:Translate,build:(beat:model.Beat)=>Result):Result=>{const beat=beatAt(context);return beat?build(beat):{error:t('palette.error_select_beat')};};

const commands:Command[]=[
  {id:'measure',words:'go to goto jump measure bar',hint:true,run:(argument,{score,target},t)=>{
    const bar=integer(argument,1,score.masterBars.length);
    return bar===null?{error:t('palette.error_measure',{max:score.masterBars.length})}:{action:{kind:'select',target:{...target,bar:bar-1,beat:0}}};
  }},
  {id:'track',words:'go to goto jump track instrument',hint:true,run:(argument,{score,target},t)=>{
    const track=integer(argument,1,score.tracks.length);
    // Every track shares the measures, so the current measure is kept, as clicking a track does.
    return track===null?{error:t('palette.error_track',{max:score.tracks.length})}:{action:{kind:'select',target:{...target,track:track-1,staff:0,voice:0,beat:0}}};
  }},
  {id:'fret',words:'set fret note',hint:true,run:(argument,context,t)=>{
    const staff=context.score.tracks[context.target.track]?.staves[context.target.staff];
    if(!staff||staff.isPercussion||!staff.tuning.length)return {error:t('palette.error_fret_unfretted')};
    const fret=integer(argument,0,99);
    if(fret===null)return {error:t('palette.error_fret')};
    // staff.tuning[0] is the highest string, while string 1 is the lowest.
    if(staff.tuning[staff.tuning.length-context.string]+fret>127)return {error:t('palette.error_fret_pitch')};
    return edit({type:'setNote',target:context.target,string:context.string,fret});
  }},
  {id:'duration',words:'set duration rhythm length note value',hint:true,run:(argument,context,t)=>{
    const value=/^1\/\d+$/.test(argument)?Number(argument.slice(2)):integer(argument,1,64);
    if(value===null||!durations.includes(value))return {error:t('palette.error_duration')};
    // The edit wants 1/1 for a plain beat, where alphaTab stores -1/-1.
    return needsBeat(context,t,beat=>edit({type:'setBeatRhythm',target:context.target,duration:value,dots:beat.dots,tupletNumerator:beat.tupletNumerator>0?beat.tupletNumerator:1,tupletDenominator:beat.tupletDenominator>0?beat.tupletDenominator:1,graceType:beat.graceType}));
  }},
  {id:'tempo',words:'set tempo bpm speed initial start',hint:true,run:(argument,{score},t)=>{
    const tempo=/^\d+(\.\d+)?$/.test(argument)&&Number(argument)>=1&&Number(argument)<=999?Number(argument):null;
    return tempo===null?{error:t('palette.error_tempo')}:edit({type:'setScoreInfo',title:score.title,artist:score.artist,tempo});
  }},
  {id:'insertBeat',words:'insert add beat',run:(_,context)=>{
    const beat=beatAt(context);return edit({type:'insertBeat',target:context.target,duration:beat?.duration??4,dots:beat?.dots??0});
  }},
  {id:'deleteBeat',words:'delete beat',run:(_,context,t)=>needsBeat(context,t,()=>edit({type:'deleteBeat',target:context.target}))},
  {id:'rest',words:'make set rest silence',run:(_,context,t)=>needsBeat(context,t,()=>edit({type:'setRest',target:context.target}))},
  {id:'appendMeasure',words:'append add measure bar',run:()=>edit({type:'appendMeasure'})},
  {id:'removeMeasure',words:'remove delete measure bar',run:(_,{score,target},t)=>score.masterBars.length>1?edit({type:'removeMeasure',bar:target.bar}):{error:t('palette.error_last_measure')}},
  {id:'undo',keys:`${mod}+Z`,words:'undo',run:(_,{canUndo},t)=>canUndo?app('undo'):{error:t('palette.error_nothing_undo')}},
  {id:'redo',keys:`${mod}+Shift+Z`,words:'redo',run:(_,{canRedo},t)=>canRedo?app('redo'):{error:t('palette.error_nothing_redo')}},
  {id:'play',keys:`Space`,words:'play pause stop playback',run:()=>app('play')},
  {id:'loop',keys:`Shift+L`,words:'loop selection passage clear repeat practice',run:()=>app('loop')},
  {id:'slower',keys:`[`,words:'slower slow down speed practice',run:()=>app('slower')},
  {id:'faster',keys:`]`,words:'faster speed up practice',run:()=>app('faster')},
  {id:'new',keys:`${mod}+N`,words:'new score file',run:()=>app('new')},
  {id:'open',keys:`${mod}+O`,words:'open score file',run:()=>app('open')},
  {id:'importAscii',words:'import ascii text tab tablature file',run:()=>app('importAscii')},
  {id:'save',keys:`${mod}+S`,words:'save file',run:()=>app('save')},
  {id:'saveAs',keys:`${mod}+Shift+S`,words:'save as file',run:()=>app('saveAs')},
  {id:'help',keys:`F1`,words:'help manual guide topics',run:()=>app('help')},
  {id:'about',words:'about version updates check',run:()=>app('about')},
  {id:'export',words:'export score file pdf midi audio',run:()=>app('export')},
];

/** Lower case without accents, so a keyboard without ä, ö, ü or õ still finds Rückgängig, Määra and Über. */
const fold=(text:string)=>text.toLowerCase().normalize('NFD').replace(/\p{M}/gu,'');
/** Hyphens split a word, so Tabulatur is found inside ASCII-Tabulatur. */
const wordsOf=(text:string)=>fold(text).split(/[\s-]+/).filter(Boolean);

/**
 * Matches typed text against command words by prefix; one trailing number or fraction is the command's argument.
 * A command is found by the words of its title in the current language, and also by its English title and aliases, so
 * English can always be typed. A match on the current title ranks first, as the title does in English.
 * Text that reads as an expression, such as ff, 3/4 or Am7, comes first, except after commands whose English title holds
 * every typed word, so p still plays and f still sets a fret. That rule reads the English title in every language, so
 * an expression is placed the same way whatever language the titles are in.
 */
export function searchCommands(query:string,context:PaletteContext,t:Translate=english):PaletteMatch[] {
  const tokens=fold(query.trim()).replace(/\s*\/\s*/g,'/').split(/\s+/).filter(Boolean),argumentIndex=tokens.findIndex(token=>/^-?[\d./]+$/.test(token));
  const words=argumentIndex<0?tokens:tokens.slice(0,argumentIndex),argument=argumentIndex<0?'':tokens.slice(argumentIndex).join(' ');
  const holding=(candidates:string[])=>words.filter(word=>candidates.some(candidate=>candidate.startsWith(word))).length;
  const ranked=commands.flatMap((command,order)=>{
    const titleKey=`palette.command_${command.id}` as MessageKey,title=t(titleKey),currentWords=[...wordsOf(title),...wordsOf(t(`palette.aliases_${command.id}` as MessageKey))],englishWords=wordsOf(english(titleKey)),own=[...currentWords,...englishWords,...command.words.split(/\s+/)];
    // Commands without a parameter, shown by an empty hint, drop out once one is typed.
    if(argument&&!command.hint||!words.every(word=>own.some(candidate=>candidate.startsWith(word))))return [];
    // Separate numbers are refused rather than merged, so "measure 1 2" never means measure 12.
    const result:Result=argument.includes(' ')?{error:t('palette.error_single_value')}:command.run(argument,context,t);
    return [{order,titleHits:holding(currentWords),englishHits:holding(englishWords),match:{id:command.id,title,hint:command.hint?t(`palette.hint_${command.id}` as MessageKey):'',...(command.keys?{keys:command.keys}:{}),...('action' in result?{action:result.action}:{error:result.error})}}];
  });
  // Commands whose title holds the typed words come before those matched only by an alias.
  const sorted=ranked.sort((a,b)=>b.titleHits-a.titleHits||a.order-b.order),expression=readExpression(query,context);
  if(!expression)return sorted.map(entry=>entry.match);
  const lifted=words.length?sorted.filter(entry=>entry.englishHits===words.length):[];
  return [...lifted.map(entry=>entry.match),expression,...sorted.filter(entry=>!lifted.includes(entry)).map(entry=>entry.match)];
}
