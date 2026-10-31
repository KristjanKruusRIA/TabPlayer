import { memo, useId } from 'react';
import { formatPitch } from '../tuning';
import { kitOrder, type DrumPiece } from './drum-kit';

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
  const left=136,neckLength=770,height=226;
  const neckHeight=Math.max(55,mode==='bass'?65+(strings-4)*10:65+(strings-6)*6),row=(neckHeight-26)/Math.max(1,strings-1);
  const top=(height-(strings-1)*row)/2,body=left+neckLength-6,width=body+306;
  const boundary=(fret:number)=>left+neckLength*(1-2**(-fret/12))/(1-2**(-maxFret/12));
  const position=(fret:number)=>fret===0?left-17:(boundary(fret-1)+boundary(fret))/2;
  return {left,neckLength,height,neckHeight,row,top,body,width,boundary,position};
}

/**
 * The bodies, in their own frame: x runs from the end of the fretboard towards the strap button, negative y is the bass side, and
 * the frame is flipped when drawn because the strings run highest first from the top. So the long horn sits beside the low strings
 * and the controls beside the high ones, where they are on the real thing. The cutaways stop clear of the last fret numbers.
 */
const bodyShapes={
  guitar:{
    outline:'M24-30C12-44 12-54 6-60C-8-66-26-70-40-78C-52-84-56-98-44-104C-30-112 30-96 66-84C92-76 116-74 140-84C176-100 240-108 272-84C296-62 300-30 292 0C300 40 296 74 268 94C236 110 176 104 140 88C116 78 92 78 66 90C34 104 8 110-12 106C-30 102-36 88-26 78C-12 68 6 58 14 44C18 38 22 34 26 30Z',
    guard:'M18-44C40-56 70-54 92-48C120-42 150-42 176-44C198-46 204-34 202-20L202 40C206 60 190 78 166 84C130 92 96 82 70 80C46 76 30 66 24 44Z',
    screws:[[22,-40],[92,-46],[196,-36],[198,40],[166,80],[70,76],[30,56]],
  },
  bass:{
    outline:'M24-32C14-44 10-60 0-66C-26-74-52-78-76-84C-92-90-100-100-90-108C-78-116-20-106 62-82C92-72 120-72 146-84C180-100 236-106 268-82C292-62 298-24 290 6C286 40 286 70 258 92C226 110 170 106 136 90C112 80 88 78 64 90C36 102 20 106 6 104C-8 102-16 90-8 78C2 66 12 52 16 42C20 36 24 34 26 32Z',
    guard:'M18-44C44-58 72-58 96-50C126-42 150-44 190-42L204-30L204 34C206 52 190 62 150 62C110 66 84 72 66 80C44 86 28 68 24 44Z',
    screws:[[22,-40],[96,-46],[196,-34],[198,30],[150,58],[66,74],[30,56]],
  },
};
/** A pickup: one cover, or two offset halves split across the strings, with a pole under every string. */
function Pickup({x,part,split,strings,top,row,neckHeight,metal}:{x:number;part:string;split:boolean;strings:number;top:number;row:number;neckHeight:number;metal:string}) {
  const middle=top+(strings-1)*row/2,half=Math.ceil(strings/2),cover='#17191a';
  const pole=(index:number)=>split?x+(index<half?-7:7):x;
  return <g data-instrument-part={part}>
    {split?<><rect x={x-16} y={top-11} width="18" height={middle-top+11} rx="4" fill={cover} stroke="#6b6256"/><rect x={x-2} y={middle} width="18" height={neckHeight/2-5} rx="4" fill={cover} stroke="#6b6256"/></>:<rect x={x-9} y={top-11} width="19" height={neckHeight-4} rx="8" fill={cover} stroke="#6b6256"/>}
    {Array.from({length:strings},(_,index)=><circle data-pickup-string={strings-index} key={index} cx={pole(index)} cy={top+index*row} r="2.5" fill={metal} stroke="#5c5b56" strokeWidth=".7"/>)}
  </g>;
}

interface FretboardArtProps {strings:number;/** Open pitches, highest string number first, as the names under the strings. */openKeys:string;mode:'guitar'|'bass';leftHanded:boolean;maxFret:number}
function FretboardArtBase({strings,openKeys,mode,leftHanded,maxFret}:FretboardArtProps) {
  const id=uid(useId()),{left,neckLength,height,neckHeight,row,top,body,width,boundary,position}=neckGeometry(strings,mode,maxFret);
  const names=openKeys.split(',');
  const wood=`url(#${id}-wood)`,metal=`url(#${id}-metal)`,cream=`url(#${id}-cream)`,pearl=`url(#${id}-pearl)`;
  const y0=top-12,y1=top+neckHeight-14,wound=mode==='bass'?0:Math.ceil(strings/2),bass=mode==='bass',shape=bodyShapes[mode];
  const saddle=body+210,stringEnd=saddle+30,nut=left-3,lift=bass?1.3:1;
  // Tuners stand in line along the low-string edge: the lowest string's post is nearest the nut and the highest the furthest out.
  const postX=(index:number)=>left-38-(strings-1-index)*(bass?84:82)/Math.max(1,strings-1),postY=y1+1;
  const headstock=`M${nut} ${y0}C${nut-30} ${y0+2} ${nut-52} ${y0+6*lift} ${nut-70} ${y0+2}C${nut-92} ${y0-4*lift} ${nut-112} ${y0-8*lift} ${nut-120} ${y0-4*lift}C${nut-128} ${y0+2} ${nut-132} ${y1-10} ${nut-128} ${y1+4}C${nut-126} ${y1+11} ${nut-120} ${y1+12} ${nut-112} ${y1+12}L${nut-14} ${y1+6}C${nut-6} ${y1+4} ${nut-4} ${y1} ${nut} ${y1}Z`;
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
      <radialGradient id={`${id}-burst`} gradientUnits="userSpaceOnUse" cx="150" cy="0" r="186"><stop stopColor="#f4bf4e"/><stop offset=".44" stopColor="#dc8b25"/><stop offset=".68" stopColor="#92401a"/><stop offset=".88" stopColor="#471a0b"/><stop offset="1" stopColor="#210c06"/></radialGradient>
      <pattern id={`${id}-bodygrain`} patternUnits="userSpaceOnUse" width="240" height="30"><path d="M0 6C60 12 150 0 240 7M0 20C80 13 170 29 240 21" fill="none" stroke="#3a1606" strokeWidth=".8" opacity=".22"/></pattern>
      <clipPath id={`${id}-outline`}><path d={shape.outline}/></clipPath>
    </defs>
    <g data-mirror={leftHanded?'left':'right'} transform={leftHanded?`matrix(-1 0 0 1 ${width} 0)`:undefined}>
      <ellipse cx={body+128} cy="220" rx="150" ry="5" fill="#000" opacity=".3"/>
      <g data-instrument-part="body" transform={`translate(${body},113) scale(1,-1)`}>
        <path d={shape.outline} fill={bass?cream:`url(#${id}-burst)`} stroke={bass?'#857f72':'#caa574'} strokeWidth="1.6"/>
        {bass?null:<path d={shape.outline} fill={`url(#${id}-bodygrain)`}/>}
        <g clipPath={`url(#${id}-outline)`}><path d={shape.outline} fill="none" stroke={bass?'#fffbed':'#ffdca0'} strokeWidth="9" opacity=".2"/><path d={bass?'M-84-103C-20-98 16-92 62-75C92-65 120-65 146-77C180-93 236-99 262-76':'M-40-100C-6-97 34-87 66-77C92-69 116-67 140-77C176-93 240-101 266-77'} fill="none" stroke="#fff" strokeWidth="2.5" opacity=".3"/></g>
        <path d={shape.guard} fill={bass?`url(#${id}-tortoise)`:`url(#${id}-pearl)`} stroke={bass?'#d0c9b7':'#3a2a1c'} strokeWidth="1.6"/>
        {shape.screws.map(([x,y],index)=><g key={index}><circle cx={x} cy={y} r="2.2" fill={metal}/><path d={`M${x-1.5} ${y}h3`} stroke="#53504a" strokeWidth=".6"/></g>)}
        {bass?<g transform="rotate(-8 214 66)"><rect x="168" y="52" width="92" height="30" rx="13" fill={metal} stroke="#5f6468"/>{[188,216].map(x=><g key={x} transform={`translate(${x},67)`}><circle r="10" fill="#17191a" stroke="#000"/><circle r="6" fill="#2c3032"/><path d="M0-8V-3" stroke="#e8e8e2" strokeWidth="1.3"/></g>)}<circle cx="242" cy="67" r="6" fill="#222627" stroke="#7b8084"/></g>:<>
          {[[196,54],[164,64],[132,68]].map(([x,y])=><g key={x} transform={`translate(${x},${y})`}><circle r="9.5" fill="#efe9d8" stroke="#8d8674"/><circle r="5.5" fill="#fbf7ea" stroke="#c9c1ad"/><path d="M0-8V-3" stroke="#5d625f" strokeWidth="1.3"/></g>)}
          <rect x="88" y="52" width="24" height="7" rx="2" fill="#2a2d2e" transform="rotate(-14 100 56)"/><rect x="97" y="49" width="6" height="13" rx="2" fill="#efe9d8" stroke="#8d8674" strokeWidth=".7" transform="rotate(-14 100 56)"/>
          <ellipse cx="244" cy="74" rx="7" ry="10" fill={metal} stroke="#5f6468" transform="rotate(32 244 74)"/><ellipse cx="244" cy="74" rx="3" ry="4.5" fill="#222627" transform="rotate(32 244 74)"/>
        </>}
        <circle cx={bass?-93:-49} cy={bass?-101:-97} r="2.6" fill={metal} stroke="#5f6468" strokeWidth=".6"/><circle cx={bass?292:294} cy="0" r="3" fill={metal} stroke="#5f6468" strokeWidth=".6"/>
      </g>
      <g data-instrument-part="headstock">
        <path d={headstock} fill={`url(#${id}-maple)`} stroke="#51412f" strokeWidth="1.2"/>
        <path d={headstock} fill={`url(#${id}-maplegrain)`}/>
        {Array.from({length:strings},(_,index)=>{const x=postX(index),reach=bass?19:15,button=bass?8:5;return <g key={index} data-tuner={strings-index}><rect x={x-1.8} y={postY} width="3.6" height={reach-button+6} fill={metal} stroke="#4a4a43" strokeWidth=".5"/>{bass?<path d={`M${x-button} ${postY+reach}c0-6 ${button*2}-6 ${button*2} 0c3 4 3 8 0 10c-4 2-${button*2-8}-1-${button} -1c-3 1-${button*2-8} 3-${button} 1c-3-2-3-6 0-10Z`} fill={metal} stroke="#4a4a43" strokeWidth=".6"/>:<ellipse cx={x} cy={postY+reach} rx={button} ry="6.5" fill={metal} stroke="#4a4a43" strokeWidth=".6"/>}<circle cx={x} cy={postY} r={bass?4.6:3.6} fill={metal} stroke="#4a4a43" strokeWidth=".8"/><circle cx={x} cy={postY} r="1.4" fill="#2b2f2d"/></g>;})}
      </g>
      <g data-instrument-part="neck"><rect x={left} y={top-15} width={neckLength+34} height={neckHeight+4} rx="2" fill="#b69c73" stroke="#51412f"/><rect x={left} y={top-12} width={neckLength+34} height={neckHeight-2} fill={wood}/><rect x={left} y={top-12} width={neckLength+34} height={neckHeight-2} fill={`url(#${id}-grain)`}/><path d={`M${left} ${top-12}H${body+34}M${left} ${top+neckHeight-14}H${body+34}`} stroke="#ba8d68" strokeWidth="1" opacity=".6"/><path d={`M${left} ${top-10}H${body+34}`} stroke="#fff" strokeWidth="1" opacity=".08"/></g>
      <g data-instrument-part="nut"><rect x={left-4} y={top-13} width="7" height={neckHeight} rx="1.4" fill={`url(#${id}-nut)`} stroke="#6d6552" strokeWidth=".8"/>{Array.from({length:strings},(_,index)=><path key={index} d={`M${left-3} ${top+index*row}h5`} stroke="#3a3326" strokeWidth=".9"/>)}</g>
      {Array.from({length:maxFret+1},(_,fret)=><g key={fret} data-fret-column={fret}><line data-fret-boundary={fret} x1={boundary(fret)} x2={boundary(fret)} y1={top-12} y2={top+neckHeight-14} stroke={fret===0?'#e8dcc5':'#131711'} strokeWidth={fret===0?5:3}/>{fret>0?<><rect x={boundary(fret)-1} y={top-12} width="2" height={neckHeight-2} fill={metal}/><path d={`M${boundary(fret)-.4} ${top-12}V${top+neckHeight-14}`} stroke="#fff" strokeWidth=".5" opacity=".7"/></>:null}</g>)}
      {[3,5,7,9,12,15,17,19,21,24].filter(fret=>fret<=maxFret).flatMap(fret=>(fret%12===0?[-neckHeight*.2,neckHeight*.2]:[0]).map((offset,index)=><g key={`${fret}/${index}`}><circle cx={position(fret)+.8} cy={height/2+offset+1} r="3.9" fill="#000" opacity=".35"/><circle cx={position(fret)} cy={height/2+offset} r="3.7" fill={pearl} stroke="#a79e86" strokeWidth=".7"/></g>))}
      <g data-instrument-part="bridge"><rect x={saddle-5} y={top-15} width="46" height={neckHeight+4} rx="3" fill={metal} stroke="#4a4a43"/>{Array.from({length:strings},(_,index)=><g key={index}><rect x={saddle-2} y={top+index*row-Math.min(5,row/2-.5)} width="25" height={Math.min(10,row-1)} rx="2" fill={metal} stroke="#6a6c66"/><circle cx={stringEnd} cy={top+index*row} r="2" fill="#343933"/></g>)}</g>
      {bass?<><Pickup x={body+96} part="neck-pickup" split strings={strings} top={top} row={row} neckHeight={neckHeight} metal={metal}/><Pickup x={body+170} part="bridge-pickup" split={false} strings={strings} top={top} row={row} neckHeight={neckHeight} metal={metal}/></>:[[62,'neck-pickup'],[118,'middle-pickup'],[174,'bridge-pickup']].map(([offset,part])=><Pickup key={part} x={body+Number(offset)} part={String(part)} split={false} strings={strings} top={top} row={row} neckHeight={neckHeight} metal={metal}/>)}
      {Array.from({length:strings},(_,index)=>{
        const string=strings-index,y=top+index*row,thickness=.7+index*.16,isWound=mode==='bass'||index>=wound;
        return <g key={string} data-string-row={string}><title>{`String ${string} · ${names[index]??''}`}</title>
          <path d={`M${postX(index)} ${postY}L${left-31} ${y}`} fill="none" stroke={isWound?'#c9b27a':'#d9d6cc'} strokeWidth={thickness}/>
          <line x1={left-31} x2={stringEnd} y1={y+1.4} y2={y+1.4} stroke="#160e08" opacity=".6" strokeWidth={1+index*.17}/>
          <rect x={left-31} y={y-thickness/2} width={stringEnd+31-left} height={thickness} fill={`url(#${id}-${isWound?'wound':'string'})`}/>
          {isWound?<line x1={left-31} x2={stringEnd} y1={y} y2={y} stroke="#2b2110" strokeWidth={Math.max(.5,thickness*.85)} strokeDasharray={`.5 ${(.9+index*.04).toFixed(2)}`} opacity=".75"/>:null}
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

export const cymbalIds=['hi-hat','crash','crash-2','reverse','ride','ride-2','china','splash'];
const shellHeights:Record<string,number>={'floor-tom':74,'high-floor-tom':64,'low-tom':50,'low-mid-tom':46,'hi-mid-tom':42,'high-tom':38,snare:27};
export const shellHeightOf=(piece:DrumPiece)=>shellHeights[piece.id]??38;
const isKick=(piece:DrumPiece)=>piece.id.startsWith('kick');
/** How much of a round surface shows from a three-quarter view above the kit. */
export const surfaceDepthOf=(piece:DrumPiece)=>piece.r*(cymbalIds.includes(piece.id)?.2:.3);
/** How far a piece's target reaches down from its centre: a cymbal seen edge-on is a sliver, so its target keeps a thumb-sized depth, and its name sits just under it. */
export const targetDepthOf=(piece:DrumPiece)=>cymbalIds.includes(piece.id)?Math.max(surfaceDepthOf(piece),16):surfaceDepthOf(piece);
/** Where each stand meets the floor, further up the picture for what stands further back, and where a boom arm leaves it. */
const stands:Record<string,{x:number;foot:number;top:number}>={splash:{x:48,foot:250,top:58},crash:{x:128,foot:246,top:112},'crash-2':{x:252,foot:236,top:98},ride:{x:556,foot:238,top:118},china:{x:640,foot:232,top:104},'ride-2':{x:806,foot:258,top:126},'hi-hat':{x:84,foot:284,top:140}};
const rackY=134,rack=`M226 ${rackY}H540M236 ${rackY}V242M530 ${rackY}V242M216 242H256M510 242H550`;
const legs=(x:number,foot:number,spread=27)=>`M${x} ${foot-34}L${x-spread} ${foot-3}M${x} ${foot-34}L${x+spread} ${foot-1}M${x} ${foot-34}L${x+4} ${foot+5}`;
/** The kit in three-quarter view: toms rack back from the kick, snare and hi-hat stand in front to one side, floor tom to the other. */
function DrumsArtBase({pieces}:{pieces:readonly DrumPiece[]}) {
  const id=uid(useId());
  const chrome=`url(#${id}-chrome)`;
  const tube=(d:string,key:string,width=4.2)=><g key={key}><path d={d} fill="none" stroke="#1b2023" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round"/><path d={d} fill="none" stroke="#aab2b4" strokeWidth={width*.36} strokeLinecap="round" strokeLinejoin="round"/></g>;
  const shadow=(x:number,y:number,rx:number,ry:number,key:string)=><ellipse key={key} cx={x} cy={y} rx={rx} ry={ry} fill={`url(#${id}-floor)`}/>;
  const pedal=(x:number,y:number,key:string)=><g key={key}><path d={`M${x-6} ${y-44}L${x+6} ${y-44}L${x+13} ${y+2}Q${x} ${y+7} ${x-13} ${y+2}Z`} fill={chrome} stroke="#2c3236" strokeWidth="1"/><path d={`M${x-4} ${y-40}L${x+4} ${y-40}L${x+9} ${y-1}L${x-9} ${y-1}Z`} fill="#20272b"/>{[-32,-25,-18,-11].map(step=><path key={step} d={`M${x-6} ${y+step}H${x+6}`} stroke="#79858a" strokeWidth="1"/>)}</g>;
  return <>
    <defs>
      <radialGradient id={`${id}-studio`} cx=".5" cy=".62" r=".72"><stop stopColor="#59616a"/><stop offset=".55" stopColor="#343b43"/><stop offset="1" stopColor="#1b2128"/></radialGradient>
      <linearGradient id={`${id}-shell`}><stop stopColor="#3d4347"/><stop offset=".14" stopColor="#8d9498"/><stop offset=".34" stopColor="#dfe3e3"/><stop offset=".46" stopColor="#f7f8f6"/><stop offset=".6" stopColor="#aab0b3"/><stop offset=".86" stopColor="#70777b"/><stop offset="1" stopColor="#32383b"/></linearGradient>
      <pattern id={`${id}-wrap`} patternUnits="userSpaceOnUse" width="6" height="6"><circle cx="1.4" cy="1.8" r=".35" fill="#fff" opacity=".5"/><circle cx="4.4" cy="4.6" r=".3" fill="#1d2225" opacity=".28"/></pattern>
      <radialGradient id={`${id}-head`} cx=".4" cy=".3" r=".85"><stop stopColor="#ffffff"/><stop offset=".55" stopColor="#f3f1e8"/><stop offset="1" stopColor="#bcbab0"/></radialGradient>
      <radialGradient id={`${id}-brass`} cx=".5" cy=".5" r=".55"><stop stopColor="#fbe7ae"/><stop offset=".12" stopColor="#c99a48"/><stop offset=".3" stopColor="#ecc97c"/><stop offset=".52" stopColor="#bd8d3a"/><stop offset=".74" stopColor="#e9c474"/><stop offset=".93" stopColor="#a87a2e"/><stop offset="1" stopColor="#6a4b18"/></radialGradient>
      <linearGradient id={`${id}-chrome`}><stop stopColor="#41474c"/><stop offset=".3" stopColor="#fafaf5"/><stop offset=".55" stopColor="#8e999e"/><stop offset=".8" stopColor="#eef0ee"/><stop offset="1" stopColor="#373e42"/></linearGradient>
      <radialGradient id={`${id}-floor`}><stop stopColor="#000" stopOpacity=".6"/><stop offset=".65" stopColor="#000" stopOpacity=".3"/><stop offset="1" stopColor="#000" stopOpacity="0"/></radialGradient>
    </defs>
    <rect x="0" y="0" width="860" height="300" rx="6" fill={`url(#${id}-studio)`}/>
    <g className="kit-shadows">{shadow(362,256,190,24,'kicks')}{shadow(672,272,84,14,'floor')}{shadow(570,252,70,12,'high-floor')}{shadow(176,278,70,11,'snare')}{shadow(84,284,60,10,'hat')}{shadow(806,258,40,6,'ride-2')}{shadow(48,250,36,6,'splash')}</g>
    <g className="kit-stands">
      {pieces.filter(piece=>cymbalIds.includes(piece.id)).map(piece=>{const stand=stands[piece.id];return stand?tube(`M${stand.x} ${stand.foot-34}V${stand.top}L${piece.x} ${piece.y}${legs(stand.x,stand.foot)}`,piece.id):null;})}
      {tube(rack,'rack',5.4)}
      {pieces.filter(piece=>piece.id.endsWith('tom')&&!piece.id.includes('floor')||piece.id==='reverse').map(piece=>tube(`M${piece.x} ${rackY}V${piece.y+(piece.id==='reverse'?0:shellHeightOf(piece))}`,piece.id+'-arm'))}
    </g>
    {pedal(84,292,'hi-hat-pedal')}
    {kitOrder(pieces).map(piece=>{
      const cymbal=cymbalIds.includes(piece.id),r=piece.r,ry=surfaceDepthOf(piece),shellHeight=shellHeightOf(piece),foot=(y:number)=>y-piece.y,upright=`rotate(${-piece.tilt})`;
      const lugs=piece.id==='snare'?[-.88,-.54,-.14,.3,.72]:[-.82,-.34,.2,.7],bottom=shellHeight+ry*1.33;
      return <g key={piece.id} data-drum-art={piece.id} transform={`translate(${piece.x},${piece.y})`}>
        {piece.id==='snare'?tube(`M0 ${bottom}V${foot(258)}${legs(0,foot(288),30)}M${-r*.8} ${shellHeight}L0 ${bottom+5}L${r*.8} ${shellHeight}`,'snare-stand'):null}
        {piece.id.endsWith('floor-tom')?(piece.id==='floor-tom'?[[-.92,282],[.92,276],[.08,292]]:[[-.92,258],[.92,254],[.08,264]]).map(([side,to])=>tube(`M${r*side} ${shellHeight*.3}L${r*side*1.08} ${foot(to)}`,`leg-${side}`,4.6)):null}
        <g transform={`rotate(${piece.tilt})`}>
        {cymbal ? <>
          {piece.id==='hi-hat'?<><path d={`M0 ${-ry-16}V4`} stroke="#d4dad9" strokeWidth="2"/><ellipse cx="0" cy="9" rx={r} ry={ry} fill={`url(#${id}-brass)`} stroke="#5e4416"/></>:null}
          <ellipse data-drum-surface="cymbal" cx="0" cy="0" rx={r} ry={ry} fill={`url(#${id}-brass)`} stroke="#7a5a24" strokeWidth="1"/>
          {[.34,.46,.58,.7,.82,.92].map(scale=><ellipse key={scale} cx="0" cy="0" rx={r*scale} ry={ry*scale} fill="none" stroke="#5e4416" strokeWidth=".45" opacity=".35"/>)}
          <path d={`M${-r*.88} ${-ry*.25}Q${-r*.3} ${-ry*1.05} ${r*.34} ${-ry*.8}`} fill="none" stroke="#fff6d4" strokeWidth="2" opacity=".55" strokeLinecap="round"/>
          {piece.id==='china'?<path d={`M${-r} 0Q0 ${-ry*1.8} ${r} 0`} fill="none" stroke="#f6dc98" strokeWidth="2" opacity=".75"/>:null}
          <ellipse cx="0" cy={-ry*.14} rx={r*.17} ry={ry*.42} fill="#f0d186" stroke="#7a5a24" strokeWidth=".7"/><rect x="-2.4" y={-ry*.5-5} width="4.8" height="4" rx="1" fill="#1f2224"/><path d={`M-4 ${-ry*.5-5.5}H4`} stroke="#d4dad9" strokeWidth="1.4"/>
          <text className="drum-label" x="0" y={targetDepthOf(piece)+11} textAnchor="middle" transform={upright}>{piece.label}</text>
        </> : isKick(piece) ? <>
          <circle cx="15" cy="-9" r={r} fill={`url(#${id}-shell)`} stroke="#23292c" strokeWidth="1.2"/><circle cx="15" cy="-9" r={r} fill={`url(#${id}-wrap)`}/><circle cx="15" cy="-9" r={r-2} fill="none" stroke={chrome} strokeWidth="2.4"/>
          {tube(`M${-r*.82} ${r*.56}L${-r-12} ${foot(254)}`,'spur-left')}{tube(`M${r*.82} ${r*.56}L${r+12} ${foot(254)}`,'spur-right')}
          <circle data-drum-surface="head" cx="0" cy="0" r={r} fill={`url(#${id}-head)`}/>
          <circle cx="0" cy="0" r={r} fill="none" stroke="#14181a" strokeWidth="5.5"/><circle cx="0" cy="0" r={r-3.4} fill="none" stroke={chrome} strokeWidth="1.3"/><circle cx="0" cy="0" r={r-11} fill="none" stroke="#aeab9e" strokeWidth=".8"/>
          {Array.from({length:10},(_,index)=>{const angle=(index+.5)*Math.PI/5,x=Math.cos(angle),y=Math.sin(angle);return <g key={index}><path d={`M${x*(r+5)} ${y*(r+5)}L${x*(r-1)} ${y*(r-1)}`} stroke="#e4e8e6" strokeWidth="2.4"/><circle cx={x*(r-1)} cy={y*(r-1)} r="2.1" fill={chrome} stroke="#3e464a" strokeWidth=".6"/></g>;})}
          <circle cx={r*.46} cy={r*.42} r="11" fill="#0d1012" stroke="#8b8f88" strokeWidth="1.4"/>
          <g data-drum-surface="pedal">{tube(`M0 ${r-34}V${r-2}`,'beater',3)}<circle cx="0" cy={r-36} r="6.5" fill="#efe9d4" stroke="#8d8674"/>{pedal(0,foot(292),'kick-pedal')}</g>
          <text className="drum-label on-head" x="0" y="3" textAnchor="middle">{piece.label}</text>
        </> : <>
          <path data-drum-surface="shell" d={`M${-r} 0V${shellHeight}C${-r} ${bottom} ${r} ${bottom} ${r} ${shellHeight}V0Z`} fill={`url(#${id}-shell)`} stroke="#23292c"/>
          <path d={`M${-r} 0V${shellHeight}C${-r} ${bottom} ${r} ${bottom} ${r} ${shellHeight}V0Z`} fill={`url(#${id}-wrap)`}/>
          {piece.id==='snare'?<path d={`M${-r} ${shellHeight*.5}C${-r} ${shellHeight*.5+ry*1.33} ${r} ${shellHeight*.5+ry*1.33} ${r} ${shellHeight*.5}`} fill="none" stroke="#596166" strokeWidth=".8"/>:null}
          {lugs.map(fraction=>{const x=r*fraction,y=ry*Math.sqrt(1-fraction*fraction),mid=y+shellHeight/2-6;return <g key={fraction}><path d={`M${x} ${y+1}V${y+shellHeight-1}`} stroke="#50585c" strokeWidth=".9"/><rect x={x-2.8} y={mid} width="5.6" height="12" rx="2.6" fill={chrome} stroke="#30373a" strokeWidth=".6"/></g>;})}
          <path d={`M${-r} ${shellHeight-1}C${-r} ${bottom-1} ${r} ${bottom-1} ${r} ${shellHeight-1}`} fill="none" stroke={chrome} strokeWidth="3.4"/>
          <ellipse cx="0" cy="1.5" rx={r} ry={ry} fill="none" stroke="#2a3033" strokeWidth="3.8"/>
          <ellipse data-drum-surface="head" cx="0" cy="0" rx={r} ry={ry} fill={`url(#${id}-head)`} stroke={chrome} strokeWidth="3.2"/>
          <ellipse cx="0" cy=".5" rx={r-3.5} ry={ry-1.6} fill="none" stroke="#b5b2a5" strokeWidth=".7"/>
          <text className="drum-label on-head" x="0" y="3" textAnchor="middle" transform={upright}>{piece.label}</text>
        </>}
        </g>
      </g>;
    })}
  </>;
}
export const DrumsArt=memo(DrumsArtBase);
