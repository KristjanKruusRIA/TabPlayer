// alphaTab 1.8.4 pairs an unnumbered tie stop with its start by pitch value, but
// under <transpose> it compares a transposed start with an untransposed stop, so
// no tie ever pairs. This numbers the ties of transposing parts in temporary
// loader text, pairing as alphaTab does without a transposition: the oldest open
// start of the same staff, voice, string and written pitch. Numbered ties take
// alphaTab's unaffected path.
const children=(node:Element,name?:string)=>[...node.children].filter(child=>!name||child.localName===name);
const child=(node:Element,name:string)=>children(node,name)[0];

function plan(doc:Document):Map<Element,number> {
  const result=new Map<Element,number>(),root=doc.documentElement;
  for(const part of children(root,'part')){
    const ties=[...part.getElementsByTagName('tied')];
    if(!ties.length||!part.getElementsByTagName('transpose').length)continue;
    // Existing numbers or continue ties: their pairing is the author's, not guessed.
    if(ties.some(tie=>tie.hasAttribute('number')||tie.getAttribute('type')==='continue'))continue;
    // Open starts in document order; alphaTab pairs a stop with the oldest matching one.
    const open:{key:string;level:number;tie:Element}[]=[],levels=new Map<Element,number>();
    for(const note of children(part,'measure').flatMap(measure=>children(measure,'note'))){
      const tieds=[...note.getElementsByTagName('tied')],pitch=child(note,'pitch');
      // alphaTab drops cue notes, and unpitched notes and rests keep stock handling.
      if(!tieds.length||!pitch||child(note,'cue'))continue;
      const technical=note.getElementsByTagName('string')[0]?.textContent?.trim()??'';
      const key=[child(note,'staff')?.textContent?.trim()||'1',child(note,'voice')?.textContent?.trim()||'1',technical,child(pitch,'step')?.textContent?.trim(),Number(child(pitch,'alter')?.textContent??0),child(pitch,'octave')?.textContent?.trim()].join('/');
      // A note may end one tie and start the next. A level its own stop frees stays
      // taken for its start, or alphaTab would pair the note with itself.
      const freed:number[]=[];
      for(const tie of tieds.filter(item=>item.getAttribute('type')==='stop')){
        const at=open.findIndex(entry=>entry.key===key);
        if(at<0){
          // An unpaired stop gets a number no open start holds, so alphaTab skips it
          // instead of guessing a start one transposition away.
          const used=new Set([...open.map(entry=>entry.level),...freed]);let level=1;while(used.has(level))level++;
          if(level<=16)levels.set(tie,level);
          continue;
        }
        const [entry]=open.splice(at,1);levels.set(tie,entry.level);freed.push(entry.level);
      }
      for(const tie of tieds.filter(item=>item.getAttribute('type')==='start')){
        const used=new Set([...open.map(entry=>entry.level),...freed]);
        let level=1;while(used.has(level))level++;
        if(level>16){
          // Too many unclosed starts: the oldest gives up its number and stays unnumbered.
          const [oldest]=open.splice(0,1);levels.delete(oldest.tie);level=oldest.level;
        }
        open.push({key,level,tie});levels.set(tie,level);
      }
    }
    levels.forEach((level,tie)=>result.set(tie,level));
  }
  return result;
}

export function numberTransposedTies(xml:string):string|null {
  if(!xml.includes('<transpose')||!xml.includes('<tied'))return null;
  const doc=new DOMParser().parseFromString(xml,'application/xml');
  if(doc.querySelector('parsererror')||doc.documentElement.localName!=='score-partwise')return null;
  const levels=plan(doc);if(!levels.size)return null;
  // Only the <tied> start tags change; every other character reaches the loader as authored.
  const elements=[...doc.getElementsByTagName('tied')],matches=[...xml.matchAll(/<tied(?=[\s/>])[^>]*?(\/?)>/g)];
  if(matches.length!==elements.length)return null;
  let result='',position=0;
  matches.forEach((match,index)=>{
    const level=levels.get(elements[index]);if(level===undefined)return;
    const end=match.index!+match[0].length-(match[1]?2:1);
    result+=xml.slice(position,end)+` number="${level}"`;position=end;
  });
  result+=xml.slice(position);
  // Comments and CDATA can hide tags from one side only; confirm on a fresh parse.
  const check=new DOMParser().parseFromString(result,'application/xml'),after=[...check.getElementsByTagName('tied')];
  if(check.querySelector('parsererror')||after.length!==elements.length)return null;
  return after.every((tie,index)=>tie.getAttribute('number')===(levels.has(elements[index])?String(levels.get(elements[index])):null))?result:null;
}
