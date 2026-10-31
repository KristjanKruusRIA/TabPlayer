import { useRef,useState,type KeyboardEvent } from 'react';
import type { ScaleDiagram,ScaleMark } from './scale-diagram';

export interface ScaleDiagramViewProps {
  diagram:ScaleDiagram;selected?:{string:number;fret:number}|null;
  /** When set, the positions form one grid with a single tab stop and arrow-key navigation; Enter or Space adds or selects a mark. */
  onCell?:(string:number,fret:number)=>void;
  /** Double-click (as in Guitar Pro) or Delete removes the mark. */
  onRemove?:(string:number,fret:number)=>void;
}
const cell=34,margin=30;
const markers=new Set([3,5,7,9,15,17,19,21]);
/** The drawing's natural size, so the score can scale it. */
export const scaleDiagramSize=(diagram:ScaleDiagram)=>{
  const along=(diagram.frets+1)*cell+margin*2,across=diagram.strings*cell+margin*2;
  return diagram.orientation==='horizontal'?{width:along,height:across}:{width:across,height:along};
};
function Shape({mark,x,y}:{mark:ScaleMark;x:number;y:number}) {
  const r=11;
  switch(mark.shape) {
    case 'square': return <rect x={x-r} y={y-r} width={2*r} height={2*r} fill={mark.color}/>;
    case 'diamond': return <polygon points={`${x},${y-r-1} ${x+r+1},${y} ${x},${y+r+1} ${x-r-1},${y}`} fill={mark.color}/>;
    case 'triangle': return <polygon points={`${x},${y-r} ${x+r+1},${y+r-1} ${x-r-1},${y+r-1}`} fill={mark.color}/>;
    case 'cross': return <path d={`M${x-r+2},${y-r+2} L${x+r-2},${y+r-2} M${x+r-2},${y-r+2} L${x-r+2},${y+r-2}`} stroke={mark.color} strokeWidth={4} strokeLinecap="round"/>;
    default: return <circle cx={x} cy={y} r={r} fill={mark.color}/>;
  }
}
const label=(string:number,fret:number,mark:ScaleMark|undefined)=>
  `String ${string}, ${fret===0?'open':`fret ${fret}`}${mark?`: ${mark.shape} mark${mark.text?` "${mark.text}"`:''}`:''}`;
/**
 * The scale diagram as the score shows it: strings and frets, then each mark with its shape, colour and text.
 * String 1 is the lowest string, as for notes: the bottom row when horizontal, the left column when vertical.
 */
export function ScaleDiagramView({diagram,selected=null,onCell,onRemove}:ScaleDiagramViewProps) {
  const horizontal=diagram.orientation==='horizontal',columns=diagram.frets+1,strings=diagram.strings;
  const along=(fret:number)=>fret===0?0:fret-diagram.firstFret+1,across=(string:number)=>horizontal?strings-string:string-1;
  const point=(string:number,fret:number)=>{
    const a=margin+along(fret)*cell+cell/2,c=margin+across(string)*cell+cell/2;return horizontal?{x:a,y:c}:{x:c,y:a};
  };
  const size=scaleDiagramSize(diagram),frets=Array.from({length:diagram.frets},(_,i)=>diagram.firstFret+i),svg=useRef<SVGSVGElement>(null);
  const [current,setCurrent]=useState<{string:number;fret:number}|null>(null);
  const inside=(at:{string:number;fret:number}|null)=>!!at&&at.string>=1&&at.string<=strings&&(at.fret===0||(at.fret>=diagram.firstFret&&at.fret<diagram.firstFret+diagram.frets));
  const stop=inside(current)?current!:inside(selected)?selected!:{string:strings,fret:0};
  function move(event:KeyboardEvent,string:number,fret:number) {
    // Arrows follow the picture: along the neck is left/right when horizontal and up/down when vertical.
    const step=(dAlong:number,dAcross:number)=>{
      const columnsList=[0,...frets],at=columnsList.indexOf(fret)+dAlong,nextString=string+dAcross;
      if(at<0||at>=columnsList.length||nextString<1||nextString>strings)return;
      event.preventDefault();setCurrent({string:nextString,fret:columnsList[at]});svg.current?.querySelector<SVGElement>(`[data-cell="${nextString}/${columnsList[at]}"]`)?.focus();
    };
    const keys:Record<string,[number,number]>=horizontal?{ArrowRight:[1,0],ArrowLeft:[-1,0],ArrowUp:[0,1],ArrowDown:[0,-1]}:{ArrowDown:[1,0],ArrowUp:[-1,0],ArrowRight:[0,1],ArrowLeft:[0,-1]};
    const found=keys[event.key];if(found)step(found[0],found[1]);
  }
  return <svg ref={svg} role="group" aria-label={`Scale diagram${diagram.name?` ${diagram.name}`:''}`} viewBox={`0 0 ${size.width} ${size.height}`} style={{width:'100%',maxWidth:horizontal?640:360,background:'#fffdf8',color:'#161c24',borderRadius:6}}>
    <title>{`${diagram.name||'Scale diagram'}: ${diagram.marks.length} marks, frets ${diagram.firstFret} to ${diagram.firstFret+diagram.frets-1}`}</title>
    {Array.from({length:strings},(_,i)=>i+1).map(string=>{
      const c=margin+across(string)*cell+cell/2,end=margin+columns*cell,weight=1+(strings-string)*.15;
      return horizontal?<line key={string} x1={margin} y1={c} x2={end} y2={c} stroke="#465363" strokeWidth={weight}/>:<line key={string} x1={c} y1={margin} x2={c} y2={end} stroke="#465363" strokeWidth={weight}/>;})}
    {[...frets,diagram.firstFret+diagram.frets].map(fret=>{
      const edge=margin+(fret-diagram.firstFret+1)*cell,span=margin+strings*cell,nut=fret===diagram.firstFret&&diagram.firstFret===1,mid=edge+cell/2,end=fret===diagram.firstFret+diagram.frets,center=margin+span/2-margin/2;
      return <g key={fret}>
        {horizontal?<line x1={edge} y1={margin} x2={edge} y2={span} stroke={nut?'#161c24':'#97a6b6'} strokeWidth={nut?4:1}/>:<line x1={margin} y1={edge} x2={span} y2={edge} stroke={nut?'#161c24':'#97a6b6'} strokeWidth={nut?4:1}/>}
        {!end&&<text x={horizontal?mid:margin-8} y={horizontal?margin-10:mid+4} fill="#465363" fontSize={10} textAnchor="middle">{fret}</text>}
        {!end&&diagram.showFretMarkers&&markers.has(fret%12===0?12:fret)&&<circle cx={horizontal?mid:center} cy={horizontal?center:mid} r={3} fill="#c8d0da" aria-hidden="true"/>}
      </g>;})}
    {Array.from({length:strings},(_,i)=>i+1).flatMap(string=>[0,...frets].map(fret=>{
      const mark=diagram.marks.find(item=>item.string===string&&item.fret===fret),{x,y}=point(string,fret),active=selected?.string===string&&selected.fret===fret;
      if(!mark&&!onCell)return null;
      const isStop=stop.string===string&&stop.fret===fret;
      return <g key={`${string}/${fret}`} data-cell={`${string}/${fret}`} role={onCell?'button':'img'} tabIndex={onCell?(isStop?0:-1):undefined} aria-label={label(string,fret,mark)} aria-pressed={onCell&&mark?active:undefined}
        onClick={onCell?()=>{setCurrent({string,fret});onCell(string,fret);}:undefined} onFocus={onCell?()=>setCurrent({string,fret}):undefined} onDoubleClick={onRemove&&mark?()=>onRemove(string,fret):undefined}
        onKeyDown={onCell?event=>{
          if(event.key==='Enter'||event.key===' '){event.preventDefault();onCell(string,fret);}
          else if((event.key==='Delete'||event.key==='Backspace')&&mark&&onRemove){event.preventDefault();onRemove(string,fret);}
          else move(event,string,fret);
        }:undefined}
        style={{cursor:onCell?'pointer':undefined}}>
        <rect x={x-cell/2} y={y-cell/2} width={cell} height={cell} fill="transparent"/>
        {mark&&<><Shape mark={mark} x={x} y={y}/>{mark.text&&<text x={x} y={y+3.5} textAnchor="middle" fill={mark.textColor} fontSize={mark.text.length>2?8:10} fontWeight={600} aria-hidden="true">{mark.text}</text>}</>}
        {active&&<rect x={x-cell/2+3} y={y-cell/2+3} width={cell-6} height={cell-6} fill="none" stroke="#161c24" strokeWidth={2} strokeDasharray="3 2"/>}
      </g>;}))}
  </svg>;
}
