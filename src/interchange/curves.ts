import { model } from '@coderline/alphatab';

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
const holderOf=(scope:Element)=>[...scope.querySelectorAll(':scope > Property')].find(item=>item.getAttribute('name')===gpifCurvesProperty);
function element(doc:Document,parent:Element,name:string,attributes:Record<string,string>={}):Element {
  const node=doc.createElement(name);for(const [key,value]of Object.entries(attributes))node.setAttribute(key,value);parent.append(node);return node;
}
// `String` would write a negative zero as "0".
const exact=(value:number)=>Object.is(value,-0)?'-0':String(value);
const whole=(value:string|null)=>value!==null&&/^\d+$/.test(value)?Number(value):NaN;
const number=(value:string|null)=>{const parsed=value!==null&&value.trim()!==''?Number(value):NaN;return Number.isFinite(parsed)?parsed:NaN;};
const enumOf=(kind:Record<number,string>,value:number)=>Number.isInteger(value)&&kind[value]!==undefined;

/** What the ordinary GPIF fields of a note or beat hold, in a form that changes whenever any of them does. */
const noteFields=(node:Element|undefined)=>node?[...node.querySelectorAll(':scope > Properties > Property')].filter(item=>(item.getAttribute('name')??'').startsWith('Bend')).map(item=>`${item.getAttribute('name')}=${item.querySelector(':scope > Float')?.textContent??''}`).join(';'):'';
const beatFields=(node:Element|undefined)=>{const whammy=node?.querySelector(':scope > Whammy');return whammy?[...whammy.attributes].map(attribute=>`${attribute.name}=${attribute.value}`).sort().join(';'):'';};
const byId=(doc:Document,path:string)=>new Map([...doc.querySelectorAll(path)].map(node=>[node.getAttribute('id'),node]));
/** The strings and frets of a beat's notes, which a moved or edited beat would not keep. */
const noteList=(beat:model.Beat)=>beat.notes.map(note=>`${note.string}:${note.fret}`).join(',');

interface Curve {type:number;style:number;points:{offset:number;value:number}[]}
/**
 * The rules a native curve already obeys: `validateCurve` (sorted finite offsets from 0 to 60, endpoints at 0 and 60, a
 * bend never negative), the Rust `PitchCurve::validate`, the point count each bend type needs to draw (a BendRelease
 * reads its fourth point), and the value bound above.
 */
export function checkCurve(whammy:boolean,curve:Curve):void {
  const kind=(whammy?model.WhammyType:model.BendType) as unknown as Record<number,string>;
  if(!enumOf(kind,curve.type)||curve.type===0||!enumOf(model.BendStyle as unknown as Record<number,string>,curve.style))throw new Error('Invalid curve type or style.');
  const {points}=curve;
  if(points.length<2||points.length>maxPoints||(!whammy&&curve.type===model.BendType.BendRelease&&points.length<4))throw new Error('The curve has too few or too many points for its type.');
  if(points[0].offset!==0||points[points.length-1].offset!==60)throw new Error('The curve must run from 0 to 60.');
  let previous=-1;
  for(const point of points){
    if(!Number.isFinite(point.offset)||point.offset<0||point.offset>60||point.offset<=previous)throw new Error('The curve points must be sorted and within 0 to 60.');
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
const valid=(check:()=>void)=>{try{check();return true;}catch{return false;}};

interface Address {bar:number;voice:number;beat:number;note:number}
/** Position in the staff. The writer lists an empty voice as -1 and the reader puts an empty voice back, so voice numbers hold. */
function beatAddress(beat:model.Beat):Address {
  return {bar:beat.voice.bar.index,voice:beat.voice.index,beat:beat.index,note:-1};
}
const noteAddress=(note:model.Note):Address=>({...beatAddress(note.beat),note:note.beat.notes.indexOf(note)});
const attributes=(address:Address,prefix='')=>({[`${prefix}bar`]:String(address.bar),[`${prefix}voice`]:String(address.voice),[`${prefix}beat`]:String(address.beat),...address.note>=0?{[`${prefix}note`]:String(address.note)}:{}});

/** Where the file's own Bars, Voices, Beats and Notes lists place each id. An id listed twice has no place. */
function placement(full:Document) {
  const list=(node:Element,name:string)=>(node.querySelector(`:scope > ${name}`)?.textContent??'').trim().split(/\s+/).filter(Boolean);
  const bars=new Map<string,{master:number;position:number}|null>(),voices=new Map<string,{bar:string;order:number}|null>(),beats=new Map<string,{voice:string;order:number}|null>(),notes=new Map<string,{beat:string;order:number}|null>();
  const put=<T,>(map:Map<string,T|null>,id:string,value:T)=>{if(id!=='-1')map.set(id,map.has(id)?null:value);};
  full.querySelectorAll('GPIF > MasterBars > MasterBar').forEach((master,index)=>list(master,'Bars').forEach((id,position)=>put(bars,id,{master:index,position})));
  for(const bar of full.querySelectorAll('GPIF > Bars > Bar'))list(bar,'Voices').forEach((id,order)=>put(voices,id,{bar:bar.getAttribute('id')??'',order}));
  for(const voice of full.querySelectorAll('GPIF > Voices > Voice'))list(voice,'Beats').forEach((id,order)=>put(beats,id,{voice:voice.getAttribute('id')??'',order}));
  for(const beat of full.querySelectorAll('GPIF > Beats > Beat'))list(beat,'Notes').forEach((id,order)=>put(notes,id,{beat:beat.getAttribute('id')??'',order}));
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

/** `xml` is the full document alphaTab wrote, which `doc` (tracks only) leaves out; it is read only to note what the ordinary fields hold. */
export function writeGpifCurves(score:model.Score,doc:Document,xml:string):void {
  let notes:Map<string|null,Element>,beats:Map<string|null,Element>,ready=false;
  const written=()=>{if(!ready){const full=new DOMParser().parseFromString(xml,'application/xml');notes=byId(full,'GPIF > Notes > Note');beats=byId(full,'GPIF > Beats > Beat');ready=true;}};
  const tracks=orderedTracks(doc);
  score.tracks.forEach((track,trackIndex)=>track.staves.forEach((staff,staffIndex)=>{
    const items=doc.createElement('Items');let count=0;
    const curve=(parent:Element,type:number,style:number,points:model.BendPoint[])=>{
      parent.setAttribute('type',String(type));parent.setAttribute('style',String(style));
      for(const point of points)element(doc,parent,'Point',{offset:exact(point.offset),value:exact(point.value)});
    };
    for(const bar of staff.bars)for(const voice of bar.voices){
      if(voice.isEmpty)continue;
      for(const beat of voice.beats){
        // What the reader would refuse is not written, so a file never warns about its own content.
        if(beat.hasWhammyBar&&beat.whammyBarPoints&&valid(()=>checkCurve(true,{type:beat.whammyBarType,style:beat.whammyStyle,points:beat.whammyBarPoints!}))){
          written();const node=element(doc,items,'Whammy',{...attributes(beatAddress(beat)),id:String(beat.id),notes:noteList(beat),fields:beatFields(beats.get(String(beat.id)))});
          curve(node,beat.whammyBarType,beat.whammyStyle,beat.whammyBarPoints);count++;
        }
        for(const note of beat.notes){
          if(note.hasBend&&note.bendPoints&&valid(()=>checkCurve(false,{type:note.bendType,style:note.bendStyle,points:note.bendPoints!}))){
            written();const node=element(doc,items,'Bend',{...attributes(noteAddress(note)),id:String(note.id),string:String(note.string),fret:String(note.fret),fields:noteFields(notes.get(String(note.id)))});
            curve(node,note.bendType,note.bendStyle,note.bendPoints);count++;
          }
          const target=note.slurDestination;
          if(target&&valid(()=>checkSlur(note,target))){
            element(doc,items,'Slur',{...attributes(noteAddress(note)),id:String(note.id),string:String(note.string),fret:String(note.fret),...attributes(noteAddress(target),'to'),toId:String(target.id),toStr:String(target.string),toFret:String(target.fret)});count++;
          }
        }
      }
    }
    if(!count)return;
    const scope=tracks[trackIndex]?.querySelectorAll(':scope > Staves > Staff')[staffIndex]?.querySelector(':scope > Properties');
    if(!scope)throw new Error('Missing GPIF staff for curve export.');
    (holderOf(scope)??element(doc,scope,'Property',{name:gpifCurvesProperty})).append(items);
  }));
}

function locate(staff:model.Staff,node:Element,prefix=''):{note?:model.Note;beat?:model.Beat} {
  const beat=staff.bars[whole(node.getAttribute(`${prefix}bar`))]?.voices[whole(node.getAttribute(`${prefix}voice`))]?.beats[whole(node.getAttribute(`${prefix}beat`))],noteIndex=node.getAttribute(`${prefix}note`);
  return {beat,note:beat&&noteIndex!==null?beat.notes[whole(noteIndex)]:undefined};
}
function readCurve(node:Element,whammy:boolean):Curve {
  const curve={type:number(node.getAttribute('type')),style:number(node.getAttribute('style')),points:[...node.querySelectorAll(':scope > Point')].map(point=>({offset:number(point.getAttribute('offset')),value:number(point.getAttribute('value'))}))};
  checkCurve(whammy,curve);return curve;
}

/**
 * Restores the curves and slurs `writeGpifCurves` kept. A malformed, stale or dangling item is skipped with a warning
 * and never refuses the file. `xml` is the full document, read to check ids and the ordinary fields.
 */
export function readGpifCurves(score:model.Score,doc:Document,xml:string):void {
  const staves=score.tracks.flatMap(track=>track.staves);
  let notes!:Map<string|null,Element>,beats!:Map<string|null,Element>,where!:ReturnType<typeof placement>,ready=false;
  const written=()=>{if(!ready){const full=new DOMParser().parseFromString(xml,'application/xml');notes=byId(full,'GPIF > Notes > Note');beats=byId(full,'GPIF > Beats > Beat');where=placement(full);ready=true;}};
  const touched=new Set<model.Note>(),beatsTouched=new Set<model.Beat>(),slurs:{staff:model.Staff;node:Element}[]=[];
  const stale=(reason:string)=>console.warn(`Skipped a curve or slur in the GP file that no longer matches its music: ${reason}`);
  orderedTracks(doc).forEach((node,index)=>{
    const track=score.tracks[index];if(!track||!node)return;
    [...node.querySelectorAll(':scope > Staves > Staff')].forEach((staffNode,staffIndex)=>{
      const staff=track.staves[staffIndex],scope=staffNode.querySelector(':scope > Properties'),holder=scope&&holderOf(scope);if(!staff||!holder)return;
      const position=staves.indexOf(staff);
      for(const item of holder.querySelectorAll(':scope > Items > *')){
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
