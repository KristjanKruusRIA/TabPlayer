import { useId } from 'react';
import type { EffectBlock } from '../edit-types';
import { blockNames } from '../audio/sound-model';
import { blockLook, knobSpots } from './blocks';
import type { AmpLook } from './blocks';

/** The hardware artwork. Everything here is SVG drawn by this app: gradients, filters and paths, no bitmaps, so it stays sharp at
 * any size and takes its colours from the design tokens and the block's own enamel. */
const uid=(raw:string)=>raw.replace(/[^a-zA-Z0-9]/g,'_');
const lighten=(color:string,amount:number)=>`color-mix(in srgb,${color} ${100-amount}%,white)`;
const darken=(color:string,amount:number)=>`color-mix(in srgb,${color} ${100-amount}%,black)`;

/** A pedal's face in a 100 by 120 box: enamel body, control plate, name plate with its small drawing, and a chrome footswitch.
 * The chain draws it small with the knobs as dots; the stage draws it large and lays real knobs over `knobSpots`. A bypassed
 * pedal keeps its colour and face, dimmed, with its lamp off. */
export function BlockFace({block,on,detail=false,knobs}:{block:EffectBlock;on:boolean;detail?:boolean;knobs:number}) {
  const id=uid(useId()),look=blockLook[block],color=look.color,eq=look.kind==='eq',wah=look.kind==='wah',spots=knobSpots[Math.min(5,knobs)]??[];
  return <svg className="rig-face" viewBox="0 0 100 120" data-on={on} aria-hidden="true" focusable="false" style={{'--pedal':color} as React.CSSProperties}>
    <defs>
      <linearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={lighten(color,22)}/><stop offset=".5" stopColor={color}/><stop offset="1" stopColor={darken(color,28)}/></linearGradient>
      <linearGradient id={`${id}p`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="rgb(0 0 0 / .32)"/><stop offset="1" stopColor="rgb(0 0 0 / .12)"/></linearGradient>
      <radialGradient id={`${id}c`} cx=".4" cy=".35" r=".8"><stop offset="0" stopColor="#f4f0e6"/><stop offset=".55" stopColor="#a8a399"/><stop offset="1" stopColor="#4a4740"/></radialGradient>
      <radialGradient id={`${id}k`} cx=".38" cy=".32" r=".85"><stop offset="0" stopColor="#5a554d"/><stop offset="1" stopColor="#15130f"/></radialGradient>
      {detail&&<filter id={`${id}n`} x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="1.4" numOctaves="2" seed="4" result="noise"/><feColorMatrix in="noise" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 .22 0"/><feComposite in2="SourceGraphic" operator="in"/></filter>}
    </defs>
    <g className="rig-face-body">
      <rect x="2" y="2" width="96" height="116" rx="9" fill={`url(#${id}b)`} stroke="rgb(0 0 0 / .6)" strokeWidth="1.2"/>
      {detail&&<rect x="2" y="2" width="96" height="116" rx="9" fill="#000" filter={`url(#${id}n)`}/>}
      <rect x="4" y="4" width="92" height="112" rx="7" fill="none" stroke="rgb(255 255 255 / .16)" strokeWidth=".8"/>
      <rect x="8" y="12" width="84" height="62" rx="4" fill={`url(#${id}p)`} stroke="rgb(255 255 255 / .08)" strokeWidth=".6"/>
      {[[7,7],[93,7],[7,113],[93,113]].map(([x,y])=><g key={`${x}${y}`}><circle cx={x} cy={y} r="2.2" fill="rgb(0 0 0 / .42)"/><path d={`M${x-1.4} ${y}h2.8`} stroke="rgb(255 255 255 / .35)" strokeWidth=".6"/></g>)}
      {eq
        ?(detail?null:(block==='graphicEq'?Array.from({length:10},(_,i)=>i):[0,1,2,3,4]).map((i,_,list)=>{const x=14+i*(72/(list.length-1)),cap=26+((i*23)%28);return <g key={i}><rect x={x-1} y="18" width="2" height="50" rx="1" fill="rgb(0 0 0 / .5)"/><rect x={x-3.4} y={cap} width="6.8" height="5" rx="1.2" fill="#e9e4d8"/></g>;}))
        :!detail&&spots.map(([x,y],i)=><g key={i}><circle cx={x} cy={y} r="8.4" fill={`url(#${id}k)`} stroke="rgb(0 0 0 / .6)" strokeWidth=".8"/><path d={`M${x} ${y-6.6}V${y-2.2}`} stroke="#f1ece3" strokeWidth="1.6" strokeLinecap="round" transform={`rotate(${[-40,25,-10,60,-60][i%5]} ${x} ${y})`}/></g>)}
      <circle cx="50" cy="8.6" r="2.6" fill={on?'var(--tp-on)':'#1b1915'} stroke="rgb(0 0 0 / .6)" strokeWidth=".6"/>
      {on&&<circle cx="50" cy="8.6" r="5.6" fill="var(--tp-on)" opacity=".22"/>}
      <rect x="14" y="78" width="72" height="14" rx="2.4" fill="rgb(0 0 0 / .34)" stroke="rgb(255 255 255 / .1)" strokeWidth=".5"/>
      <g transform={detail?'translate(16 82)':'translate(40 82)'} stroke="rgb(255 255 255 / .8)" strokeWidth={detail?1.1:1.8} fill="none" strokeLinecap="round" strokeLinejoin="round"><path d={look.glyph} transform={detail?'scale(1.1)':'scale(1)'}/></g>
      {detail&&<text x="63" y="88.4" textAnchor="middle" className="rig-face-name" textLength={Math.min(44,blockNames[block].length*4.2)} lengthAdjust="spacingAndGlyphs">{blockNames[block].toUpperCase()}</text>}
      {wah
        ?<g><path d="M24 97L76 97L72 115L28 115Z" fill="#17150f" stroke="rgb(255 255 255 / .2)" strokeWidth=".6"/>{[100,103.5,107,110.5].map(y=><path key={y} d={`M${24+(y-97)*.22} ${y}H${76-(y-97)*.22}`} stroke="rgb(255 255 255 / .28)" strokeWidth="1"/>)}</g>
        :<g><circle cx="50" cy="104" r="10.4" fill="rgb(0 0 0 / .5)"/><circle cx="50" cy="104" r="9" fill={`url(#${id}c)`} stroke="rgb(0 0 0 / .6)" strokeWidth=".6"/><circle cx="50" cy="104" r="5.6" fill="none" stroke="rgb(0 0 0 / .35)" strokeWidth=".8"/></g>}
    </g>
  </svg>;
}

function Shell({on,children,viewBox='0 0 100 120'}:{on:boolean;children:React.ReactNode;viewBox?:string}) {
  return <svg className="rig-face" viewBox={viewBox} data-on={on} aria-hidden="true" focusable="false">{children}</svg>;
}
/** The amp head in the chain. */
function AmpIcon({on}:{on:boolean}) {
  const id=uid(useId()),look=blockLook.amp;
  return <Shell on={on}><defs><linearGradient id={`${id}a`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={lighten(look.color,25)}/><stop offset="1" stopColor={darken(look.color,25)}/></linearGradient></defs>
    <g className="rig-face-body">
      <path d="M32 34V26a5 5 0 0 1 5-5h26a5 5 0 0 1 5 5v8" fill="none" stroke="#0d0b09" strokeWidth="5"/><path d="M32 34V26a5 5 0 0 1 5-5h26a5 5 0 0 1 5 5v8" fill="none" stroke="#4a4136" strokeWidth="2"/>
      <rect x="2" y="32" width="96" height="76" rx="6" fill="#1a1612" stroke="rgb(0 0 0 / .7)" strokeWidth="1.2"/>
      <rect x="8" y="38" width="84" height="28" rx="2.5" fill="#33291d"/>{[0,1,2,3,4,5,6].map(i=><path key={i} d={`M9 ${41+i*3.6}H91`} stroke="rgb(0 0 0 / .4)"/>)}
      <rect x="8" y="70" width="84" height="32" rx="3" fill={`url(#${id}a)`} stroke="rgb(0 0 0 / .6)" strokeWidth=".8"/>
      {[0,1,2,3,4,5].map(i=><g key={i}><circle cx={17+i*13.2} cy="88" r="4.8" fill="#1d1710" stroke="rgb(0 0 0 / .6)" strokeWidth=".6"/><path d={`M${17+i*13.2} 84.4V87.4`} stroke="#d8b878" strokeWidth="1.3" strokeLinecap="round"/></g>)}
      <circle cx="86" cy="75" r="2" fill={on?'var(--tp-on)':'#33291d'}/>
    </g></Shell>;
}
function CabinetIcon({on}:{on:boolean}) {
  const id=uid(useId());
  return <Shell on={on}><defs><radialGradient id={`${id}s`} cx=".42" cy=".38" r=".7"><stop offset="0" stopColor="#5b554a"/><stop offset=".6" stopColor="#1c1915"/><stop offset="1" stopColor="#0a0908"/></radialGradient></defs>
    <g className="rig-face-body"><rect x="6" y="14" width="88" height="96" rx="5" fill="#241d16" stroke="rgb(0 0 0 / .7)" strokeWidth="1.2"/>
      <rect x="12" y="20" width="76" height="84" rx="2.5" fill="#3a3025"/>{Array.from({length:9},(_,i)=><path key={i} d={`M13 ${26+i*8.5}H87`} stroke="rgb(0 0 0 / .3)"/>)}
      <circle cx="50" cy="62" r="31" fill={`url(#${id}s)`} stroke="rgb(0 0 0 / .8)" strokeWidth="1.4"/><circle cx="50" cy="62" r="21" fill="none" stroke="rgb(255 255 255 / .12)" strokeWidth="1"/><circle cx="50" cy="62" r="8" fill="#0f0d0a" stroke="rgb(255 255 255 / .2)" strokeWidth=".8"/></g></Shell>;
}
function MicIcon({on}:{on:boolean}) {
  const id=uid(useId());
  return <Shell on={on}><defs><linearGradient id={`${id}m`} x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#6a6a6a"/><stop offset=".5" stopColor="#d8d4cb"/><stop offset="1" stopColor="#5a5a5a"/></linearGradient></defs>
    <g className="rig-face-body"><rect x="2" y="2" width="96" height="116" rx="9" fill={blockLook.microphone.color} stroke="rgb(0 0 0 / .6)" strokeWidth="1.2"/><rect x="4" y="4" width="92" height="112" rx="7" fill="none" stroke="rgb(255 255 255 / .16)" strokeWidth=".8"/>
      <rect x="38" y="20" width="24" height="40" rx="12" fill={`url(#${id}m)`} stroke="rgb(0 0 0 / .6)"/>{Array.from({length:6},(_,i)=><path key={i} d={`M40 ${28+i*5}H60`} stroke="rgb(0 0 0 / .3)"/>)}
      <path d="M28 50a22 22 0 0 0 44 0M50 72V94M36 96H64" fill="none" stroke="#e9e4d8" strokeWidth="3" strokeLinecap="round"/><circle cx="50" cy="9" r="2.6" fill={on?'var(--tp-on)':'#1b1915'}/></g></Shell>;
}
/** A block in the signal chain: its own face, in its own colour, lamp on or off. */
export function BlockIcon({block,on,knobs}:{block:EffectBlock;on:boolean;knobs:number}) {
  const kind=blockLook[block].kind;
  return kind==='amp'?<AmpIcon on={on}/>:kind==='cabinet'?<CabinetIcon on={on}/>:kind==='mic'?<MicIcon on={on}/>:<BlockFace block={block} on={on} knobs={knobs}/>;
}

/** An amp head: piped and covered, with a handle, grille cloth, and a brushed plate in the model's own colour. Knobs sit over the plate. */
export function AmpArt({look,on}:{look:AmpLook;on:boolean}) {
  const id=uid(useId());
  const stops=(c:string)=>[<stop key="0" offset="0" stopColor={lighten(c,24)}/>,<stop key="1" offset=".5" stopColor={c}/>,<stop key="2" offset="1" stopColor={darken(c,22)}/>];
  return <svg className="rig-amp-art" viewBox="0 0 640 320" data-on={on} aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id={`${id}pl`} x1="0" y1="0" x2="0" y2="1">{stops(look.plate)}</linearGradient>
      <linearGradient id={`${id}pi`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={lighten(look.piping,30)}/><stop offset="1" stopColor={darken(look.piping,30)}/></linearGradient>
      <linearGradient id={`${id}hd`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#8a7f70"/><stop offset=".35" stopColor="#2a251f"/><stop offset="1" stopColor="#0c0a08"/></linearGradient>
      <linearGradient id={`${id}tx`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={lighten(look.tolex,10)}/><stop offset="1" stopColor={darken(look.tolex,35)}/></linearGradient>
      <radialGradient id={`${id}sc`} cx=".35" cy=".3" r=".9"><stop offset="0" stopColor="#d9d3c4"/><stop offset="1" stopColor="#4d4a42"/></radialGradient>
      <radialGradient id={`${id}lamp`} cx=".4" cy=".35" r=".7"><stop offset="0" stopColor={on?'#f3ffcf':'#4a3524'}/><stop offset="1" stopColor={on?'#8fbf3f':'#1e130b'}/></radialGradient>
      <filter id={`${id}grain`} x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="3" seed="7" result="n"/><feColorMatrix in="n" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 .55 -.18"/><feComposite in2="SourceGraphic" operator="in"/></filter>
      <filter id={`${id}brush`} x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".004 .9" numOctaves="2" seed="2" result="n"/><feColorMatrix in="n" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 .7 -.28"/><feComposite in2="SourceGraphic" operator="in"/></filter>
      <filter id={`${id}cloth`} x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".6 .6" numOctaves="2" seed="3" result="n"/><feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 .5 0"/><feComposite in2="SourceGraphic" operator="in"/></filter>
      <filter id={`${id}blur`} x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="9"/></filter>
      <filter id={`${id}drop`} x="-10%" y="-10%" width="120%" height="140%"><feDropShadow dx="0" dy="4" stdDeviation="3" floodColor="#000" floodOpacity=".6"/></filter>
      <pattern id={`${id}wv`} width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="4" fill={look.grille}/><path d="M0 1H4M1 0V4" stroke="rgb(0 0 0 / .45)" strokeWidth=".9"/><path d="M0 3H4M3 0V4" stroke="rgb(255 255 255 / .09)" strokeWidth=".9"/></pattern>
    </defs>
    <ellipse cx="320" cy="304" rx="290" ry="12" fill="#000" opacity=".7" filter={`url(#${id}blur)`}/>
    <g className="rig-amp-body">
      <g filter={`url(#${id}drop)`}><path d="M226 38V22a14 14 0 0 1 14-14h160a14 14 0 0 1 14 14v16" fill="none" stroke={`url(#${id}hd)`} strokeWidth="12" strokeLinejoin="round"/><path d="M226 38V22a14 14 0 0 1 14-14h160a14 14 0 0 1 14 14v16" fill="none" stroke="rgb(255 255 255 / .22)" strokeWidth="2" strokeLinejoin="round" transform="translate(0 -3)"/>
        {[[226,38],[414,38]].map(([x,y])=><g key={x}><rect x={x-11} y={y-4} width="22" height="14" rx="3" fill="#0c0a08"/><circle cx={x} cy={y+3} r="3" fill={`url(#${id}sc)`}/></g>)}</g>
      <rect x="4" y="38" width="632" height="262" rx="12" fill={`url(#${id}tx)`} stroke="#050403" strokeWidth="2"/>
      <rect x="4" y="38" width="632" height="262" rx="12" fill="#fff" filter={`url(#${id}grain)`} opacity=".5"/>
      <rect x="9" y="43" width="622" height="252" rx="9" fill="none" stroke="rgb(255 255 255 / .12)" strokeWidth="1.4"/>
      <rect x="18" y="52" width="604" height="104" rx="5" fill={`url(#${id}pi)`} stroke="#050403"/>
      <rect x="23" y="57" width="594" height="94" rx="3" fill={`url(#${id}wv)`}/><rect x="23" y="57" width="594" height="94" rx="3" fill="#000" filter={`url(#${id}cloth)`} opacity=".55"/>
      <rect x="23" y="57" width="594" height="94" rx="3" fill="none" stroke="#050403" strokeWidth="2"/>
      <path d="M23 150L617 150" stroke="rgb(0 0 0 / .5)" strokeWidth="3"/>
      <rect x="18" y="162" width="604" height="128" rx="5" fill={`url(#${id}pi)`} stroke="#050403"/>
      <rect x="22" y="166" width="596" height="120" rx="3" fill={`url(#${id}pl)`} stroke={look.plateEdge} strokeWidth="1.2"/>
      <rect x="22" y="166" width="596" height="120" rx="3" fill="#fff" filter={`url(#${id}brush)`} opacity=".55"/>
      <rect x="28" y="172" width="584" height="108" rx="2" fill="none" stroke={look.ink} strokeOpacity=".35" strokeWidth="1"/>
      {[[36,180],[604,180],[36,272],[604,272]].map(([x,y])=><g key={`${x}${y}`}><circle cx={x} cy={y} r="6" fill={`url(#${id}sc)`} stroke="rgb(0 0 0 / .6)" strokeWidth=".8"/><path d={`M${x-3.6} ${y+1.4}L${x+3.6} ${y-1.4}`} stroke="rgb(0 0 0 / .65)" strokeWidth="1.4"/></g>)}
      <text x="320" y="196" textAnchor="middle" className="rig-amp-model" fill={look.ink}>{look.name.toUpperCase()}</text>
      <circle cx="418" cy="187" r="7" fill="#0c0a08"/><circle cx="418" cy="187" r="5" fill={`url(#${id}lamp)`}/>{on&&<circle cx="418" cy="187" r="12" fill="#b8e45f" opacity=".18"/>}
      <rect x="64" y="296" width="52" height="8" rx="2" fill="#0b0907"/><rect x="524" y="296" width="52" height="8" rx="2" fill="#0b0907"/>
    </g>
  </svg>;
}

/** The mic's four placements over the speaker, as proportions of the picture: the engine has these four and nothing finer. */
export const micSpots:Record<'close'|'standard'|'edge'|'room',{x:number;y:number}>={close:{x:50,y:50},standard:{x:66,y:50},edge:{x:84,y:50},room:{x:50,y:90}};
/** A cabinet front: grille cloth over a speaker with a surround, a ribbed cone and a dust cap, lit from the upper left. */
export function CabinetArt() {
  const id=uid(useId());
  return <svg className="rig-cab-art" viewBox="0 0 268 268" aria-hidden="true" focusable="false">
    <defs>
      <radialGradient id={`${id}cone`} cx=".4" cy=".36" r=".75"><stop offset="0" stopColor="#47413a"/><stop offset=".45" stopColor="#1d1a16"/><stop offset="1" stopColor="#070605"/></radialGradient>
      <radialGradient id={`${id}sur`} cx=".4" cy=".36" r=".8"><stop offset="0" stopColor="#6b655a"/><stop offset="1" stopColor="#14110e"/></radialGradient>
      <radialGradient id={`${id}cap`} cx=".38" cy=".32" r=".8"><stop offset="0" stopColor="#8d867a"/><stop offset=".5" stopColor="#2c2823"/><stop offset="1" stopColor="#0c0a08"/></radialGradient>
      <linearGradient id={`${id}fr`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#4a3a2b"/><stop offset="1" stopColor="#140f0a"/></linearGradient>
      <filter id={`${id}cloth`} x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".7" numOctaves="2" seed="5" result="n"/><feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 .55 0"/><feComposite in2="SourceGraphic" operator="in"/></filter>
      <filter id={`${id}blur`} x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="6"/></filter>
      <pattern id={`${id}wv`} width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="4" fill="#2f261c"/><path d="M0 1H4M1 0V4" stroke="rgb(0 0 0 / .4)" strokeWidth=".9"/><path d="M0 3H4M3 0V4" stroke="rgb(255 255 255 / .08)" strokeWidth=".9"/></pattern>
    </defs>
    <ellipse cx="134" cy="262" rx="122" ry="6" fill="#000" opacity=".7" filter={`url(#${id}blur)`}/>
    <rect x="2" y="2" width="264" height="260" rx="8" fill={`url(#${id}fr)`} stroke="#050403" strokeWidth="2"/>
    <rect x="9" y="9" width="250" height="246" rx="4" fill={`url(#${id}wv)`} stroke="#050403" strokeWidth="1.4"/><rect x="9" y="9" width="250" height="246" rx="4" fill="#000" filter={`url(#${id}cloth)`} opacity=".5"/>
    <circle cx="134" cy="134" r="106" fill="#000" opacity=".45" transform="translate(3 5)" filter={`url(#${id}blur)`}/>
    <circle cx="134" cy="134" r="104" fill={`url(#${id}sur)`} stroke="#050403" strokeWidth="2"/>
    <circle cx="134" cy="134" r="92" fill="none" stroke="rgb(255 255 255 / .13)" strokeWidth="2"/><circle cx="134" cy="134" r="86" fill="none" stroke="rgb(0 0 0 / .65)" strokeWidth="4"/>
    <circle cx="134" cy="134" r="82" fill={`url(#${id}cone)`}/>
    {[70,58,46,36].map((r,i)=><circle key={r} cx="134" cy="134" r={r} fill="none" stroke={i%2?'rgb(255 255 255 / .08)':'rgb(0 0 0 / .6)'} strokeWidth="2"/>)}
    <path d="M134 52A82 82 0 0 0 52 134" fill="none" stroke="rgb(255 255 255 / .2)" strokeWidth="3" strokeLinecap="round"/>
    <circle cx="134" cy="134" r="27" fill={`url(#${id}cap)`} stroke="#050403" strokeWidth="1.6"/><path d="M118 124A22 22 0 0 1 134 114" fill="none" stroke="rgb(255 255 255 / .45)" strokeWidth="3" strokeLinecap="round"/>
    {[[20,20],[248,20],[20,244],[248,244]].map(([x,y])=><circle key={`${x}${y}`} cx={x} cy={y} r="4.5" fill="#0b0907" stroke="rgb(255 255 255 / .2)"/>)}
  </svg>;
}
/** A small dynamic microphone, its capsule at the origin and its body trailing down and to the right. */
export function MicArt() {
  const id=uid(useId());
  return <svg className="rig-mic-art" viewBox="-20 -14 96 118" aria-hidden="true" focusable="false">
    <defs><linearGradient id={`${id}b`} x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#3b3b3b"/><stop offset=".45" stopColor="#b9b6ae"/><stop offset="1" stopColor="#2d2d2d"/></linearGradient>
      <radialGradient id={`${id}h`} cx=".4" cy=".35" r=".8"><stop offset="0" stopColor="#d8d5cc"/><stop offset="1" stopColor="#3e3d39"/></radialGradient>
      <filter id={`${id}s`} x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="2" dy="4" stdDeviation="2.5" floodColor="#000" floodOpacity=".7"/></filter></defs>
    <g filter={`url(#${id}s)`} transform="rotate(-32)">
      <path d="M-11 0A11 11 0 0 1 11 0V6H-11Z" fill={`url(#${id}h)`} stroke="#0a0908" strokeWidth="1"/>{[-6,-2,2,6].map(x=><path key={x} d={`M${x} -9V5`} stroke="rgb(0 0 0 / .35)" strokeWidth="1"/>)}
      <rect x="-11" y="5" width="22" height="5" rx="1.5" fill="#0d0c0a"/>
      <path d="M-8 10H8L6 52H-6Z" fill={`url(#${id}b)`} stroke="#0a0908" strokeWidth="1"/>
      <path d="M-6 52H6L5 62H-5Z" fill="#151412"/><path d="M0 62V84" stroke="#0d0c0a" strokeWidth="3" strokeLinecap="round"/>
    </g>
  </svg>;
}
