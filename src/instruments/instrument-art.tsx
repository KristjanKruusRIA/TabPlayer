import { memo, useId } from 'react';
import { formatPitch } from '../tuning';

/**
 * The instruments' hardware, drawn once. Each drawing here is a memoised component of plain, primitive props, so React never
 * touches it while notes light and go out during playback; the views draw only the highlights, entry targets and labels that
 * change in a separate layer on top. Nothing here uses an SVG filter: depth comes from gradients and patterns, which the
 * browser rasterises once with the layer and does not repaint for a highlight.
 */
const uid=(raw:string)=>raw.replace(/[^a-zA-Z0-9]/g,'_');

export interface NeckGeometry {
  left:number;neckLength:number;height:number;neckHeight:number;row:number;top:number;body:number;width:number;
  boundary:(fret:number)=>number;position:(fret:number)=>number;
}
/** Where everything on the neck goes, from how many strings it has and how far it runs. Both layers use it, so they always agree. */
export function neckGeometry(strings:number,mode:'guitar'|'bass',maxFret:number):NeckGeometry {
  const left=64,neckLength=770,height=226;
  const neckHeight=Math.max(55,mode==='bass'?65+(strings-4)*10:65+(strings-6)*6),row=(neckHeight-26)/Math.max(1,strings-1);
  const top=(height-(strings-1)*row)/2,body=left+neckLength-6,width=body+254;
  const boundary=(fret:number)=>left+neckLength*(1-2**(-fret/12))/(1-2**(-maxFret/12));
  const position=(fret:number)=>fret===0?left-17:(boundary(fret-1)+boundary(fret))/2;
  return {left,neckLength,height,neckHeight,row,top,body,width,boundary,position};
}

interface FretboardArtProps {strings:number;/** Open pitches, string 1 first, as the names under the strings. */openKeys:string;mode:'guitar'|'bass';leftHanded:boolean;maxFret:number}
function FretboardArtBase({strings,openKeys,mode,leftHanded,maxFret}:FretboardArtProps) {
  const id=uid(useId()),{left,neckLength,height,neckHeight,row,top,body,width,boundary,position}=neckGeometry(strings,mode,maxFret);
  const names=openKeys.split(',');
  const wood=`url(#${id}-wood)`,metal=`url(#${id}-metal)`,cream=`url(#${id}-cream)`,pearl=`url(#${id}-pearl)`;
  const y0=top-12,y1=top+neckHeight-14,wound=Math.ceil(strings/2);
  return <>
    <defs>
      <linearGradient id={`${id}-wood`} x1="0" y1="0" x2="0" y2="1"><stop stopColor="#1f0f09"/><stop offset=".16" stopColor="#5b2f1d"/><stop offset=".5" stopColor="#7a442c"/><stop offset=".84" stopColor="#4a2415"/><stop offset="1" stopColor="#1c110b"/></linearGradient>
      <linearGradient id={`${id}-maple`} x1="0" y1="0" x2="0" y2="1"><stop stopColor="#a87a45"/><stop offset=".5" stopColor="#d8b27a"/><stop offset="1" stopColor="#8a5e32"/></linearGradient>
      <linearGradient id={`${id}-metal`} x1="0" y1="0" x2="1" y2="0"><stop stopColor="#52565a"/><stop offset=".3" stopColor="#e5e7e9"/><stop offset=".55" stopColor="#b6bec3"/><stop offset=".7" stopColor="#f7f8f6"/><stop offset="1" stopColor="#676c71"/></linearGradient>
      <linearGradient id={`${id}-cream`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#a19d8e"/><stop offset=".1" stopColor="#fffbed"/><stop offset=".46" stopColor="#e1dac3"/><stop offset=".74" stopColor="#fffbed"/><stop offset="1" stopColor="#ada898"/></linearGradient>
      <linearGradient id={`${id}-string`} x1="0" y1="0" x2="0" y2="1"><stop stopColor="#c7c3b8"/><stop offset=".45" stopColor="#fffefa"/><stop offset="1" stopColor="#686965"/></linearGradient>
      <linearGradient id={`${id}-wound`} x1="0" y1="0" x2="0" y2="1"><stop stopColor="#6d5a36"/><stop offset=".4" stopColor="#f0d89a"/><stop offset="1" stopColor="#4f3f22"/></linearGradient>
      <radialGradient id={`${id}-pearl`} cx=".35" cy=".3" r=".8"><stop stopColor="#fffdf3"/><stop offset=".6" stopColor="#e6dfc8"/><stop offset="1" stopColor="#a9a08a"/></radialGradient>
      <linearGradient id={`${id}-nut`} x1="0" y1="0" x2="1" y2="0"><stop stopColor="#bfb59c"/><stop offset=".4" stopColor="#fff9e6"/><stop offset="1" stopColor="#a69d86"/></linearGradient>
      <pattern id={`${id}-grain`} patternUnits="userSpaceOnUse" width="190" height="24"><path d="M0 2C48 7 120-2 190 4M0 9C55 1 116 19 190 11M0 16C84 8 109 25 190 16M0 23C74 29 105 12 190 22" fill="none" stroke="#1c0a03" strokeWidth=".7" opacity=".4"/><path d="M0 6C70 15 120 4 190 8M0 20C40 12 125 27 190 21" fill="none" stroke="#d5a875" strokeWidth=".6" opacity=".25"/><path d="M0 12C60 10 140 15 190 12M0 4C80 6 130 1 190 3" fill="none" stroke="#000" strokeWidth=".4" opacity=".25"/></pattern>
      <pattern id={`${id}-maplegrain`} patternUnits="userSpaceOnUse" width="120" height="12"><path d="M0 3C30 5 70 1 120 4M0 9C40 7 80 11 120 8" fill="none" stroke="#7a4f27" strokeWidth=".6" opacity=".45"/></pattern>
      <pattern id={`${id}-tortoise`} patternUnits="userSpaceOnUse" width="19" height="23"><rect width="19" height="23" fill="#281510"/><path d="M1 4L8 1 11 8 6 11ZM8 15L15 10 19 17 13 22Z" fill="#853c21"/><path d="M3 14L7 12 9 19 4 21ZM11 2L18 4 16 9 12 7Z" fill="#b56636" opacity=".6"/></pattern>
    </defs>
    <g data-mirror={leftHanded?'left':'right'} transform={leftHanded?`matrix(-1 0 0 1 ${width} 0)`:undefined}>
      <ellipse cx={body+113} cy="209" rx="119" ry="12" fill="#000" opacity=".35"/>
      <g data-instrument-part="body" transform={`translate(${body},113)`}>
        <path d="M7-45C29-42 17-79 37-89C72-113 112-91 150-83C184-97 213-93 231-70C249-47 248-19 235 4C253 39 247 75 225 96C194 122 151 104 113 108C66 114 14 102-2 70C-20 42 31 22 43 2C57-24 31-24 7-45Z" fill={cream} stroke="#827c6f" strokeWidth="2"/>
        <path d="M11-44C31-45 22-76 40-86M26 93C76 114 135 98 172 106C200 110 220 95 230 79" fill="none" stroke="#fffbed" strokeWidth="2.5" opacity=".65"/>
        <path d="M17-43C39-40 38-16 55-12L167-24C190-4 194 20 184 46L154 78L58 83C24 75 35 47 55 29C78 9 43-10 17-43Z" fill={`url(#${id}-tortoise)`} stroke="#d0c9b7" strokeWidth="2"/>
        {[[-0,-40],[174,-12],[183,40],[147,78],[56,76]].map(([x,y],index)=><g key={index}><circle cx={x} cy={y} r="2.3" fill={metal}/><path d={`M${x-1.5} ${y}h3`} stroke="#53504a" strokeWidth=".6"/></g>)}
        {[0,1].map(index=><g key={index} transform={`translate(${173+index*21},${58-index*24})`}><circle r="10" fill={cream} stroke="#857f72"/><circle r="6" fill="#eee8d7" stroke="#d4cbb8"/><path d="M0-8V-4" stroke="#5d625f" strokeWidth="1.3"/></g>)}
        <path d="M200 38L218 30Q230 40 224 51L207 57Z" fill={metal} stroke="#62676a"/><ellipse cx="216" cy="42" rx="4" ry="6" fill="#252b2b"/>
      </g>
      <g data-instrument-part="headstock">
        <path d={`M3 ${y0-5}Q3 ${y0-9} 8 ${y0-8}L${left-3} ${y0}V${y1}L8 ${y1+8}Q3 ${y1+9} 3 ${y1+5}Z`} fill={`url(#${id}-maple)`} stroke="#51412f" strokeWidth="1.2"/>
        <path d={`M3 ${y0-5}Q3 ${y0-9} 8 ${y0-8}L${left-3} ${y0}V${y1}L8 ${y1+8}Q3 ${y1+9} 3 ${y1+5}Z`} fill={`url(#${id}-maplegrain)`}/>
        {Array.from({length:strings},(_,index)=>{const y=top+index*row;return <g key={index}><circle cx={left-31} cy={y} r="4" fill={metal} stroke="#4a4a43" strokeWidth=".8"/><circle cx={left-31} cy={y} r="1.5" fill="#2b2f2d"/></g>;})}
      </g>
      <g data-instrument-part="neck"><rect x={left} y={top-15} width={neckLength+34} height={neckHeight+4} rx="2" fill="#b69c73" stroke="#51412f"/><rect x={left} y={top-12} width={neckLength+34} height={neckHeight-2} fill={wood}/><rect x={left} y={top-12} width={neckLength+34} height={neckHeight-2} fill={`url(#${id}-grain)`}/><path d={`M${left} ${top-12}H${body+34}M${left} ${top+neckHeight-14}H${body+34}`} stroke="#ba8d68" strokeWidth="1" opacity=".6"/><path d={`M${left} ${top-10}H${body+34}`} stroke="#fff" strokeWidth="1" opacity=".08"/></g>
      <g data-instrument-part="nut"><rect x={left-4} y={top-13} width="7" height={neckHeight} rx="1.4" fill={`url(#${id}-nut)`} stroke="#6d6552" strokeWidth=".8"/>{Array.from({length:strings},(_,index)=><path key={index} d={`M${left-3} ${top+index*row}h5`} stroke="#3a3326" strokeWidth=".9"/>)}</g>
      {Array.from({length:maxFret+1},(_,fret)=><g key={fret} data-fret-column={fret}><line data-fret-boundary={fret} x1={boundary(fret)} x2={boundary(fret)} y1={top-12} y2={top+neckHeight-14} stroke={fret===0?'#e8dcc5':'#131711'} strokeWidth={fret===0?5:3}/>{fret>0?<><rect x={boundary(fret)-1} y={top-12} width="2" height={neckHeight-2} fill={metal}/><path d={`M${boundary(fret)-.4} ${top-12}V${top+neckHeight-14}`} stroke="#fff" strokeWidth=".5" opacity=".7"/></>:null}</g>)}
      {[3,5,7,9,12,15,17,19,21,24].filter(fret=>fret<=maxFret).flatMap(fret=>(fret%12===0?[-neckHeight*.2,neckHeight*.2]:[0]).map((offset,index)=><g key={`${fret}/${index}`}><circle cx={position(fret)+.8} cy={height/2+offset+1} r="3.9" fill="#000" opacity=".35"/><circle cx={position(fret)} cy={height/2+offset} r="3.7" fill={pearl} stroke="#a79e86" strokeWidth=".7"/></g>))}
      <g data-instrument-part="bridge"><rect x={body+144} y={top-11} width="36" height={neckHeight-4} rx="3" fill={metal} stroke="#4a4a43"/>{Array.from({length:strings},(_,index)=><g key={index}><rect x={body+147} y={top+index*row-5} width="25" height="10" rx="2" fill={metal} stroke="#6a6c66"/><circle cx={body+176} cy={top+index*row} r="2" fill="#343933"/></g>)}</g>
      {[40,91].map((offset,pickup)=><g key={offset} data-instrument-part={pickup===0?'neck-pickup':'bridge-pickup'}><rect x={body+offset-9} y={top-11} width="19" height={neckHeight-4} rx="8" fill="#eee7d2" stroke="#7e7a6e"/>{Array.from({length:strings},(_,index)=><circle data-pickup-string={strings-index} key={index} cx={body+offset} cy={top+index*row} r="2.5" fill={metal} stroke="#5c5b56" strokeWidth=".7"/>)}</g>)}
      {Array.from({length:strings},(_,index)=>{
        const string=strings-index,y=top+index*row,thickness=.7+index*.16,isWound=index>=wound;
        return <g key={string} data-string-row={string}><title>{`String ${string} · ${names[index]??''}`}</title>
          <line x1={left-31} x2={body+176} y1={y+1.4} y2={y+1.4} stroke="#160e08" opacity=".6" strokeWidth={1+index*.17}/>
          <rect x={left-31} y={y-thickness/2} width={body+207-left} height={thickness} fill={`url(#${id}-${isWound?'wound':'string'})`}/>
          {isWound?<line x1={left-31} x2={body+176} y1={y} y2={y} stroke="#2b2110" strokeWidth={Math.max(.5,thickness*.85)} strokeDasharray={`.5 ${(.9+index*.04).toFixed(2)}`} opacity=".75"/>:null}
        </g>;
      })}
    </g>
    <g className="fret-numbers">{Array.from({length:maxFret+1},(_,fret)=><text key={fret} className="fret-number" data-fret-number={fret} x={leftHanded?width-position(fret):position(fret)} y={top-22} textAnchor="middle">{fret===0?'OPEN':fret}</text>)}</g>
  </>;
}
export const FretboardArt=memo(FretboardArtBase);

/** A keyboard's keys from `low` to `high`, white keys 28 wide: ivory with a lip and a gloss, ebony with a bevel, under a felt strip. */
function KeyboardArtBase({low,high}:{low:number;high:number}) {
  const id=uid(useId()),blackKeys=new Set([1,3,6,8,10]),keyWidth=28;
  const white:{key:number;x:number}[]=[],black:{key:number;x:number}[]=[];
  for(let key=low;key<=high;key++){if(blackKeys.has(key%12))black.push({key,x:white.length*keyWidth-8});else white.push({key,x:white.length*keyWidth});}
  const total=white.length*keyWidth;
  return <>
    <defs>
      <linearGradient id={`${id}-ivory`} x1="0" y1="0" x2="0" y2="1"><stop stopColor="#a9a89d"/><stop offset=".1" stopColor="#fffef7"/><stop offset=".8" stopColor="#f0eddf"/><stop offset=".93" stopColor="#d9d5c4"/><stop offset="1" stopColor="#9d9a8b"/></linearGradient>
      <linearGradient id={`${id}-side`} x1="0" y1="0" x2="1" y2="0"><stop stopColor="#000" stopOpacity=".16"/><stop offset=".14" stopColor="#000" stopOpacity="0"/><stop offset=".86" stopColor="#000" stopOpacity="0"/><stop offset="1" stopColor="#000" stopOpacity=".22"/></linearGradient>
      <linearGradient id={`${id}-ebony`} x1="0" y1="0" x2=".7" y2="1"><stop stopColor="#0d1114"/><stop offset=".3" stopColor="#42494e"/><stop offset=".78" stopColor="#1d2226"/><stop offset="1" stopColor="#07090a"/></linearGradient>
      <linearGradient id={`${id}-felt`} x1="0" y1="0" x2="0" y2="1"><stop stopColor="#5a1217"/><stop offset="1" stopColor="#2b0709"/></linearGradient>
      <linearGradient id={`${id}-shadow`} x1="0" y1="0" x2="0" y2="1"><stop stopColor="#000" stopOpacity=".5"/><stop offset="1" stopColor="#000" stopOpacity="0"/></linearGradient>
    </defs>
    <rect width={total} height="125" rx="4" fill="#090e12"/>
    <rect x="0" y="0" width={total} height="9" fill="#1b2227"/><path d={`M0 5H${total}`} stroke="#4d5459" strokeWidth="2"/><rect x="0" y="9" width={total} height="3" fill={`url(#${id}-felt)`}/>
    {white.map(({key,x})=><g key={key} data-key-art={key}>
      <rect x={x+1} y="9" width={keyWidth-2} height="110" rx="3" fill={`url(#${id}-ivory)`}/><rect x={x+1} y="9" width={keyWidth-2} height="110" rx="3" fill={`url(#${id}-side)`}/>
      <rect x={x+1} y="12" width={keyWidth-2} height="24" fill={`url(#${id}-shadow)`} opacity=".5"/>
      <path d={`M${x+3} 113H${x+keyWidth-3}`} stroke="#fffff8" strokeWidth="2" opacity=".7"/><path d={`M${x+2} 118H${x+keyWidth-2}`} stroke="#7e7b6e" strokeWidth="1.2" opacity=".6"/>
      {key%12===0?<text className="piano-c" x={x+keyWidth/2} y="107" textAnchor="middle">{formatPitch(key)}</text>:null}
    </g>)}
    {black.map(({key,x})=><g key={key} data-key-art={key}>
      <rect x={x+1} y="12" width="16" height="69" rx="3" fill="#000" opacity=".35"/>
      <rect x={x} y="8" width="16" height="69" rx="3" fill={`url(#${id}-ebony)`}/>
      <path d={`M${x+2} 11V67M${x+3} 73H${x+13}`} stroke="#6b7377" strokeWidth=".8"/><rect x={x+3} y="12" width="3" height="54" rx="1.5" fill="#fff" opacity=".09"/>
    </g>)}
  </>;
}
export const KeyboardArt=memo(KeyboardArtBase);

export interface DrumPiece {id:string;label:string;keys:number[];x:number;y:number;r:number}
export const cymbalIds=['hi-hat','crash','ride','china','splash'];
export const shellHeightOf=(piece:DrumPiece)=>piece.id==='floor-tom'?55:piece.id==='snare'?20:32;
/** The kit: stands, shells in a pearl wrap with lugs and hoops, calf-white heads and lathed cymbals. */
function DrumsArtBase({pieces}:{pieces:readonly DrumPiece[]}) {
  const id=uid(useId());
  return <>
    <defs>
      <linearGradient id={`${id}-shell`}><stop stopColor="#4e090d"/><stop offset=".18" stopColor="#b5202b"/><stop offset=".43" stopColor="#e34240"/><stop offset=".64" stopColor="#9a1621"/><stop offset="1" stopColor="#3d090d"/></linearGradient>
      <pattern id={`${id}-wrap`} patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(35)"><path d="M0 0H6" stroke="#fff" strokeWidth=".7" opacity=".1"/><path d="M0 3H6" stroke="#000" strokeWidth=".8" opacity=".14"/></pattern>
      <radialGradient id={`${id}-head`} cx=".42" cy=".25" r=".8"><stop stopColor="#fffdf3"/><stop offset=".65" stopColor="#e0e0d6"/><stop offset="1" stopColor="#a8aca6"/></radialGradient>
      <radialGradient id={`${id}-brass`} cx=".47" cy=".35" r=".62"><stop stopColor="#fff6cd"/><stop offset=".13" stopColor="#b49b5f"/><stop offset=".37" stopColor="#e0c37d"/><stop offset=".63" stopColor="#a78a45"/><stop offset=".82" stopColor="#e6cc8c"/><stop offset="1" stopColor="#76602d"/></radialGradient>
      <linearGradient id={`${id}-chrome`}><stop stopColor="#545a5f"/><stop offset=".35" stopColor="#f4f5ef"/><stop offset=".55" stopColor="#8e999e"/><stop offset=".8" stopColor="#e0e5e4"/><stop offset="1" stopColor="#444c50"/></linearGradient>
      <radialGradient id={`${id}-floor`}><stop stopColor="#000" stopOpacity=".5"/><stop offset="1" stopColor="#000" stopOpacity="0"/></radialGradient>
    </defs>
    <ellipse cx="431" cy="217" rx="320" ry="20" fill={`url(#${id}-floor)`}/>
    <g className="kit-stands">{pieces.filter(piece=>cymbalIds.includes(piece.id)).map(piece=><g key={piece.id}><path d={`M${piece.x} ${piece.y}V213M${piece.x} 186L${piece.x-25} 222M${piece.x} 186L${piece.x+27} 223M${piece.x} 186L${piece.x+3} 226`} fill="none" stroke="#48535a" strokeWidth="5"/><path d={`M${piece.x} ${piece.y}V213M${piece.x} 186L${piece.x-25} 222M${piece.x} 186L${piece.x+27} 223M${piece.x} 186L${piece.x+3} 226`} fill="none" stroke="#b7c0c3" strokeWidth="2"/><circle cx={piece.x} cy="167" r="3" fill="#e4e7e4"/></g>)}</g>
    {[...pieces].sort((a,b)=>a.y-b.y).map(piece=>{
      const cymbal=cymbalIds.includes(piece.id),r=piece.r,ry=r*.43,shellHeight=shellHeightOf(piece);
      return <g key={piece.id} data-drum-art={piece.id} transform={`translate(${piece.x},${piece.y})`}>
        {cymbal ? <>
          <ellipse data-drum-surface="cymbal" cx="0" cy="0" rx={r} ry={ry} fill={`url(#${id}-brass)`} stroke="#948151" strokeWidth="1.5"/>
          {[.3,.5,.7,.88].map(scale=><ellipse key={scale} cx="0" cy="0" rx={r*scale} ry={ry*scale} fill="none" stroke="#77642d" strokeWidth=".55" opacity=".4"/>)}
          {Array.from({length:14},(_,i)=>{const a=i*Math.PI/14;return <path key={i} d={`M${Math.cos(a)*r*.18} ${Math.sin(a)*ry*.18}L${Math.cos(a)*r*.95} ${Math.sin(a)*ry*.95}M${-Math.cos(a)*r*.18} ${-Math.sin(a)*ry*.18}L${-Math.cos(a)*r*.95} ${-Math.sin(a)*ry*.95}`} stroke="#fff4c4" strokeWidth=".4" opacity=".14"/>;})}
          <path d={`M${-r*.8} ${-ry*.27}Q0 ${-ry*1.1} ${r*.8} ${-ry*.15}`} fill="none" stroke="#fff4c4" strokeWidth="2" opacity=".35"/>
          <ellipse cx="0" cy="-2" rx={r*.13} ry={ry*.3} fill="#dfc786" stroke="#8d773e"/><ellipse cx="0" cy="-5" rx="3.5" ry="2" fill="#28251c"/>
          <text className="drum-label" x="0" y={ry+14} textAnchor="middle">{piece.label}</text>
        </> : piece.id==='kick' ? <>
          <ellipse cx="8" cy="4" rx={r+6} ry={r*.9} fill={`url(#${id}-shell)`} stroke="#747d80" strokeWidth="3"/><ellipse cx="8" cy="4" rx={r+6} ry={r*.9} fill={`url(#${id}-wrap)`}/>
          <circle data-drum-surface="head" cx="0" cy="0" r={r} fill={`url(#${id}-head)`} stroke={`url(#${id}-chrome)`} strokeWidth="5"/>
          <circle cx="0" cy="0" r={r-5} fill="none" stroke="#828e8c" strokeWidth="1.5"/><circle cx="0" cy="0" r={r*.62} fill="none" stroke="#b9bdb6" strokeWidth=".6" opacity=".7"/>
          {Array.from({length:10},(_,index)=>{const angle=index*Math.PI/5;return <circle key={index} cx={Math.cos(angle)*(r-1)} cy={Math.sin(angle)*(r-1)} r="2.5" fill={`url(#${id}-chrome)`} stroke="#657174"/>;})}
          <circle cx={r*.5} cy={r*.37} r="10" fill="#151a1d" stroke="#777e79"/>
          <path d={`M${-r*.8} ${r*.5}l-15 29M${r*.8} ${r*.5}l16 29`} stroke="#b1babd" strokeWidth="4" fill="none"/>
          <g data-drum-surface="pedal"><path d={`M-10 ${r+28}L-7 ${r-4}H8L12 ${r+28}Z`} fill={`url(#${id}-chrome)`} stroke="#576267" strokeWidth="1.5"/><path d={`M-6 ${r+25}L-4 ${r+1}H5L8 ${r+25}Z`} fill="#27343b"/>{[7,12,17,22].map(y=><path key={y} d={`M-3 ${r+y}H6`} stroke="#717d7f" strokeWidth="1.5"/>)}<path d={`M0 ${r}V${r-27}`} stroke="#c1c9c8" strokeWidth="3"/><circle cx="0" cy={r-30} r="5" fill="#e2dbbd"/></g>
          <text className="drum-label on-head" x="0" y="3" textAnchor="middle">{piece.label}</text>
        </> : <>
          <path d={`M${-r*.75} ${shellHeight}l-8 ${224-piece.y-shellHeight}M${r*.75} ${shellHeight}l8 ${224-piece.y-shellHeight}`} stroke="#89979b" strokeWidth="3" fill="none"/>
          <ellipse cx="0" cy={shellHeight} rx={r} ry={ry} fill={`url(#${id}-shell)`} stroke="#69777a" strokeWidth="3"/>
          <path data-drum-surface="shell" d={`M${-r} 0V${shellHeight}C${-r} ${shellHeight+ry} ${r} ${shellHeight+ry} ${r} ${shellHeight}V0Z`} fill={`url(#${id}-shell)`}/>
          <path d={`M${-r} 0V${shellHeight}C${-r} ${shellHeight+ry} ${r} ${shellHeight+ry} ${r} ${shellHeight}V0Z`} fill={`url(#${id}-wrap)`}/>
          <path d={`M${-r} ${shellHeight}C${-r} ${shellHeight+ry} ${r} ${shellHeight+ry} ${r} ${shellHeight}`} fill="none" stroke="#adb8b9" strokeWidth="2.5"/>
          {[-.82,-.45,0,.45,.82].map(fraction=>{const x=r*fraction,y=ry*Math.sqrt(1-fraction*fraction);return <g key={fraction}><path d={`M${x} ${y+1}v${shellHeight-3}`} stroke="#bec6c5" strokeWidth="2"/><rect x={x-2.5} y={y+shellHeight-8} width="5" height="7" rx="1" fill={`url(#${id}-chrome)`}/></g>;})}
          {piece.id==='snare'?<path d={`M${-r+2} ${shellHeight-8}H${r-2}`} stroke="#c9d0cf" strokeWidth="1.4" strokeDasharray="1.5 1.5" opacity=".8"/>:null}
          <ellipse data-drum-surface="head" cx="0" cy="0" rx={r} ry={ry} fill={`url(#${id}-head)`} stroke={`url(#${id}-chrome)`} strokeWidth="3"/>
          <ellipse cx="0" cy="0" rx={r-4} ry={ry-2} fill="none" stroke="#86948f" strokeWidth=".8"/>
          <text className="drum-label on-head" x="0" y="3" textAnchor="middle">{piece.label}</text>
        </>}
      </g>;
    })}
  </>;
}
export const DrumsArt=memo(DrumsArtBase);
