import { model } from '@coderline/alphatab';

const inversionId='1124204545';
function textElement(doc:Document,name:string,value:string) {
  const element=doc.createElement(name);element.textContent=value;return element;
}
function gcd(a:number,b:number):number {while(b){const rest=a%b;a=b;b=rest;}return Math.abs(a);}
/** Repairs two demonstrated public-writer omissions using standard GPIF fields. */
export function writeGpifNotation(score:model.Score,doc:Document):void {
  const beats=new Map<number,model.Beat>();
  for(const track of score.tracks)for(const staff of track.staves)for(const bar of staff.bars)for(const voice of bar.voices)for(const beat of voice.beats)beats.set(beat.id,beat);
  for(const node of doc.querySelectorAll('GPIF > Beats > Beat')){
    const id=node.getAttribute('id'),beat=id===null?undefined:beats.get(Number(id));if(!beat)continue;
    const containers=[...node.children].filter(child=>child.localName==='XProperties');
    for(const container of containers)for(const property of [...container.children])if(property.localName==='XProperty'&&property.getAttribute('id')===inversionId)property.remove();
    if(beat.invertBeamDirection){
      const properties=containers[0]??doc.createElement('XProperties');if(!properties.parentNode)node.append(properties);
      const property=doc.createElement('XProperty');property.setAttribute('id',inversionId);property.append(textElement(doc,'Int','1'));properties.append(property);
    }
  }
  [...doc.querySelectorAll('GPIF > MasterBars > MasterBar')].forEach((node,index)=>{
    const master=score.masterBars[index];if(!master)return;
    const previous=[...node.children].filter(child=>child.localName==='Fermatas');
    if(!master.fermata?.size){for(const child of previous)child.remove();return;}
    const fermatas=doc.createElement('Fermatas');
    for(const [offset,fermata]of [...master.fermata].sort(([a],[b])=>a-b)){
      const divisor=gcd(offset,960),entry=doc.createElement('Fermata');
      entry.append(textElement(doc,'Type',model.FermataType[fermata.type]),textElement(doc,'Length',String(fermata.length)),textElement(doc,'Offset',`${offset/divisor}/${960/divisor}`));fermatas.append(entry);
    }
    if(previous.length){previous[0].replaceWith(fermatas);for(const child of previous.slice(1))child.remove();}else node.append(fermatas);
  });
}

