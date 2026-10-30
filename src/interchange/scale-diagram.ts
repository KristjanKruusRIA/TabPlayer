import { model } from '@coderline/alphatab';
import { listScaleDiagrams,setScaleDiagram,validateScaleDiagram,type ScaleDiagram,type ScaleMark } from '../harmony/scale-diagram';

/**
 * Guitar Pro and alphaTab have no scale-diagram model, and GPIF documents none. TabPlayer therefore keeps
 * each diagram, with every mark, in a staff property of its own that this reader restores. Other readers
 * are expected to ignore an unknown property, so the file stays an ordinary GP file; they do not draw the diagram.
 */
export const gpifScaleProperty='TabPlayerScaleDiagrams';
function orderedTracks(doc:Document):(Element|undefined)[] {
  const tracks=new Map([...doc.querySelectorAll('GPIF > Tracks > Track')].map(track=>[track.getAttribute('id'),track]));
  return (doc.querySelector('GPIF > MasterTrack > Tracks')?.textContent??'').trim().split(/\s+/).filter(Boolean).map(id=>tracks.get(id));
}
const property=(scope:Element)=>[...scope.querySelectorAll(':scope > Property')].find(item=>item.getAttribute('name')===gpifScaleProperty);
function element(doc:Document,parent:Element,name:string,attributes:Record<string,string>={},text?:string):Element {
  const node=doc.createElement(name);for(const [key,value]of Object.entries(attributes))node.setAttribute(key,value);if(text!==undefined)node.textContent=text;parent.append(node);return node;
}
export function writeGpifScaleDiagrams(score:model.Score,doc:Document):void {
  const tracks=orderedTracks(doc);
  for(const {target,diagram}of listScaleDiagrams(score)){
    const scope=tracks[target.track]?.querySelectorAll(':scope > Staves > Staff')[target.staff]?.querySelector(':scope > Properties');
    if(!scope)throw new Error('Missing GPIF staff for scale diagram export.');
    const items=(property(scope)??element(doc,scope,'Property',{name:gpifScaleProperty})).querySelector(':scope > Items')??element(doc,property(scope)!,'Items');
    const item=element(doc,items,'Item',{bar:String(target.bar),voice:String(target.voice),beat:String(target.beat)});
    const node=element(doc,item,'Diagram',{strings:String(diagram.strings),frets:String(diagram.frets),firstFret:String(diagram.firstFret),orientation:diagram.orientation,showFretMarkers:String(diagram.showFretMarkers)});
    element(doc,node,'Name',{},diagram.name);
    for(const mark of diagram.marks){
      const entry=element(doc,node,'Mark',{string:String(mark.string),fret:String(mark.fret),shape:mark.shape,color:mark.color,textColor:mark.textColor});
      element(doc,entry,'Text',{},mark.text);
    }
  }
}
const whole=(value:string|null)=>value!==null&&/^\d+$/.test(value)?Number(value):NaN;
export function readGpifScaleDiagrams(score:model.Score,doc:Document):void {
  orderedTracks(doc).forEach((node,index)=>{
    const track=score.tracks[index];if(!track||!node)return;
    [...node.querySelectorAll(':scope > Staves > Staff')].forEach((staffNode,staffIndex)=>{
      const scope=staffNode.querySelector(':scope > Properties'),holder=scope&&property(scope);if(!holder)return;
      for(const item of holder.querySelectorAll(':scope > Items > Item')){
        try{const beat=track.staves[staffIndex]?.bars[whole(item.getAttribute('bar'))]?.voices[whole(item.getAttribute('voice'))]?.beats[whole(item.getAttribute('beat'))],diagramNode=item.querySelector(':scope > Diagram');
        if(!beat||!diagramNode)throw new Error('Invalid GPIF scale diagram.');
        const diagram={
          name:diagramNode.querySelector(':scope > Name')?.textContent??'',strings:whole(diagramNode.getAttribute('strings')),frets:whole(diagramNode.getAttribute('frets')),firstFret:whole(diagramNode.getAttribute('firstFret')),
          orientation:diagramNode.getAttribute('orientation') as ScaleDiagram['orientation'],showFretMarkers:diagramNode.getAttribute('showFretMarkers')==='true',
          marks:[...diagramNode.querySelectorAll(':scope > Mark')].map(mark=>({
            string:whole(mark.getAttribute('string')),fret:whole(mark.getAttribute('fret')),shape:mark.getAttribute('shape') as ScaleMark['shape'],
            color:mark.getAttribute('color')??'',text:mark.querySelector(':scope > Text')?.textContent??'',textColor:mark.getAttribute('textColor')??'',
          })),
        };
        validateScaleDiagram(diagram);setScaleDiagram(beat,diagram);}catch(cause){console.warn(`Skipped a malformed scale diagram in the GP file: ${cause instanceof Error?cause.message:String(cause)}`);}
      }
    });
  });
}
