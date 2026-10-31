import { model } from '@coderline/alphatab';
import { plainFret } from '../editor/banjo-drone';

/**
 * GPIF holds a bend or whammy as at most four points (origin, two middles, destination) and no style. alphaTab writes
 * nothing at all for a longer curve, truncates every value to a whole unit when it reads (so a quarter tone held as a
 * fractional value is lost), re-derives the curve type and drops the style. It never writes or reads a note-to-note
 * slur, which GPIF can only hint at with beat legato over adjacent beats.
 *
 * TabPlayer therefore also keeps each curve and each slur exactly, in a staff property of its own that this reader
 * restores, as it does for scale diagrams. The ordinary GPIF fields are still written as alphaTab writes them, so other
 * readers see the file as before.
 *
 * The file is untrusted. An item is applied only when all of these hold, otherwise it is skipped with a warning:
 *  - the item is well formed and obeys the rules native edits obey (see `checkCurve` and `checkSlur`);
 *  - the id it records is the id the file's own Bars, Voices, Beats and Notes lists place at the address it records;
 *  - the string and fret it records are those of the note it lands on;
 *  - for a curve, the ordinary GPIF fields still read as they were written, so an editor that changed them and kept the
 *    unknown property is not overridden by an older copy.
 */
export const gpifCurvesProperty='TabPlayerCurves';
const maxPoints=1024;
/**
 * The most curve points one file may hold in total. Playback of the worst curve (alternating between the extremes of the
 * value range) measured 98 MIDI events per point in this build, so a thousand 1024-point curves would be 100 million
 * events. An ordinary score does not come near: GP itself holds at most 4 points per bend, so even a bend on every beat
 * of a 300-bar song is about 5000 points. 16384 is three times that and bounds the worst case at about 1.6 million events.
 */
export const maxCurvePoints=16384;
/**
 * No native validator bounds a curve value beyond "finite" (and "not negative" for a bend). The playback plan and the
 * synth do need a bound: alphaTab maps a value of v to v/2 semitones on a pitch wheel it sets to ±16 semitones, so
 * beyond ±32 the wheel saturates, and a huge value costs millions of events or stalls the synth. Values beyond it are
 * not restored; the ordinary GPIF fields stand.
 */
export const maxCurveValue=32;

function orderedTracks(doc:Document):(Element|undefined)[] {
  const tracks=new Map([...doc.querySelectorAll('GPIF > Tracks > Track')].map(track=>[track.getAttribute('id'),track]));
  return (doc.querySelector('GPIF > MasterTrack > Tracks')?.textContent??'').trim().split(/\s+/).filter(Boolean).map(id=>tracks.get(id));
}
/** Direct children by name. A selector with `:scope` is slow on a large document, and a project replays its base file on every edit. */
const kids=(node:Element|null|undefined,name?:string)=>node?[...node.children].filter(child=>name===undefined||child.localName===name):[];
const holderOf=(scope:Element)=>kids(scope,'Property').find(item=>item.getAttribute('name')===gpifCurvesProperty);
function element(doc:Document,parent:Element,name:string,attributes:Record<string,string>={}):Element {
  const node=doc.createElement(name);for(const [key,value]of Object.entries(attributes))node.setAttribute(key,value);parent.append(node);return node;
}
// `String` would write a negative zero as "0".
const exact=(value:number)=>Object.is(value,-0)?'-0':String(value);
const whole=(value:string|null)=>value!==null&&/^\d+$/.test(value)?Number(value):NaN;
const number=(value:string|null)=>{const parsed=value!==null&&value.trim()!==''?Number(value):NaN;return Number.isFinite(parsed)?parsed:NaN;};
const enumOf=(kind:Record<number,string>,value:number)=>Number.isInteger(value)&&kind[value]!==undefined;

/** What the ordinary GPIF fields of a note or beat hold, in a form that changes whenever any of them does. */
const noteFields=(node:Element|undefined)=>node?kids(kids(node,'Properties')[0],'Property').filter(item=>(item.getAttribute('name')??'').startsWith('Bend')).map(item=>`${item.getAttribute('name')}=${kids(item,'Float')[0]?.textContent??''}`).join(';'):'';
const beatFields=(node:Element|undefined)=>{const whammy=kids(node,'Whammy')[0];return whammy?[...whammy.attributes].map(attribute=>`${attribute.name}=${attribute.value}`).sort().join(';'):'';};
/** The children of a top-level section of the GPIF, by walking rather than selecting, which is slow on a large document. */
const section=(doc:Document,name:string,child:string)=>doc.documentElement.localName==='GPIF'?kids(kids(doc.documentElement,name)[0],child):[];
const byId=(doc:Document,name:string,child:string)=>new Map(section(doc,name,child).map(node=>[node.getAttribute('id'),node]));
/** The strings and frets of a beat's notes, which a moved or edited beat would not keep. */
const noteList=(beat:model.Beat,fret:(note:model.Note)=>number=note=>note.fret)=>beat.notes.map(note=>`${note.string}:${fret(note)}`).join(',');
/** GPIF holds the plain fret of a banjo drone note, and so does the score read back, which has no drone set. */
const writtenFret=(note:model.Note)=>plainFret(note.beat.voice.bar.staff,note.string,note.fret);

interface Curve {type:number;style:number;points:{offset:number;value:number}[]}
/**
 * The rules a curve in the model obeys: finite offsets inside 0 to 60 that never go backwards, a bend never negative (as
 * `validateCurve` and the Rust `PitchCurve::validate` require), the point count each type needs to play and draw (a
 * BendRelease reads its fourth point, a Dip its third in every style), and the value bound above. Equal offsets and ends
 * short of 60 are allowed: `Note.finish` turns a 3-point bend-release into 4 points with a repeated offset, and GP files
 * hold curves that stop short of 60.
 */
export function checkCurve(whammy:boolean,curve:Curve):void {
  const kind=(whammy?model.WhammyType:model.BendType) as unknown as Record<number,string>;
  if(!enumOf(kind,curve.type)||curve.type===0||!enumOf(model.BendStyle as unknown as Record<number,string>,curve.style))throw new Error('Invalid curve type or style.');
  const {points}=curve;
  if(points.length<2||points.length>maxPoints||(!whammy&&curve.type===model.BendType.BendRelease&&points.length<4)||(whammy&&curve.type===model.WhammyType.Dip&&points.length<3))throw new Error('The curve has too few or too many points for its type.');
  let previous=-1;
  for(const point of points){
    if(!Number.isFinite(point.offset)||point.offset<0||point.offset>60||point.offset<previous)throw new Error('The curve points must not go backwards and must lie within 0 to 60.');
    if(!Number.isFinite(point.value)||Math.abs(point.value)>maxCurveValue||(!whammy&&point.value<0))throw new Error('A curve value is outside the range playback can use.');
    previous=point.offset;
  }
}
/** The rule `applyNoteLink` applies to a slur: the same voice, strictly forward by bar and then beat. */
export function checkSlur(from:model.Note,to:model.Note):void {
  const a=from.beat,b=to.beat;
  if(from===to||a.voice.bar.staff!==b.voice.bar.staff||a.voice.index!==b.voice.index)throw new Error('A slur links notes of one voice.');
  if(b.voice.bar.index<a.voice.bar.index||(b.voice.bar.index===a.voice.bar.index&&b.index<=a.index))throw new Error('A slur runs strictly forward.');
}

interface Address {bar:number;voice:number;beat:number;note:number}
/** Position in the staff. The writer lists an empty voice as -1 and the reader puts an empty voice back, so voice numbers hold. */
function beatAddress(beat:model.Beat):Address {
  return {bar:beat.voice.bar.index,voice:beat.voice.index,beat:beat.index,note:-1};
}
const noteAddress=(note:model.Note):Address=>({...beatAddress(note.beat),note:note.beat.notes.indexOf(note)});
const attributes=(address:Address,prefix='')=>({[`${prefix}bar`]:String(address.bar),[`${prefix}voice`]:String(address.voice),[`${prefix}beat`]:String(address.beat),...address.note>=0?{[`${prefix}note`]:String(address.note)}:{}});

/** Where the file's own Bars, Voices, Beats and Notes lists place each id. An id listed twice has no place. */
function placement(full:Document) {
  const list=(node:Element,name:string)=>(kids(node,name)[0]?.textContent??'').trim().split(/\s+/).filter(Boolean);
  const bars=new Map<string,{master:number;position:number}|null>(),voices=new Map<string,{bar:string;order:number}|null>(),beats=new Map<string,{voice:string;order:number}|null>(),notes=new Map<string,{beat:string;order:number}|null>();
  const put=<T,>(map:Map<string,T|null>,id:string,value:T)=>{if(id!=='-1')map.set(id,map.has(id)?null:value);};
  section(full,'MasterBars','MasterBar').forEach((master,index)=>list(master,'Bars').forEach((id,position)=>put(bars,id,{master:index,position})));
  for(const bar of section(full,'Bars','Bar'))list(bar,'Voices').forEach((id,order)=>put(voices,id,{bar:bar.getAttribute('id')??'',order}));
  for(const voice of section(full,'Voices','Voice'))list(voice,'Beats').forEach((id,order)=>put(beats,id,{voice:voice.getAttribute('id')??'',order}));
  for(const beat of section(full,'Beats','Beat'))list(beat,'Notes').forEach((id,order)=>put(notes,id,{beat:beat.getAttribute('id')??'',order}));
  /** The address of a beat, or of one of its notes, as the file places it, or undefined when the ids do not chain. */
  return (id:string|null,isNote:boolean):(Address&{staff:number})|undefined=>{
    let note=-1,beatId=id??'';
    if(isNote){const at=notes.get(beatId);if(!at)return undefined;note=at.order;beatId=at.beat;}
    const beat=beats.get(beatId),voice=beat&&voices.get(beat.voice),bar=voice&&bars.get(voice.bar);
    return beat&&voice&&bar?{bar:bar.master,voice:voice.order,beat:beat.order,note,staff:bar.position}:undefined;
  };
}
function sameAddress(found:(Address&{staff:number})|undefined,staff:number,node:Element,prefix=''):boolean {
  const note=node.getAttribute(`${prefix}note`);
  return !!found&&found.staff===staff&&found.bar===whole(node.getAttribute(`${prefix}bar`))&&found.voice===whole(node.getAttribute(`${prefix}voice`))&&found.beat===whole(node.getAttribute(`${prefix}beat`))&&found.note===(note===null?-1:whole(note));
}

/** Whether the score has a curve or slur the ordinary GPIF fields cannot hold exactly. */
export function hasGpifCurves(score:model.Score):boolean {
  return score.tracks.some(track=>track.staves.some(staff=>staff.bars.some(bar=>bar.voices.some(voice=>!voice.isEmpty&&voice.beats.some(beat=>beat.hasWhammyBar||beat.notes.some(note=>note.hasBend||!!note.slurDestination))))));
}

/**
 * `xml` is the full document alphaTab wrote, which `doc` (tracks only) leaves out; it is read only to note what the
 * ordinary fields hold. Nothing may vanish silently: a curve of more than four points has no ordinary fields, so one this
 * cannot carry (a value outside the range, or past the per-file point cap) and a slur it cannot carry stop the export
 * with a message that says where, which is the one way an export reports a problem to the user.
 */
export function writeGpifCurves(score:model.Score,doc:Document,xml:string):void {
  let notes!:Map<string|null,Element>,beats!:Map<string|null,Element>,ready=false;
  const written=()=>{if(!ready){const full=new DOMParser().parseFromString(xml,'application/xml');notes=byId(full,'Notes','Note');beats=byId(full,'Beats','Beat');ready=true;}};
  const tracks=orderedTracks(doc),lost:string[]=[];let total=0;
  const where=(beat:model.Beat)=>`track ${beat.voice.bar.staff.track.index+1}, bar ${beat.voice.bar.index+1}, beat ${beat.index+1}`;
  /** Whether a curve is carried; a curve nothing else can hold is reported. */
  const carry=(whammy:boolean,beat:model.Beat,type:number,style:number,points:model.BendPoint[])=>{
    try{
      checkCurve(whammy,{type,style,points});
      if(total+points.length>maxCurvePoints)throw new Error(`the file would hold more than ${maxCurvePoints} curve points`);
      total+=points.length;return true;
    }catch(cause){
      // Up to four points the ordinary fields still hold the curve as alphaTab writes it.
      if(points.length>4)lost.push(`the ${whammy?'whammy bar':'bend'} at ${where(beat)} (${cause instanceof Error?cause.message:String(cause)})`);
      return false;
    }
  };
  score.tracks.forEach((track,trackIndex)=>track.staves.forEach((staff,staffIndex)=>{
    const items=doc.createElement('Items');let count=0;
    const curve=(parent:Element,type:number,style:number,points:model.BendPoint[])=>{
      parent.setAttribute('type',String(type));parent.setAttribute('style',String(style));
      for(const point of points)element(doc,parent,'Point',{offset:exact(point.offset),value:exact(point.value)});
    };
    for(const bar of staff.bars)for(const voice of bar.voices){
      if(voice.isEmpty)continue;
      for(const beat of voice.beats){
        if(beat.hasWhammyBar&&beat.whammyBarPoints&&carry(true,beat,beat.whammyBarType,beat.whammyStyle,beat.whammyBarPoints)){
          written();const node=element(doc,items,'Whammy',{...attributes(beatAddress(beat)),id:String(beat.id),notes:noteList(beat,writtenFret),fields:beatFields(beats.get(String(beat.id)))});
          curve(node,beat.whammyBarType,beat.whammyStyle,beat.whammyBarPoints);count++;
        }
        for(const note of beat.notes){
          if(note.hasBend&&note.bendPoints&&carry(false,beat,note.bendType,note.bendStyle,note.bendPoints)){
            written();const node=element(doc,items,'Bend',{...attributes(noteAddress(note)),id:String(note.id),string:String(note.string),fret:String(writtenFret(note)),fields:noteFields(notes.get(String(note.id)))});
            curve(node,note.bendType,note.bendStyle,note.bendPoints);count++;
          }
          const target=note.slurDestination;
          if(target){
            try{checkSlur(note,target);}catch(cause){lost.push(`the slur at ${where(beat)} (${cause instanceof Error?cause.message:String(cause)})`);continue;}
            element(doc,items,'Slur',{...attributes(noteAddress(note)),id:String(note.id),string:String(note.string),fret:String(writtenFret(note)),...attributes(noteAddress(target),'to'),toId:String(target.id),toStr:String(target.string),toFret:String(writtenFret(target))});count++;
          }
        }
      }
    }
    if(!count)return;
    const scope=tracks[trackIndex]?.querySelectorAll(':scope > Staves > Staff')[staffIndex]?.querySelector(':scope > Properties');
    if(!scope)throw new Error('Missing GPIF staff for curve export.');
    (holderOf(scope)??element(doc,scope,'Property',{name:gpifCurvesProperty})).append(items);
  }));
  if(lost.length)throw new Error(`GP export cannot keep ${lost.slice(0,3).join('; ')}${lost.length>3?` and ${lost.length-3} more`:''}: Guitar Pro files hold at most four points per curve and no note slur, so TabPlayer keeps these itself, within limits it cannot meet here. Shorten or remove them, or export another format.`);
}

function locate(staff:model.Staff,node:Element,prefix=''):{note?:model.Note;beat?:model.Beat} {
  const beat=staff.bars[whole(node.getAttribute(`${prefix}bar`))]?.voices[whole(node.getAttribute(`${prefix}voice`))]?.beats[whole(node.getAttribute(`${prefix}beat`))],noteIndex=node.getAttribute(`${prefix}note`);
  return {beat,note:beat&&noteIndex!==null?beat.notes[whole(noteIndex)]:undefined};
}
function readCurve(node:Element,whammy:boolean):Curve {
  const curve={type:number(node.getAttribute('type')),style:number(node.getAttribute('style')),points:kids(node,'Point').map(point=>({offset:number(point.getAttribute('offset')),value:number(point.getAttribute('value'))}))};
  checkCurve(whammy,curve);return curve;
}

/**
 * Restores the curves and slurs `writeGpifCurves` kept. A malformed, stale or dangling item is skipped with a warning
 * and never refuses the file. `xml` is the full document, read to check ids and the ordinary fields.
 */
export function readGpifCurves(score:model.Score,doc:Document,xml:string):void {
  const staves=score.tracks.flatMap(track=>track.staves);
  let notes!:Map<string|null,Element>,beats!:Map<string|null,Element>,where!:ReturnType<typeof placement>,ready=false;
  const written=()=>{if(!ready){const full=new DOMParser().parseFromString(xml,'application/xml');notes=byId(full,'Notes','Note');beats=byId(full,'Beats','Beat');where=placement(full);ready=true;}};
  let total=0;
  const touched=new Set<model.Note>(),beatsTouched=new Set<model.Beat>(),slurs:{staff:model.Staff;node:Element}[]=[];
  const stale=(reason:string)=>console.warn(`Skipped a curve or slur in the GP file that no longer matches its music: ${reason}`);
  orderedTracks(doc).forEach((node,index)=>{
    const track=score.tracks[index];if(!track||!node)return;
    kids(kids(node,'Staves')[0],'Staff').forEach((staffNode,staffIndex)=>{
      const staff=track.staves[staffIndex],scope=kids(staffNode,'Properties')[0],holder=scope&&holderOf(scope);if(!staff||!holder)return;
      const position=staves.indexOf(staff);
      for(const item of kids(kids(holder,'Items')[0])){
        try{
          if(item.localName==='Slur'){slurs.push({staff,node:item});continue;}
          if(item.localName!=='Bend'&&item.localName!=='Whammy')throw new Error('Unknown curve item.');
          const isBend=item.localName==='Bend',{note,beat}=locate(staff,item);written();
          const target=isBend?note:beat;if(!target)throw new Error('The curve refers to missing music.');
          const curve=readCurve(item,!isBend);
          if(!sameAddress(where(item.getAttribute('id'),isBend),position,item)){stale('the file places that id elsewhere.');continue;}
          if(isBend?note!.string!==number(item.getAttribute('string'))||note!.fret!==number(item.getAttribute('fret')):noteList(beat!)!==item.getAttribute('notes')){stale('the notes differ.');continue;}
          // The ordinary fields changed after this was written: they are what the file now says.
          if((isBend?noteFields(notes.get(item.getAttribute('id')??'')):beatFields(beats.get(item.getAttribute('id')??'')))!==item.getAttribute('fields')){stale('its ordinary fields were edited.');continue;}
          if(total+curve.points.length>maxCurvePoints){console.warn(`Skipped a curve in the GP file: it would take the file past ${maxCurvePoints} curve points.`);continue;}
          total+=curve.points.length;
          if(isBend){
            note!.bendPoints=null;note!.maxBendPoint=null;note!.bendType=curve.type;note!.bendStyle=curve.style;
            for(const point of curve.points)note!.addBendPoint(new model.BendPoint(point.offset,point.value));
            touched.add(note!);
          }else{
            beat!.whammyBarPoints=null;beat!.maxWhammyPoint=null;beat!.minWhammyPoint=null;beat!.whammyBarType=curve.type;beat!.whammyStyle=curve.style;
            for(const point of curve.points)beat!.addWhammyBarPoint(new model.BendPoint(point.offset,point.value));
            beatsTouched.add(beat!);
          }
        }catch(cause){console.warn(`Skipped a malformed curve in the GP file: ${cause instanceof Error?cause.message:String(cause)}`);}
      }
    });
  });
  // alphaTab derived these from the curves it could read; a longer curve it dropped changes them.
  for(const note of touched){
    const destination=note.tieDestination;
    if(destination){destination.bendOrigin=note.hasBend?note:null;if(destination.hasBend)destination.isContinuedBend=note.hasBend;}
    if(note.hasBend&&note.isTieDestination&&note.tieOrigin)note.isContinuedBend=note.tieOrigin.hasBend;
  }
  for(const beat of beatsTouched){
    if(beat.hasWhammyBar)beat.isContinuedWhammy=!!beat.previousBeat?.hasWhammyBar;
    const next=beat.nextBeat;if(next?.hasWhammyBar)next.isContinuedWhammy=beat.hasWhammyBar;
  }
  for(const {staff,node}of slurs){
    try{
      const from=locate(staff,node).note,to=locate(staff,node,'to').note;
      if(!from||!to)throw new Error('The slur refers to missing music.');
      checkSlur(from,to);written();const position=staves.indexOf(staff);
      if(!sameAddress(where(node.getAttribute('id'),true),position,node)||!sameAddress(where(node.getAttribute('toId'),true),position,node,'to')){stale('the file places those ids elsewhere.');continue;}
      if(from.string!==number(node.getAttribute('string'))||from.fret!==number(node.getAttribute('fret'))||to.string!==number(node.getAttribute('toStr'))||to.fret!==number(node.getAttribute('toFret'))){stale('the notes differ.');continue;}
      if(from.slurDestination||to.slurOrigin)throw new Error('The slur overlaps another slur.');
      from.slurDestination=to;to.slurOrigin=from;to.isSlurDestination=true;
    }catch(cause){console.warn(`Skipped a malformed slur in the GP file: ${cause instanceof Error?cause.message:String(cause)}`);}
  }
}
