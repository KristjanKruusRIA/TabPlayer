import {validateEngraving} from './engraving/projection';
import { validateStringCount,validateTuningName } from './editor/structure';
import {validateStrokePattern} from './editor/range-edits';
import {validatePageLayout} from './engraving/page';
import {validateHarmonyChord} from './harmony/chord-source';
import {validateBackingSettings} from './document-settings';
import {validateRatioTempoPoints} from './editor/tempo-types';
import {parseTrackColor} from './track-color';

const tuningNamed=new Set(['addTrack','setTuning','setStringCount']);
const staffSettingKeys=['tuning','capo','transposition','displayTransposition','clef','showTab','showNotation'];
const shapes:Record<string,readonly string[]>={
  setNote:['target','string','fret'],removeNote:['target','string'],setRest:['target'],setDuration:['target','duration','dots'],
  insertBeat:['target','duration','dots'],deleteBeat:['target'],appendMeasure:[],removeMeasure:['bar'],
  addTrack:['name','tuning','program'],removeTrack:['track'],moveTrack:['track','to'],duplicateTrack:['track'],setTrackColor:['track','color'],setTuning:['track','tuning'],setStringCount:['track','tuning','keep'],setScoreInfo:['title','artist','tempo'],
  setNoteTechniques:['target','string','patch'],setBeatTechniques:['target','patch'],setNoteLink:['from','to','kind'],
  setBeatRhythm:['target','duration','dots','tupletNumerator','tupletDenominator','graceType'],
  setTrackInfo:['track','name','shortName','program'],setStaffSettings:['track','staff','settings'],addStaff:['track','settings'],
  removeStaff:['track','staff'],addVoice:['track','staff'],removeVoice:['track','staff','voice'],
  copyVoice:['track','staff','sourceVoice','destinationVoice','startBar','endBar'],setTrackLayout:['track','barsPerSystem','lineBreaks'],
  setMeasureSettings:['bar','numerator','denominator','pickup','freeTime','repeatStart','repeatCount','endings','section','tempos'],
  setBarNotation:['track','staff','bar','keySignature','keyMode','clef'],setBeatAnnotation:['target','text','chord'],
  setTrackSound:['trackId','sound'],setTrackMix:['trackId','mix'],setBacking:['backing'],setPrintLayout:['layout'],
  replaceTempoAutomations:['points'],
  setScoreMetadata:['fields'],setDirections:['bar','directions'],setNoteSpelling:['target','noteIndex','accidentalMode'],
  addPitchedTrack:['name','program'],addPercussionTrack:['name','program'],
  addPitchedNote:['target','pitch'],setPitchedNote:['target','noteIndex','pitch'],
  addPercussionNote:['target','articulation'],setPercussionNote:['target','noteIndex','articulation'],
  removeNoteByIndex:['target','noteIndex'],setNoteTechniquesByIndex:['target','noteIndex','patch'],
  setNoteLinkByIndex:['from','to','kind'],
  setTrackLyrics:['track','visible','lines'],setBeatGestures:['target','patch'],setOttava:['from','to','ottava'],
  setCrescendo:['from','to','crescendo','targetDynamics'],setFermata:['target','fermata'],setSustainPedal:['target','pedal'],
  setBarGestures:['track','staff','bar','clefOttava'],setMasterBarGestures:['bar','commonTime','doubleBar','tripletFeel','beaming'],
  setSimile:['track','staff','bar','kind'],
  eraseSelection:['selection'],transposeSelection:['selection','semitones'],moveSelectionStrings:['selection','direction'],
  refingerSelection:['selection','maxFret'],setSelectionSustain:['selection','strings','kind','enabled'],
  setSelectionStrokes:['selection','technique','pattern'],setSelectionTies:['selection','tied'],
  insertMeasures:['beforeBar','count'],removeMeasures:['firstBar','lastBar'],
  pasteMusic:['clip','options'],
  setEngraving:['engraving'],setPageLayout:['layout'],
  setBeatText:['target','text'],setHarmonyChord:['target','chord','fillEmptyBeat'],
  transposeHarmony:['selection','interval','includeKeySignatures','includeChords'],
};
const metadata=['subTitle','album','words','music','copyright','tab','notices','instructions'];
function object(value:unknown):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid edit object.');
  return value as Record<string,unknown>;
}
function exact(value:unknown,keys:readonly string[]) {
  const result=object(value);
  if(Object.keys(result).length!==keys.length||keys.some(key=>!Object.hasOwn(result,key)))throw new Error('Invalid edit fields.');
  return result;
}
function integer(value:unknown,max=0xffffffff) {
  if(typeof value!=='number'||!Number.isInteger(value)||value<0||value>max)throw new Error('Invalid edit integer.');
}
function target(value:unknown) {
  const result=exact(value,['track','staff','bar','voice','beat']);Object.values(result).forEach(value=>integer(value));return result;
}
function indexed(value:unknown) {
  const result=exact(value,['target','noteIndex']);integer(result.noteIndex);return target(result.target);
}
function flag(value:unknown) {if(typeof value!=='boolean')throw new Error('Invalid edit flag.');}
function signedInteger(value:unknown,min:number,max:number):asserts value is number {
  if(typeof value!=='number'||!Number.isInteger(value)||value<min||value>max)throw new Error('Invalid harmony interval.');
}
function harmonyInterval(value:unknown):boolean {
  const interval=object(value);
  if(interval.kind==='semitones'||interval.kind==='diatonic'){
    const field=interval.kind==='semitones'?'semitones':'steps',limit=interval.kind==='semitones'?127:70;
    exact(value,['kind',field]);signedInteger(interval[field],-limit,limit);if(interval[field]===0)throw new Error('Choose a nonzero interval.');return interval.kind==='diatonic';
  }
  exact(value,['kind','number','quality','direction','octaves']);signedInteger(interval.number,1,7);signedInteger(interval.octaves,0,9);
  if(interval.kind!=='chromatic'||!['up','down'].includes(interval.direction as string))throw new Error('Invalid chromatic interval.');
  const perfect=[1,4,5].includes(interval.number),quality=interval.quality;
  if(!['perfect','major','minor','augmented','diminished'].includes(quality as string)||(quality==='perfect'&&!perfect)||(['major','minor'].includes(quality as string)&&perfect)||(interval.number===1&&quality==='diminished'))throw new Error('Invalid interval quality.');
  const adjustment=quality==='minor'?-1:quality==='augmented'?1:quality==='diminished'?(perfect?-1:-2):0,magnitude=[0,2,4,5,7,9,11][interval.number-1]+adjustment+interval.octaves*12;
  if(magnitude===0||magnitude>127)throw new Error('Choose a nonzero interval within 127 semitones.');return false;
}
function range(from:unknown,to:unknown) {
  const a=target(from),b=target(to);
  if(a.track!==b.track||a.staff!==b.staff||a.voice!==b.voice||Number(b.bar)<Number(a.bar)||(a.bar===b.bar&&Number(b.beat)<Number(a.beat)))throw new Error('Select a forward range in one voice.');
}
function nonempty(value:unknown):unknown[] {
  if(!Array.isArray(value)||!value.length)throw new Error('Select some music.');return value;
}
function unique(keys:unknown[]) {if(new Set(keys).size!==keys.length)throw new Error('Duplicate selection.');}
export function validateMusicClipEnvelope(value:unknown):void {
  const v2=object(value).version===2,clip=exact(value,['format','version','engineVersion','mode','kind','scoreJson','links',...v2?['harmony']:[]]);
  if(clip.format!=='TabPlayerClip'||![1,2].includes(clip.version as number)||clip.engineVersion!=='1.8.4'||!['singleTrack','multiTrack'].includes(clip.mode as string)||!['phrase','bars'].includes(clip.kind as string))throw new Error('Unsupported musical clipboard.');
  if(v2){
    if(!Array.isArray(clip.harmony))throw new Error('Invalid clipboard harmony records.');
    unique(Array.from(clip.harmony,value=>{const record=exact(value,['track','staff','chordId','chord']);integer(record.track);integer(record.staff);if(typeof record.chordId!=='string'||!record.chordId.length)throw new Error('Invalid clipboard chord identity.');validateHarmonyChord(record.chord);return JSON.stringify([record.track,record.staff,record.chordId]);}));
  }
  if(typeof clip.scoreJson!=='string'||new TextEncoder().encode(clip.scoreJson).byteLength>128000000)throw new Error('Invalid clipboard model size.');
  const json:unknown=JSON.parse(clip.scoreJson,(_key,value:unknown)=>{if(typeof value==='number'&&!Number.isFinite(value))throw new Error('Invalid clipboard number.');return value;});object(json);
  if(!Array.isArray(clip.links))throw new Error('Invalid clipboard links.');
  unique(Array.from(clip.links,value=>{
    const link=exact(value,['from','to','kind','slideOutType']);integer(link.from);integer(link.to);
    if(!['tie','slur','slide','hammerPull'].includes(link.kind as string)||(link.kind==='slide'?![1,2].includes(link.slideOutType as number):link.slideOutType!==null))throw new Error('Invalid clipboard relationship.');
    return [link.from,link.to,link.kind,link.slideOutType].join('/');
  }));
}
function pasteOptions(value:unknown) {
  const options=exact(value,['target','destinations','count','placement','filters']);target(options.target);integer(options.count,1000);
  if(options.count===0||!['currentBar','beforeBar'].includes(options.placement as string))throw new Error('Invalid paste placement or count.');
  const filters=exact(options.filters,['diagrams','texts','timers','trackAutomations','masterAutomations','sections']);Object.values(filters).forEach(flag);
  const destinations=Array.from(nonempty(options.destinations),value=>{
    const destination=exact(value,['sourceTrack','track','staffMap']);integer(destination.sourceTrack);integer(destination.track);
    const staves=nonempty(destination.staffMap);for(const staff of staves)integer(staff);unique(staves);return destination;
  });
  unique(destinations.map(value=>value.sourceTrack));unique(destinations.map(value=>value.track));
}
function musicSelection(value:unknown) {
  const selection=object(value);
  if(selection.kind==='notes'){
    exact(value,['kind','notes']);
    unique(nonempty(selection.notes).map(note=>{const location=indexed(note);return [...['track','staff','bar','voice','beat'].map(key=>location[key]),object(note).noteIndex].join('/');}));
  }else if(selection.kind==='bars'){
    exact(value,['kind','tracks','firstBar','lastBar']);integer(selection.firstBar);integer(selection.lastBar);
    if(Number(selection.firstBar)>Number(selection.lastBar))throw new Error('Invalid measure range.');
    const tracks=nonempty(selection.tracks);tracks.forEach(value=>integer(value));unique(tracks);
  }else if(selection.kind==='range'){
    exact(value,['kind','range']);const range=exact(selection.range,['start','end','lanes']);
    const start=exact(range.start,['bar','tick']),end=exact(range.end,['bar','tick']);
    Object.values(start).forEach(value=>integer(value));Object.values(end).forEach(value=>integer(value));
    if(Number(end.bar)<Number(start.bar)||(end.bar===start.bar&&Number(end.tick)<=Number(start.tick)))throw new Error('Invalid music range.');
    unique(nonempty(range.lanes).map(value=>{const lane=exact(value,['track','staff','voice']);Object.values(lane).forEach(value=>integer(value));return [lane.track,lane.staff,lane.voice].join('/');}));
  }else throw new Error('Invalid music selection.');
}
function gestureShape(value:unknown) {
  const patch=object(value),flags=['tap','slap','pop','deadSlapped','slashed','showTimer'];
  const enums:Record<string,number>={golpe:2,rasgueado:18,fade:3,vibrato:2,beamingMode:3,wahPedal:2};
  if(!Object.keys(patch).length)throw new Error('Choose a beat gesture.');
  for(const [key,field]of Object.entries(patch)) {
    if(flags.includes(key))flag(field);
    else if(Object.hasOwn(enums,key))integer(field,enums[key]);
    else if(key==='stem') {if(!['auto','inverted','up','down'].includes(field as string))throw new Error('Invalid stem choice.');}
    else if(key==='barre') {
      if(field===null)continue;
      const barre=exact(field,['fret','shape']);integer(barre.fret,127);integer(barre.shape,2);
      if(barre.fret===0||barre.shape===0)throw new Error('Invalid barre.');
    }else throw new Error('Unknown beat gesture.');
  }
}
function techniqueShape(value:unknown) {
  const patch=object(value),flags=['letRing','palmMute','dead','ghost','staccato','leftHandTapped'];
  const enums=['accent','dynamics','leftFinger','rightFinger','slideIn','slideOut','vibrato','ornament'];
  for(const [key,field]of Object.entries(patch)) {
    if(flags.includes(key)){if(typeof field!=='boolean')throw new Error('Invalid technique flag.');}
    else if(enums.includes(key)){if(typeof field!=='number'||!Number.isInteger(field))throw new Error('Invalid technique value.');}
    else if(['bend','harmonic','trill'].includes(key)) {
      if(field===null)continue;
      const item=exact(field,key==='bend'?['type','style','points']:key==='harmonic'?['type','value']:['pitch','speed']);
      for(const [name,number]of Object.entries(item))if(name!=='points'&&(typeof number!=='number'||!Number.isFinite(number)))throw new Error('Invalid technique parameter.');
      if(key==='bend') {
        if(!Array.isArray(item.points))throw new Error('Invalid bend points.');
        for(const point of item.points)if(Object.values(exact(point,['offset','value'])).some(number=>typeof number!=='number'||!Number.isFinite(number)))throw new Error('Invalid bend point.');
      }
    }else throw new Error('Unknown note technique.');
  }
}

/** Exact command envelopes; score-dependent note/technique validation stays in the editor. */
export function validateParityCommand(value:unknown):void {
  const candidate=object(value),type=candidate.type;
  if(typeof type!=='string'||!Object.hasOwn(shapes,type))throw new Error('Unknown edit command in project.');
  const named=tuningNamed.has(type)&&Object.hasOwn(candidate,'tuningName');
  const edit=exact(value,['type',...shapes[type],...(named?['tuningName']:[])]);
  if(named)validateTuningName(edit.tuningName===undefined?null:edit.tuningName);
  if(type==='setStaffSettings'||type==='addStaff'){
    const settings=object(edit.settings),hasName=Object.hasOwn(settings,'tuningName');
    exact(settings,[...staffSettingKeys,...(hasName?['tuningName']:[])]);
    if(hasName)validateTuningName(settings.tuningName===undefined?null:settings.tuningName);
  }
  if(type==='setBacking'&&edit.backing!==null)validateBackingSettings(edit.backing);
  if(type==='replaceTempoAutomations')validateRatioTempoPoints(edit.points);
  if('target'in edit)target(edit.target);
  for(const key of ['noteIndex','bar','track','staff'])if(key in edit)integer(edit[key]);
  for(const key of ['pitch','program'])if(key in edit)integer(edit[key],127);
  if('articulation'in edit)integer(edit.articulation,0x7fffffff);
  if('name'in edit&&typeof edit.name!=='string')throw new Error('Invalid track name.');
  if('selection'in edit)musicSelection(edit.selection);
  if(type==='moveTrack')integer(edit.to);
  if(type==='setTrackColor')parseTrackColor(edit.color);
  if(type==='setSustainPedal'&&!['down','up','none'].includes(edit.pedal as string))throw new Error('Invalid sustain pedal mark.');
  if(type==='transposeSelection'&&(typeof edit.semitones!=='number'||!Number.isInteger(edit.semitones)||edit.semitones===0||Math.abs(edit.semitones)>127))throw new Error('Choose a nonzero semitone shift from -127 to 127.');
  if(type==='moveSelectionStrings'&&!['higher','lower'].includes(edit.direction as string))throw new Error('Invalid string direction.');
  if(type==='refingerSelection'){integer(edit.maxFret,127);if(edit.maxFret===0)throw new Error('Invalid maximum fret.');}
  if(type==='setSelectionSustain'){
    flag(edit.enabled);if(!['letRing','palmMute'].includes(edit.kind as string))throw new Error('Invalid sustain technique.');
    const strings=nonempty(edit.strings);for(const string of strings){integer(string);if(string===0)throw new Error('Invalid string.');}unique(strings);
  }
  if(type==='setSelectionStrokes')validateStrokePattern(edit.technique,edit.pattern);
  if(type==='setSelectionTies')flag(edit.tied);
  if(type==='setStringCount')validateStringCount(edit.tuning,edit.keep);
  if(type==='insertMeasures'){integer(edit.beforeBar);integer(edit.count,1000);if(edit.count===0)throw new Error('Insert at least one measure.');}
  if(type==='removeMeasures'){integer(edit.firstBar);integer(edit.lastBar);if(Number(edit.firstBar)>Number(edit.lastBar))throw new Error('Invalid measure range.');}
  if(type==='pasteMusic'){validateMusicClipEnvelope(edit.clip);pasteOptions(edit.options);}
  if(type==='setEngraving')validateEngraving(edit.engraving);
  if(type==='setPageLayout')validatePageLayout(edit.layout);
  if(type==='setBeatText'&&typeof edit.text!=='string')throw new Error('Invalid beat text.');
  if(type==='setHarmonyChord'){flag(edit.fillEmptyBeat);if(edit.chord!==null)validateHarmonyChord(edit.chord);}
  if(type==='transposeHarmony'){
    flag(edit.includeKeySignatures);flag(edit.includeChords);
    if(harmonyInterval(edit.interval)&&(edit.includeKeySignatures||edit.includeChords))throw new Error('Diatonic transposition does not update chords or keys.');
  }
  if(type==='setScoreMetadata') {
    const fields=exact(edit.fields,metadata);if(Object.values(fields).some(value=>typeof value!=='string'))throw new Error('Invalid score metadata.');
  }
  if(type==='setDirections') {
    if(!Array.isArray(edit.directions))throw new Error('Invalid directions.');edit.directions.forEach(value=>integer(value,18));
  }
  if(type==='setNoteSpelling')integer(edit.accidentalMode,6);
  if(type==='setTrackLyrics') {
    flag(edit.visible);
    if(!Array.isArray(edit.lines)||edit.lines.length>5)throw new Error('Use at most five lyric lines.');
    for(const line of edit.lines) {
      const item=exact(line,['startBar','text']);integer(item.startBar);if(typeof item.text!=='string')throw new Error('Invalid lyrics.');
    }
  }
  if(type==='setBeatGestures')gestureShape(edit.patch);
  if(type==='setOttava'||type==='setCrescendo')range(edit.from,edit.to);
  if(type==='setOttava')integer(edit.ottava,4);
  if(type==='setCrescendo') {
    integer(edit.crescendo,2);
    if(edit.crescendo===0) {if(edit.targetDynamics!==null)throw new Error('Clearing a hairpin retains dynamics.');}
    else integer(edit.targetDynamics,7);
  }
  if(type==='setFermata'&&edit.fermata!==null) {
    const fermata=exact(edit.fermata,['type','length']);integer(fermata.type,2);
    if(typeof fermata.length!=='number'||!Number.isFinite(fermata.length)||fermata.length<0)throw new Error('Invalid fermata length.');
  }
  if(type==='setBarGestures')integer(edit.clefOttava,4);
  if(type==='setMasterBarGestures') {
    flag(edit.commonTime);flag(edit.doubleBar);integer(edit.tripletFeel,6);
    if(edit.beaming!==null) {
      const rule=exact(edit.beaming,['unit','groups']);
      if(![8,16,32].includes(rule.unit as number)||!Array.isArray(rule.groups)||!rule.groups.length)throw new Error('Invalid beaming groups.');
      for(const group of rule.groups)if(typeof group!=='number'||!Number.isSafeInteger(group)||group<=0)throw new Error('Invalid beaming group.');
    }
  }
  if(type==='setSimile'&&!['none','single','double'].includes(edit.kind as string))throw new Error('Invalid simile.');
  if(type==='setNoteTechniquesByIndex')techniqueShape(edit.patch);
  if(type==='setNoteLinkByIndex') {
    const from=indexed(edit.from);
    if(!['tie','hammerPull','slur'].includes(edit.kind as string))throw new Error('Invalid note relationship.');
    if(edit.to!==null) {
      const to=indexed(edit.to);
      if(from.track!==to.track||from.staff!==to.staff||from.voice!==to.voice||Number(to.bar)<Number(from.bar)||(to.bar===from.bar&&Number(to.beat)<=Number(from.beat)))throw new Error('Link notes forward in the same staff and voice.');
    }
  }
}
