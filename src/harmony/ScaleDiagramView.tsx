import type { ScaleDiagram,ScaleMark } from './scale-diagram';

export interface ScaleDiagramViewProps {
  diagram:ScaleDiagram;selected?:{string:number;fret:number}|null;
  /** When set, every cell is a button; a click on an empty cell adds a mark and a click on a mark selects it. */
  onCell?:(string:number,fret:number)=>void;
  /** Double-click (as in Guitar Pro) removes the mark. */
  onRemove?:(string:number,fret:number)=>void;
}
const cell=34,margin=30;
const markers=new Set([3,5,7,9,15,17,19,21]);
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
const label=(diagram:ScaleDiagram,string:number,fret:number,mark:ScaleMark|undefined)=>
  `String ${string}, ${fret===0?'open':`fret ${fret}`}${mark?`: ${mark.shape} mark${mark.text?` "${mark.text}"`:''}`:''}`;
/** The scale diagram as the score shows it: strings and frets, then each mark with its shape, colour and text. */
export function ScaleDiagramView({diagram,selected=null,onCell,onRemove}:ScaleDiagramViewProps) {
  const horizontal=diagram.orientation==='horizontal',columns=diagram.frets+1,strings=diagram.strings;
  // Position along the neck (0 is the open column) and across it (string 1, the highest, is at the top or at the right).
  const along=(fret:number)=>fret===0?0:fret-diagram.firstFret+1,across=(string:number)=>horizontal?string-1:strings-string;
  const point=(string:number,fret:number)=>{
    const a=margin+along(fret)*cell+cell/2,c=margin+across(string)*cell+cell/2;return horizontal?{x:a,y:c}:{x:c,y:a};
  };
  const width=margin*2+(horizontal?columns:strings)*cell,height=margin*2+(horizontal?strings:columns)*cell;
  const frets=Array.from({length:diagram.frets},(_,i)=>diagram.firstFret+i);
  return <svg role="group" aria-label={`Scale diagram${diagram.name?` ${diagram.name}`:''}`} viewBox={`0 0 ${width} ${height}`} style={{width:'100%',maxWidth:horizontal?640:360,background:'#fffdf8',color:'#161c24',borderRadius:6}}>
    <title>{`${diagram.name||'Scale diagram'}: ${diagram.marks.length} marks, frets ${diagram.firstFret} to ${diagram.firstFret+diagram.frets-1}`}</title>
    {Array.from({length:strings},(_,i)=>i+1).map(string=>{
      const c=margin+across(string)*cell+cell/2,end=margin+columns*cell,weight=1+(horizontal?string-1:strings-string)*.15;
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
      return <g key={`${string}/${fret}`} role={onCell?'button':'img'} tabIndex={onCell?0:undefined} aria-label={label(diagram,string,fret,mark)} aria-pressed={onCell&&mark?active:undefined}
        onClick={onCell?()=>onCell(string,fret):undefined} onDoubleClick={onRemove&&mark?()=>onRemove(string,fret):undefined}
        onKeyDown={onCell?event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();onCell(string,fret);}else if((event.key==='Delete'||event.key==='Backspace')&&mark&&onRemove){event.preventDefault();onRemove(string,fret);}}:undefined}
        style={{cursor:onCell?'pointer':undefined}}>
        <rect x={x-cell/2} y={y-cell/2} width={cell} height={cell} fill="transparent"/>
        {mark&&<><Shape mark={mark} x={x} y={y}/>{mark.text&&<text x={x} y={y+3.5} textAnchor="middle" fill={mark.textColor} fontSize={mark.text.length>2?8:10} fontWeight={600} aria-hidden="true">{mark.text}</text>}</>}
        {active&&<rect x={x-cell/2+3} y={y-cell/2+3} width={cell-6} height={cell-6} fill="none" stroke="#161c24" strokeWidth={2} strokeDasharray="3 2"/>}
      </g>;}))}
  </svg>;
}
