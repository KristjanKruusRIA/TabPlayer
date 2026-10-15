export interface XmlSpan {start:number;end:number}
export interface GpifProjection {xml:string;tracks:XmlSpan}
interface Tag extends XmlSpan {name:string;closing:boolean;empty:boolean;raw:string}

/** Lexical offsets only; the public importer or DOM parser owns XML validation. */
function scan(xml:string,visit:(tag:Tag)=>void|false):boolean {
  let position=0;
  while((position=xml.indexOf('<',position))!==-1){
    let terminator:string|undefined;
    if(xml.startsWith('<!--',position))terminator='-->';
    else if(xml.startsWith('<![CDATA[',position))terminator=']]>';
    else if(xml.startsWith('<?',position))terminator='?>';
    if(terminator){const end=xml.indexOf(terminator,position+2);if(end<0)return false;position=end+terminator.length;continue;}
    if(xml.startsWith('<!',position))return false;
    let end=position+1,quote='';
    for(;end<xml.length;end++){
      const char=xml[end];
      if(quote){if(char===quote)quote='';}
      else if(char==='"'||char==="'")quote=char;
      else if(char==='>')break;
    }
    if(end===xml.length)return false;
    const raw=xml.slice(position,end+1),match=/^<\/?([\w:.-]+)/.exec(raw);
    if(!match||match[1].includes(':')||/\sxmlns(?::[\w.-]+)?\s*=/.test(raw))return false;
    if(visit({start:position,end:end+1,name:match[1],closing:raw[1]==='/',empty:/\/\s*>$/.test(raw),raw})===false)return true;
    position=end+1;
  }
  return true;
}

export function projectGpifTracks(xml:string):GpifProjection|undefined {
  let depth=0,masterStart=-1,tracksStart=-1,master:XmlSpan|undefined,tracks:XmlSpan|undefined;
  const supported=scan(xml,tag=>{
    if(tag.closing){
      depth--;
      if(depth===1&&tag.name==='MasterTrack')master={start:masterStart,end:tag.end};
      if(depth===1&&tag.name==='Tracks')tracks={start:tracksStart,end:tag.end};
    }else{
      if(depth===0&&tag.name!=='GPIF')return false;
      if(depth===1&&tag.name==='MasterTrack'){masterStart=tag.start;if(tag.empty)master=tag;}
      if(depth===1&&tag.name==='Tracks'){tracksStart=tag.start;if(tag.empty)tracks=tag;}
      if(!tag.empty)depth++;
    }
    if(master&&tracks)return false;
  });
  if(!supported||!master||!tracks)return undefined;
  return {xml:`<GPIF>${xml.slice(master.start,master.end)}${xml.slice(tracks.start,tracks.end)}</GPIF>`,tracks};
}

export function patchGpifNoteArticulations(xml:string,references:ReadonlyMap<number,number>):string|undefined {
  const stack:string[]=[],patches:(XmlSpan&{value:string})[]=[];
  let note:number|undefined,contentStart:number|undefined;
  const supported=scan(xml,tag=>{
    if(tag.closing){
      if(stack.length===4&&stack[1]==='Notes'&&stack[2]==='Note'&&tag.name==='InstrumentArticulation'&&contentStart!==undefined){
        patches.push({start:contentStart,end:tag.start,value:String(references.get(note!))});contentStart=undefined;
      }
      if(stack.length===3&&stack[1]==='Notes'&&tag.name==='Note')note=undefined;
      stack.pop();
    }else{
      if(stack.length===2&&stack[0]==='GPIF'&&stack[1]==='Notes'&&tag.name==='Note'){
        const attributes=tag.raw.matchAll(/([\w:.-]+)\s*=\s*(["'])(.*?)\2/gs);
        note=undefined;for(const attribute of attributes)if(attribute[1]==='id')note=Number(attribute[3]);
      }
      if(stack.length===3&&stack[1]==='Notes'&&stack[2]==='Note'&&tag.name==='InstrumentArticulation'&&references.has(note!)){
        if(tag.empty)patches.push({start:tag.start,end:tag.end,value:tag.raw.replace(/\/\s*>$/,`>${references.get(note!)}</InstrumentArticulation>`)});
        else contentStart=tag.end;
      }
      if(!tag.empty)stack.push(tag.name);
    }
  });
  if(!supported)return undefined;
  const chunks:string[]=[];let position=0;
  for(const patch of patches){chunks.push(xml.slice(position,patch.start),patch.value);position=patch.end;}
  chunks.push(xml.slice(position));return chunks.join('');
}
