import { model } from '@coderline/alphatab';
import type { HarmonyChord } from '../editor/harmony-types';
import { copyHarmonyChord,getHarmonyChord,setHarmonyChordSource } from '../harmony/chord-source';

const names=['DiagramWorkingSet','DiagramCollection'];
const fingerNames:Record<number,string>={[-1]:'None',0:'Thumb',1:'Index',2:'Middle',3:'Ring',4:'Pinky'};
const fingerValues:Record<string,number>={None:-1,Thumb:0,Index:1,Middle:2,Ring:3,Rank:3,Pinky:4};
function orderedTracks(doc:Document):(Element|undefined)[] {
  const tracks=new Map([...doc.querySelectorAll('GPIF > Tracks > Track')].map(track=>[track.getAttribute('id'),track]));
  return (doc.querySelector('GPIF > MasterTrack > Tracks')?.textContent??'').trim().split(/\s+/).filter(Boolean).map(id=>tracks.get(id));
}
function number(node:Element,name:string,fallback:number,min:number,max:number):number {
  const raw=node.getAttribute(name),value=raw===null?fallback:Number(raw);if(raw?.trim()===''||!Number.isInteger(value)||value<min||value>max)throw new Error('Invalid GPIF chord diagram.');return value;
}
function properties(node:Element,name:string):Element|undefined {
  return [...node.querySelectorAll(':scope > Property')].find(property=>property.getAttribute('name')===name);
}
function readDefinition(item:Element,previous:model.Chord|null):HarmonyChord {
  const diagram=item.querySelector(':scope > Diagram');
  const value:HarmonyChord={name:item.getAttribute('name')??'',nameMode:'manual',recipe:null,firstFret:1,frets:[],fingers:[],barreFrets:[],showName:true,showDiagram:!!diagram,showFingering:!!diagram};
  if(!diagram)return value;
  const count=number(diagram,'stringCount',6,0,12),base=number(diagram,'baseFret',0,-1,126);value.firstFret=base+1;value.frets=Array(count).fill(-1);value.fingers=Array(count).fill(-2);
  for(const fret of diagram.querySelectorAll(':scope > Fret')){
    const index=count-1-number(fret,'string',0,0,count-1),position=base+number(fret,'fret',0,-126,128);if(position<0||position>127)throw new Error('Invalid GPIF chord fret.');value.frets[index]=position;
  }
  const positions=[...diagram.querySelectorAll(':scope > Fingering > Position')],groups=new Map<string,Set<number>>();
  for(const position of positions){
    const index=count-1-number(position,'string',0,0,count-1),fret=base+number(position,'fret',0,-127,128),finger=fingerValues[position.getAttribute('finger')??'']??-2;
    if(fret!==value.frets[index])continue;value.fingers[index]=finger;
    if(finger>=0&&fret>=0){
      const key=`${finger}/${fret}`,strings=groups.get(key)??new Set<number>();groups.set(key,strings);
      if(!strings.has(index)&&strings.size===1)value.barreFrets.push(fret);strings.add(index);
    }
  }
  if(!positions.length)value.barreFrets=[...previous?.barreFrets??[]];
  for(const [name,key]of [['ShowName','showName'],['ShowDiagram','showDiagram'],['ShowFingering','showFingering']] as const){
    const field=properties(diagram,name);if(field)value[key]=field.getAttribute('value')==='true';
  }
  return value;
}
function publicFields(value:HarmonyChord) {
  return {name:value.name,firstFret:value.firstFret,strings:[...value.frets],barreFrets:[...value.barreFrets],showName:value.showName,showDiagram:value.showDiagram,showFingering:value.showFingering};
}

/** Recover explicit fingers from the bounded Tracks projection, without guessing theory. */
export function readGpifHarmony(score:model.Score,doc:Document):void {
  const updates:Array<{staff:model.Staff;id:string;chord:model.Chord;candidate:model.Chord;value:HarmonyChord}>=[];
  orderedTracks(doc).forEach((node,index)=>{
    const track=score.tracks[index];if(!track||!node)return;
    const staves=[...node.querySelectorAll(':scope > Staves > Staff')];
    track.staves.forEach((staff,staffIndex)=>{
      const definitions=new Map<string,Element>();
      for(const scope of [node.querySelector(':scope > Properties'),staves[staffIndex]?.querySelector(':scope > Properties')])if(scope)for(const name of names){
        for(const item of properties(scope,name)?.querySelectorAll(':scope > Items > Item')??[]){const id=item.getAttribute('id');if(id!==null)definitions.set(id,item);}
      }
      for(const [id,item]of definitions){
        const previous=staff.getChord(id),value=readDefinition(item,previous),candidate=new model.Chord();Object.assign(candidate,publicFields(value),{staff});setHarmonyChordSource(candidate,value);
        updates.push({staff,id,chord:previous??new model.Chord(),candidate,value});
      }
    });
  });
  for(const {staff,id,chord,candidate,value}of updates){Object.assign(chord,publicFields(value));staff.addChord(id,chord);copyHarmonyChord(candidate,chord);}
}
function element(doc:Document,parent:Element,name:string,attributes:Record<string,string>={}):Element {
  const node=doc.createElement(name);for(const [key,value]of Object.entries(attributes))node.setAttribute(key,value);parent.append(node);return node;
}

/** Patch demonstrated standard fields only; leave the public theoretical subtree untouched. */
export function writeGpifHarmony(score:model.Score,doc:Document):void {
  const tracks=orderedTracks(doc);
  score.tracks.forEach((track,trackIndex)=>track.staves.forEach((staff,staffIndex)=>{
    if(!staff.chords?.size)return;
    const owner=tracks[trackIndex]?.querySelectorAll(':scope > Staves > Staff')[staffIndex],scope=owner?.querySelector(':scope > Properties');if(!scope)throw new Error('Missing GPIF staff for chord export.');
    for(const name of names){
      const collection=properties(scope,name)??element(doc,scope,'Property',{name}),items=collection.querySelector(':scope > Items')??element(doc,collection,'Items');
      for(const [id,chord]of staff.chords){
        const value=getHarmonyChord(chord),item=[...items.querySelectorAll(':scope > Item')].find(node=>node.getAttribute('id')===id)??element(doc,items,'Item',{id});item.setAttribute('name',value.name);
        const diagram=item.querySelector(':scope > Diagram')??element(doc,item,'Diagram',{fretCount:'5'}),base=value.firstFret-1;
        diagram.setAttribute('stringCount',String(value.frets.length));diagram.setAttribute('baseFret',String(base));diagram.setAttribute('barStates',value.frets.map(()=>'1').join(' '));
        for(const fret of diagram.querySelectorAll(':scope > Fret'))fret.remove();
        const first=diagram.firstChild;
        value.frets.forEach((fret,index)=>{if(fret>=0)diagram.insertBefore(element(doc,diagram,'Fret',{string:String(value.frets.length-1-index),fret:String(fret-base)}),first);});
        // With no explicit fingers, keep the public writer's compatible-barre positions.
        if(value.fingers.some(finger=>finger!==-2)){
          const fingering=diagram.querySelector(':scope > Fingering')??element(doc,diagram,'Fingering');fingering.replaceChildren();
          const order=value.fingers.flatMap((finger,index)=>finger===-2?[]:[index]),rank=(index:number)=>{const position=value.barreFrets.indexOf(value.frets[index]);return position<0?value.barreFrets.length:position;};
          // Standard Positions express barres through repeated fingers; keep declared groups in order.
          order.sort((a,b)=>rank(a)-rank(b)||a-b);
          for(const index of order)element(doc,fingering,'Position',{finger:fingerNames[value.fingers[index]],fret:String(value.frets[index]-base),string:String(value.frets.length-1-index)});
        }
        for(const [field,flag]of [['ShowName',value.showName],['ShowDiagram',value.showDiagram],['ShowFingering',value.showFingering]] as const){
          const property=properties(diagram,field)??element(doc,diagram,'Property',{name:field,type:'bool'});property.setAttribute('value',String(flag));
        }
      }
    }
  }));
}
