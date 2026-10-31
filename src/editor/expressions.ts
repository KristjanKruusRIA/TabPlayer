import { model } from '@coderline/alphatab';
import type { EditCommand } from '../edit-types';
import type { ChordFormulaId,ChordRecipe,HarmonyChord,SpelledPitchClass } from './harmony-types';
import { findChordShapes,formatChordName } from '../harmony/chords';
import { measureSettingsExact,readMeasureSettings } from './measure-settings';
import { validateCapacity } from './common';
import type { PaletteContext,PaletteMatch } from './command-palette';

/**
 * Expression text: words typed without a command, such as ff, 3/4, Eb major, bass, D.S. al Coda, [Chorus] or Am7,
 * applied to the edit target's beat or measure. Each expression is one undoable edit.
 */
type Outcome={title:string;command:EditCommand}|{title:string;error:string};

/** Every dynamic alphaTab writes, typed in lower case: ppp to fff, sfz, fp and the rest. */
const dynamicNames=new Map(Object.keys(model.DynamicValue).filter(name=>Number.isNaN(Number(name))).map(name=>[name.toLowerCase(),model.DynamicValue[name as keyof typeof model.DynamicValue]]));
const meters=[1,2,4,8,16,32,64];
const naturals=[0,2,4,5,7,9,11];
const majorKeys=['Cb','Gb','Db','Ab','Eb','Bb','F','C','G','D','A','E','B','F#','C#'];
const minorKeys=['Ab','Eb','Bb','F','C','G','D','A','E','B','F#','C#','G#','D#','A#'];
const clefs:Record<string,[string,number]>={treble:['Treble',model.Clef.G2],bass:['Bass',model.Clef.F4],alto:['Alto',model.Clef.C3],tenor:['Tenor',model.Clef.C4],neutral:['Neutral',model.Clef.Neutral],percussion:['Neutral',model.Clef.Neutral]};
const directionNames:[model.Direction,string,string[]][]=[
  [model.Direction.TargetFine,'Fine',[]],[model.Direction.TargetSegno,'Segno',[]],[model.Direction.TargetSegnoSegno,'Segno Segno',[]],[model.Direction.TargetCoda,'Coda',[]],[model.Direction.TargetDoubleCoda,'Double Coda',[]],
  [model.Direction.JumpDaCapo,'D.C.',[]],[model.Direction.JumpDaCapoAlCoda,'D.C. al Coda',[]],[model.Direction.JumpDaCapoAlDoubleCoda,'D.C. al Double Coda',[]],[model.Direction.JumpDaCapoAlFine,'D.C. al Fine',[]],
  [model.Direction.JumpDalSegno,'D.S.',[]],[model.Direction.JumpDalSegnoAlCoda,'D.S. al Coda',[]],[model.Direction.JumpDalSegnoAlDoubleCoda,'D.S. al Double Coda',[]],[model.Direction.JumpDalSegnoAlFine,'D.S. al Fine',[]],
  [model.Direction.JumpDalSegnoSegno,'D.S.S.',[]],[model.Direction.JumpDalSegnoSegnoAlCoda,'D.S.S. al Coda',[]],[model.Direction.JumpDalSegnoSegnoAlDoubleCoda,'D.S.S. al Double Coda',[]],[model.Direction.JumpDalSegnoSegnoAlFine,'D.S.S. al Fine',[]],
  [model.Direction.JumpDaCoda,'To Coda',['Da Coda']],[model.Direction.JumpDaDoubleCoda,'To Double Coda',['Da Double Coda']],
];
/** Lower case with dots read as spaces, so D.S., D. S. and DS match, and "da capo" and "dal segno" read as D.C. and D.S. */
const directionKey=(text:string)=>text.toLowerCase().replace(/\./g,' ').replace(/\s+/g,' ').trim()
  .replace(/^da capo\b/,'dc').replace(/^dal segno segno\b/,'dss').replace(/^dal segno\b/,'ds').replace(/^d c\b/,'dc').replace(/^d s s\b/,'dss').replace(/^d s\b/,'ds');
const directions=new Map(directionNames.flatMap(([value,name,aliases])=>[name,...aliases].map(text=>[directionKey(text),[value,name] as const])));
const isJump=(value:model.Direction)=>model.Direction[value].startsWith('Jump');
/** Chord suffixes and their common spellings, longest first so the regular expression prefers them. */
const suffixes:[string,ChordFormulaId][]=[
  ['mMaj7','mMaj7'],['mmaj7','mMaj7'],['maj9','maj9'],['maj7','maj7'],['m7b5','m7b5'],['min7','m7'],['7sus4','7sus4'],['dim7','dim7'],['sus2','sus2'],['sus4','sus4'],
  ['maj','major'],['min','minor'],['m11','m11'],['M7','maj7'],['M9','maj9'],['m6','m6'],['m7','m7'],['m9','m9'],['-7','m7'],['ø7','m7b5'],['°7','dim7'],['dim','dim'],['aug','aug'],
  ['11','11'],['13','13'],['m','minor'],['-','minor'],['+','aug'],['°','dim'],['ø','m7b5'],['5','power'],['6','6'],['7','7'],['9','9'],['','major'],
];
const escape=(text:string)=>text.replace(/[+\-]/g,'\\$&');
const chordPattern=new RegExp(`^([A-Ga-g])([#b]?)(${suffixes.map(([text])=>escape(text)).filter(Boolean).join('|')})?(?:/([A-G])([#b]?))?$`);

const spelled=(letter:string,accidental:string):SpelledPitchClass=>({step:'CDEFGAB'.indexOf(letter.toUpperCase()),alteration:accidental==='#'?1:accidental==='b'?-1:0});
const pitchOf=(value:SpelledPitchClass)=>(naturals[value.step]+value.alteration+12)%12;
const pretty=(name:string)=>name.replace('#','♯').replace(/(?<=^[A-G])b/,'♭');
const staffAt=({score,target}:PaletteContext)=>score.tracks[target.track].staves[target.staff];

function dynamic(query:string,context:PaletteContext):Outcome|null {
  const value=dynamicNames.get(query);if(value===undefined||query!==query.toLowerCase())return null;
  const {target,string}=context,staff=staffAt(context),title=`Dynamic ${query} on the note`,beat=staff.bars[target.bar]?.voices[target.voice]?.beats[target.beat];
  if(!beat||beat.isEmpty||!beat.notes.length)return {title,error:'A dynamic needs a note on the beat.'};
  // Notes keep their own dynamics, as in the inspector: the edit target's string picks the note in a chord.
  let noteIndex=staff.isPercussion?-1:beat.notes.findIndex(note=>note.string===string);
  if(noteIndex<0&&beat.notes.length===1)noteIndex=0;
  if(noteIndex<0)return {title,error:'Move the edit target to a note on this beat.'};
  return {title,command:{type:'setNoteTechniquesByIndex',target,noteIndex,patch:{dynamics:value}}};
}

/** Section and time expressions rewrite the whole measure, so they refuse a measure the rewrite would change. */
const measureProblem=(score:model.Score,bar:number)=>measureSettingsExact(score,bar)?null:`Measure ${bar+1} has a tempo change between beats or with a label; change it in the inspector's Measure & notation panel.`;

function meter(query:string,{score,target}:PaletteContext):Outcome|null {
  const match=/^(\d{1,3})\s*\/\s*(\d{1,3})$/.exec(query);if(!match)return null;
  const numerator=Number(match[1]),denominator=Number(match[2]),title=`Time signature ${numerator}/${denominator} for measure ${target.bar+1}`;
  if(numerator<1||numerator>32||!meters.includes(denominator))return {title,error:'Type a time signature such as 3/4, with up to 32 beats of 1, 2, 4, 8, 16, 32 or 64.'};
  const current=readMeasureSettings(score,target.bar);
  if(current.numerator===numerator&&current.denominator===denominator)return {title,error:`Measure ${target.bar+1} is already in ${numerator}/${denominator}.`};
  const problem=measureProblem(score,target.bar);if(problem)return {title,error:problem};
  // Every voice of every track must still fit; the edit would refuse an overfilled measure.
  const ticks=3840*numerator/denominator;
  try{for(const track of score.tracks)for(const staff of track.staves)for(const voice of staff.bars[target.bar]?.voices??[])validateCapacity(voice,ticks,current.freeTime);}
  catch{return {title,error:`Measure ${target.bar+1} holds more music than ${numerator}/${denominator} allows; shorten or remove beats first.`};}
  return {title,command:{type:'setMeasureSettings',bar:target.bar,...current,numerator,denominator}};
}

function section(query:string,{score,target}:PaletteContext):Outcome|null {
  const match=/^\[(.*)\]$/s.exec(query);if(!match)return null;
  const name=match[1].trim(),title=`Section “${name}” at measure ${target.bar+1}`,current=readMeasureSettings(score,target.bar);
  if(!name)return {title:'Section',error:'Type a section name between the brackets.'};
  if(name.length>60)return {title,error:'A section name can have up to 60 characters.'};
  if(current.section===name)return {title,error:`Measure ${target.bar+1} already starts the section “${name}”.`};
  const problem=measureProblem(score,target.bar);if(problem)return {title,error:problem};
  return {title,command:{type:'setMeasureSettings',bar:target.bar,...current,section:name}};
}

function key(query:string,context:PaletteContext):Outcome|null {
  const match=/^([A-Ga-g])([#b♯♭]?)\s+(major|minor)$/i.exec(query);if(!match)return null;
  const {target}=context,accidental=match[2].toLowerCase().replace('♯','#').replace('♭','b'),name=match[1].toUpperCase()+accidental,minor=match[3].toLowerCase()==='minor';
  const mode=minor?'minor':'major',table=minor?minorKeys:majorKeys,title=`Key ${pretty(name)} ${mode} for measure ${target.bar+1} of this staff`;
  const index=table.indexOf(name);
  if(index<0){
    const pitch=pitchOf(spelled(match[1],accidental)),choices=table.filter(other=>pitchOf(spelled(other[0],other.slice(1)))===pitch);
    const nearest=choices.sort((a,b)=>Math.abs(table.indexOf(a)-7)-Math.abs(table.indexOf(b)-7))[0];
    return {title,error:`${name} ${mode} needs more than seven ${accidental==='b'?'flats':'sharps'}; try ${nearest} ${mode}.`};
  }
  const staff=staffAt(context);if(staff.isPercussion)return {title,error:'Key signatures apply to pitched tracks.'};
  const bar=staff.bars[target.bar],fifths=index-7,keyMode=minor?model.KeySignatureType.Minor:model.KeySignatureType.Major;
  if(bar.keySignature===fifths&&bar.keySignatureType===keyMode)return {title,error:`Measure ${target.bar+1} is already in ${name} ${mode}.`};
  return {title,command:{type:'setBarNotation',track:target.track,staff:target.staff,bar:target.bar,keySignature:fifths,keyMode,clef:bar.clef}};
}

function clef(query:string,context:PaletteContext):Outcome|null {
  const entry=clefs[query.toLowerCase()];if(!entry)return null;
  const {target}=context,[name,value]=entry,title=`${name} clef for measure ${target.bar+1} of this staff`,bar=staffAt(context).bars[target.bar];
  if(bar.clef===value)return {title,error:`Measure ${target.bar+1} already has a ${name.toLowerCase()} clef.`};
  return {title,command:{type:'setBarNotation',track:target.track,staff:target.staff,bar:target.bar,keySignature:bar.keySignature,keyMode:bar.keySignatureType,clef:value}};
}

function direction(query:string,{score,target}:PaletteContext):Outcome|null {
  const entry=directions.get(directionKey(query));if(!entry)return null;
  const [value,name]=entry,title=`${name} at measure ${target.bar+1}`,current=[...(score.masterBars[target.bar].directions??[])];
  if(current.includes(value))return {title,error:`Measure ${target.bar+1} already has ${name}.`};
  // A measure jumps in one way only.
  const jump=isJump(value)?current.find(isJump):undefined;
  if(jump!==undefined)return {title,error:`Measure ${target.bar+1} already jumps with ${directionNames.find(([other])=>other===jump)![1]}.`};
  return {title,command:{type:'setDirections',bar:target.bar,directions:[...current,value].sort((a,b)=>a-b)}};
}

/**
 * The most playable diagram with the root, or the written bass, as its lowest note; the search is asked for that
 * bass and the chord keeps its plain name. Without such a shape, the most playable inversion is used.
 */
function diagram(staff:model.Staff,recipe:ChordRecipe):HarmonyChord|undefined {
  const search={maxFret:12,maxSpan:3,limit:1};
  try{
    const rooted=findChordShapes(staff,{...recipe,bass:recipe.bass??recipe.root},search)[0];
    return rooted?{...rooted,name:formatChordName(recipe),recipe:structuredClone(recipe)}:findChordShapes(staff,recipe,search)[0];
  }catch{return undefined;}
}

function chord(query:string,context:PaletteContext):Outcome|null {
  const match=chordPattern.exec(query);if(!match)return null;
  // A lower-case root needs a suffix, so a single letter typed for a command is not a chord.
  if(match[1]!==match[1].toUpperCase()&&!match[3])return null;
  const recipe:ChordRecipe={root:spelled(match[1],match[2]),formula:suffixes.find(([text])=>text===(match[3]??''))![1],alterations:[],omissions:[],bass:match[4]?spelled(match[4],match[5]):null};
  const {target}=context,name=formatChordName(recipe),title=`Chord ${name} on the beat`,staff=staffAt(context);
  if(staff.isPercussion||!staff.tuning.length)return {title,error:'Chords apply to fretted tracks.'};
  const beat=staff.bars[target.bar]?.voices[target.voice]?.beats[target.beat];
  if(!beat||beat.isEmpty)return {title,error:'Put a note or rest on this beat first.'};
  const strings=staff.tuning.length;
  // When no shape fits within 12 frets, only the name is shown.
  const value:HarmonyChord=diagram(staff,recipe)??{name,nameMode:'theory',recipe,firstFret:1,frets:Array(strings).fill(-1),fingers:Array(strings).fill(-1),barreFrets:[],showName:true,showDiagram:false,showFingering:false};
  return {title,command:{type:'setHarmonyChord',target,chord:value,fillEmptyBeat:false}};
}

/** Reads the whole typed text as an expression, or returns null when it is not one. */
export function readExpression(text:string,context:PaletteContext):PaletteMatch|null {
  const query=text.trim();if(!query)return null;
  for(const read of [dynamic,meter,section,key,clef,direction,chord]){
    const outcome=read(query,context);if(!outcome)continue;
    return {id:'expression',title:outcome.title,hint:'',...('command' in outcome?{action:{kind:'edit',command:outcome.command}}:{error:outcome.error})};
  }
  return null;
}
