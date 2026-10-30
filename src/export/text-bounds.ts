import type { SvgSystem } from './types';

/** A drawn text's horizontal extent, in system pixels from the system's left edge. */
export interface TextBox { text:string;left:number;right:number }

/** The texts that start left of the system or end beyond `width`, which the page margins would clip. */
export function overflowingText(boxes:readonly TextBox[],width:number,tolerance=1):string[] {
  return boxes.filter(box=>box.left<-tolerance||box.right>width+tolerance).map(box=>box.text);
}

/**
 * Every visible text of one rendered system, measured with the fonts the webview has loaded. Returns nothing where
 * nothing is laid out (no document, or an environment that reports empty boxes).
 */
export function measureSystemText(system:SvgSystem):TextBox[] {
  if(typeof document==='undefined')return [];
  const host=document.createElement('div');host.style.cssText='position:absolute;left:-100000px;top:0;visibility:hidden';host.innerHTML=system.svg;document.body.append(host);
  try{
    const svg=host.querySelector('svg');if(!svg)return [];
    const frame=svg.getBoundingClientRect(),scale=frame.width>0?system.width/frame.width:1;
    return [...svg.querySelectorAll('text')].flatMap(node=>{
      const text=node.textContent?.trim()??'',box=node.getBoundingClientRect();
      // Music symbols are private-use glyphs of the music font, not text; their boxes may touch the system edge.
      return text&&!/^[-]+$/u.test(text)&&box.width>0?[{text,left:(box.left-frame.left)*scale,right:(box.right-frame.left)*scale}]:[];
    });
  }finally{host.remove();}
}

/**
 * Refuses an export whose text would be clipped. The exporter only checks that bars fit, but enlarged annotations,
 * chord names and track names can run past the last bar. Refusing names the text and the settings that cause it.
 */
export function assertTextFits(systems:readonly SvgSystem[],width:number,measure:(system:SvgSystem)=>TextBox[]=measureSystemText):void {
  for(const system of systems){
    const [first]=overflowingText(measure(system),width);
    if(first!==undefined)throw new Error(`The text "${first.length>30?`${first.slice(0,29)}…`:first}" does not fit the page width. Reduce Text size or Tab number size, or the print scale, or use a wider page.`);
  }
}
