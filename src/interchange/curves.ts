import { model } from '@coderline/alphatab';

/**
 * GPIF holds a bend or whammy as at most four points (origin, two middles, destination) and no style. alphaTab writes
 * nothing at all for a longer curve, truncates every value to a whole unit when it reads (so a quarter tone held as a
 * fractional value is lost), re-derives the curve type and drops the style. It never writes or reads a note-to-note
 * slur, which GPIF can only hint at with beat legato over adjacent beats.
 *
 * TabPlayer therefore also keeps each curve and each slur exactly, in a staff property of its own that this reader
 * restores, as it does for scale diagrams. The ordinary GPIF fields are still written as alphaTab writes them, so other
 * readers see the file as before. A curve is restored only while the ordinary fields still read as written: an editor
 * that changed them and kept the unknown property must not be overridden by an older copy.
 */
export const gpifCurvesProperty='TabPlayerCurves';
const maxPoints=1024;

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
function indexById(doc:Document,path:string) {
  return new Map([...doc.querySelectorAll(path)].map(node=>[node.getAttribute('id'),node]));
}

interface Address {bar:number;voice:number;beat:number;note:number}
/** Position in the staff. The writer lists an empty voice as -1 and the reader puts an empty voice back, so voice numbers hold. */
function beatAddress(beat:model.Beat):Address {
  const voice=beat.voice;
  return {bar:voice.bar.index,voice:voice.index,beat:beat.index,note:-1};
}
const noteAddress=(note:model.Note):Address=>({...beatAddress(note.beat),note:note.beat.notes.indexOf(note)});
const attributes=(address:Address,prefix='')=>({[`${prefix}bar`]:String(address.bar),[`${prefix}voice`]:String(address.voice),[`${prefix}beat`]:String(address.beat),...address.note>=0?{[`${prefix}note`]:String(address.note)}:{}});

/** Whether the score has a curve or slur the ordinary GPIF fields cannot hold exactly. */
export function hasGpifCurves(score:model.Score):boolean {
  return score.tracks.some(track=>track.staves.some(staff=>staff.bars.some(bar=>bar.voices.some(voice=>!voice.isEmpty&&voice.beats.some(beat=>beat.hasWhammyBar||beat.notes.some(note=>note.hasBend||!!note.slurDestination))))));
}

/** `xml` is the full document alphaTab wrote, which `doc` (tracks only) leaves out; it is read only to note what the ordinary fields hold. */
export function writeGpifCurves(score:model.Score,doc:Document,xml:string):void {
  let full:Document|undefined,notes:Map<string|null,Element>,beats:Map<string|null,Element>;
  const written=()=>{if(!full){full=new DOMParser().parseFromString(xml,'application/xml');notes=indexById(full,'GPIF > Notes > Note');beats=indexById(full,'GPIF > Beats > Beat');}};
  const tracks=orderedTracks(doc);
  score.tracks.forEach((track,trackIndex)=>track.staves.forEach((staff,staffIndex)=>{
    const entries:Element[]=[],items=doc.createElement('Items');
    const curve=(parent:Element,type:number,style:number,points:model.BendPoint[])=>{
      parent.setAttribute('type',String(type));parent.setAttribute('style',String(style));
      for(const point of points)element(doc,parent,'Point',{offset:exact(point.offset),value:exact(point.value)});
    };
    for(const bar of staff.bars)for(const voice of bar.voices){
      if(voice.isEmpty)continue;
      for(const beat of voice.beats){
        if(beat.hasWhammyBar&&beat.whammyBarPoints){
          written();const node=element(doc,items,'Whammy',{...attributes(beatAddress(beat)),id:String(beat.id),fields:beatFields(beats.get(String(beat.id)))});
          curve(node,beat.whammyBarType,beat.whammyStyle,beat.whammyBarPoints);entries.push(node);
        }
        for(const note of beat.notes){
          if(note.hasBend&&note.bendPoints){
            written();const node=element(doc,items,'Bend',{...attributes(noteAddress(note)),id:String(note.id),fields:noteFields(notes.get(String(note.id)))});
            curve(node,note.bendType,note.bendStyle,note.bendPoints);entries.push(node);
          }
          const target=note.slurDestination;
          if(target&&target.beat.voice.bar.staff===staff)entries.push(element(doc,items,'Slur',{...attributes(noteAddress(note)),string:String(note.string),fret:String(note.fret),...attributes(noteAddress(target),'to'),toStr:String(target.string),toFret:String(target.fret)}));
        }
      }
    }
    if(!entries.length)return;
    const scope=tracks[trackIndex]?.querySelectorAll(':scope > Staves > Staff')[staffIndex]?.querySelector(':scope > Properties');
    if(!scope)throw new Error('Missing GPIF staff for curve export.');
    const holder=holderOf(scope)??element(doc,scope,'Property',{name:gpifCurvesProperty});
    holder.append(items);
  }));
}

function locate(staff:model.Staff,node:Element,prefix=''):{note?:model.Note;beat?:model.Beat} {
  const address={bar:whole(node.getAttribute(`${prefix}bar`)),voice:whole(node.getAttribute(`${prefix}voice`)),beat:whole(node.getAttribute(`${prefix}beat`))},noteIndex=node.getAttribute(`${prefix}note`);
  const beat=staff.bars[address.bar]?.voices[address.voice]?.beats[address.beat];
  return {beat,note:beat&&noteIndex!==null?beat.notes[whole(noteIndex)]:undefined};
}
function readPoints(node:Element,kind:Record<number,string>):{type:number;style:number;points:{offset:number;value:number}[]} {
  const type=number(node.getAttribute('type')),style=number(node.getAttribute('style'));
  if(!enumOf(kind,type)||!enumOf(model.BendStyle as unknown as Record<number,string>,style))throw new Error('Invalid curve type or style.');
  const points=[...node.querySelectorAll(':scope > Point')].map(point=>({offset:number(point.getAttribute('offset')),value:number(point.getAttribute('value'))}));
  if(!points.length||points.length>maxPoints||points.some(point=>Number.isNaN(point.offset)||Number.isNaN(point.value)))throw new Error('Invalid curve points.');
  return {type,style,points};
}

/**
 * Restores the curves and slurs `writeGpifCurves` kept. A malformed or stale item is skipped with a warning and never
 * refuses the file. `xml` is the full document, read only to confirm the ordinary fields still hold what was written.
 */
export function readGpifCurves(score:model.Score,doc:Document,xml:string):void {
  let full:Document|undefined,notes:Map<string|null,Element>,beats:Map<string|null,Element>;
  const written=()=>{if(!full){full=new DOMParser().parseFromString(xml,'application/xml');notes=indexById(full,'GPIF > Notes > Note');beats=indexById(full,'GPIF > Beats > Beat');}};
  const touched=new Set<model.Note>(),beatsTouched=new Set<model.Beat>(),slurs:{staff:model.Staff;node:Element}[]=[];
  orderedTracks(doc).forEach((node,index)=>{
    const track=score.tracks[index];if(!track||!node)return;
    [...node.querySelectorAll(':scope > Staves > Staff')].forEach((staffNode,staffIndex)=>{
      const staff=track.staves[staffIndex],scope=staffNode.querySelector(':scope > Properties'),holder=scope&&holderOf(scope);if(!staff||!holder)return;
      for(const item of holder.querySelectorAll(':scope > Items > *')){
        try{
          if(item.localName==='Slur'){slurs.push({staff,node:item});continue;}
          if(item.localName!=='Bend'&&item.localName!=='Whammy')throw new Error('Unknown curve item.');
          const {note,beat}=locate(staff,item);written();
          if(item.localName==='Bend'){
            if(!note)throw new Error('The curve refers to missing music.');
            // The ordinary fields changed after this was written: they are what the file now says.
            if(noteFields(notes.get(item.getAttribute('id')??''))!==item.getAttribute('fields'))continue;
            const {type,style,points}=readPoints(item,model.BendType as unknown as Record<number,string>);
            note.bendPoints=null;note.maxBendPoint=null;note.bendType=type;note.bendStyle=style;
            for(const point of points)note.addBendPoint(new model.BendPoint(point.offset,point.value));
            touched.add(note);
          }else{
            if(!beat)throw new Error('The curve refers to missing music.');
            if(beatFields(beats.get(item.getAttribute('id')??''))!==item.getAttribute('fields'))continue;
            const {type,style,points}=readPoints(item,model.WhammyType as unknown as Record<number,string>);
            beat.whammyBarPoints=null;beat.maxWhammyPoint=null;beat.minWhammyPoint=null;beat.whammyBarType=type;beat.whammyStyle=style;
            for(const point of points)beat.addWhammyBarPoint(new model.BendPoint(point.offset,point.value));
            beatsTouched.add(beat);
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
      if(!from||!to||from===to)throw new Error('The slur refers to missing music.');
      if(from.beat.voice.bar.index>to.beat.voice.bar.index)throw new Error('The slur does not run forward.');
      // The file may have been edited and kept the property: only the notes it was written on may carry the slur.
      if(from.string!==number(node.getAttribute('string'))||from.fret!==number(node.getAttribute('fret'))||to.string!==number(node.getAttribute('toStr'))||to.fret!==number(node.getAttribute('toFret')))continue;
      if(from.slurDestination||to.slurOrigin)throw new Error('The slur overlaps another slur.');
      from.slurDestination=to;to.slurOrigin=from;to.isSlurDestination=true;
    }catch(cause){console.warn(`Skipped a malformed slur in the GP file: ${cause instanceof Error?cause.message:String(cause)}`);}
  }
}
