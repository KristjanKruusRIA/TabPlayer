import { useId } from 'react';
import type { VoiceId } from '../audio/sound-model';

/** The instruments the engine can play a track through, drawn in SVG with the same treatment as the amp and the pedals:
 * gradients for material, a highlight for depth and a soft stage shadow. Each drawing is only what its source is: a guitar
 * for each guitar recording, a bass for each bass recording, and a keyboard for General MIDI, which is a whole sound set and
 * not one instrument. The colours are the ones in the sources' names. */
const uid=(raw:string)=>raw.replace(/[^a-zA-Z0-9]/g,'_');
const mix=(color:string,other:string,amount:number)=>`color-mix(in srgb,${color} ${100-amount}%,${other})`;

interface Finish {body:string;rim:string;board:string;pick:string;strings:number}
const finishes:Record<Exclude<VoiceId,'gm'>,Finish>={
  'green-guitar':{body:'#2E8A55',rim:'#17492C',board:'#5A3A22',pick:'#EDE6D2',strings:6},
  'black-guitar':{body:'#26262B',rim:'#08080A',board:'#4A3020',pick:'#C9C4B8',strings:6},
  'darkblack-bass':{body:'#1D1D21',rim:'#050506',board:'#3E2A1B',pick:'#BDB8AC',strings:4},
  'babyblue-bass':{body:'#86BDE2',rim:'#3F6F93',board:'#5A3A22',pick:'#F3EFE2',strings:4},
};
/** A plucked instrument seen from the front, neck to the left. */
function Plucked({id,finish,bass}:{id:string;finish:Finish;bass:boolean}) {
  const {body,rim,board,pick,strings}=finish,neckEnd=bass?76:70,frets=bass?11:10;
  // The body is a double cutaway; the bass is a little longer and narrower in the horn.
  const shape=bass
    ?'M72 21C76 10 88 8 93 13C98 9 110 9 113 19C119 29 115 44 101 48C89 52 78 49 72 41C66 37 66 26 72 21Z'
    :'M66 20C70 8 84 6 90 12C96 8 108 8 112 18C118 28 114 44 100 48C88 52 76 48 70 40C62 36 62 24 66 20Z';
  const gauge=(i:number)=>(bass?1.15:.6)+i*(bass?.35:.22);
  return <>
    <defs>
      <linearGradient id={`${id}n`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={mix(board,'white',20)}/><stop offset=".5" stopColor={board}/><stop offset="1" stopColor={mix(board,'black',45)}/></linearGradient>
      <radialGradient id={`${id}b`} cx=".32" cy=".25" r=".95"><stop offset="0" stopColor={mix(body,'white',38)}/><stop offset=".45" stopColor={body}/><stop offset="1" stopColor={mix(body,'black',55)}/></radialGradient>
      <linearGradient id={`${id}m`} x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#59606a"/><stop offset=".4" stopColor="#f2f3ef"/><stop offset="1" stopColor="#6b727a"/></linearGradient>
      <radialGradient id={`${id}s`}><stop offset="0" stopColor="#000" stopOpacity=".55"/><stop offset="1" stopColor="#000" stopOpacity="0"/></radialGradient>
    </defs>
    <ellipse cx="62" cy="53" rx="58" ry="4" fill={`url(#${id}s)`}/>
    <path d={`M3 22L13 20L13 34L3 31Z`} fill={mix(body,'black',25)} stroke={rim} strokeWidth=".8"/>
    {[0,1,2,3].map(i=><circle key={i} cx={5+i*2} cy={bass&&i>1?33:22.5+i*2.4} r=".9" fill="#d8d6cf"/>)}
    <rect x="12" y="24" width={neckEnd-12} height="9" rx="1" fill={`url(#${id}n)`} stroke={rim} strokeWidth=".6"/>
    {Array.from({length:frets},(_,i)=><path key={i} d={`M${14+i*((neckEnd-18)/frets)} 24V33`} stroke="#d8d9d6" strokeWidth=".6" opacity=".85"/>)}
    <path d="M12 24V33" stroke="#efe9d6" strokeWidth="1.4"/>
    {[3,5,7,9].map(f=><circle key={f} cx={14+(f-.5)*((neckEnd-18)/frets)} cy="28.5" r=".9" fill="#efe6c8" opacity=".8"/>)}
    <path d={shape} fill={`url(#${id}b)`} stroke={rim} strokeWidth="1"/>
    <path d="M74 14C82 11 90 14 95 18" fill="none" stroke="#fff" strokeOpacity=".4" strokeWidth="1.2" strokeLinecap="round"/>
    <path d={bass?'M84 20H103V40H84Z':'M80 22H104V40H80Z'} fill={pick} opacity=".55" stroke={rim} strokeOpacity=".4" strokeWidth=".5"/>
    {(bass?[86,95]:[82,92]).map(x=><g key={x}><rect x={x} y="23.5" width="5" height="11" rx="1.6" fill="#111" stroke="#454545" strokeWidth=".4"/>{Array.from({length:strings},(_,i)=><circle key={i} cx={x+2.5} cy={25+i*(9/Math.max(1,strings-1))} r=".55" fill={`url(#${id}m)`}/>)}</g>)}
    <rect x="102" y="22" width="5" height="13" rx="1" fill={`url(#${id}m)`} stroke="#444" strokeWidth=".4"/>
    {Array.from({length:strings},(_,i)=>{const y=24.6+i*(7.8/Math.max(1,strings-1));return <g key={i}><path d={`M12 ${y}H106`} stroke="#000" strokeWidth={gauge(strings-1-i)+.5} opacity=".45" transform="translate(0 .6)"/><path d={`M12 ${y}H106`} stroke={i>=strings-(bass?3:3)?'#b79a63':'#e9e8e2'} strokeWidth={gauge(strings-1-i)} strokeDasharray={i>=strings-3?`${(gauge(strings-1-i)*.9).toFixed(2)} .5`:undefined}/></g>;})}
    <circle cx="96" cy="43" r="2.2" fill={`url(#${id}m)`} stroke="#444" strokeWidth=".4"/><circle cx="104" cy="42" r="2.2" fill={`url(#${id}m)`} stroke="#444" strokeWidth=".4"/>
  </>;
}
/** A short keyboard, for the General MIDI sound set. */
function Keys({id}:{id:string}) {
  const whites=14,w=112/whites,black=new Set([1,3,6,8,10,13]);
  return <>
    <defs>
      <linearGradient id={`${id}iv`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#bdbbb0"/><stop offset=".15" stopColor="#fffef6"/><stop offset=".9" stopColor="#ece8d9"/><stop offset="1" stopColor="#aaa797"/></linearGradient>
      <linearGradient id={`${id}eb`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#3b4248"/><stop offset="1" stopColor="#0a0c0e"/></linearGradient>
      <linearGradient id={`${id}cs`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#4a4540"/><stop offset="1" stopColor="#15120f"/></linearGradient>
      <radialGradient id={`${id}s`}><stop offset="0" stopColor="#000" stopOpacity=".55"/><stop offset="1" stopColor="#000" stopOpacity="0"/></radialGradient>
    </defs>
    <ellipse cx="62" cy="52" rx="58" ry="4" fill={`url(#${id}s)`}/>
    <rect x="2" y="8" width="116" height="42" rx="3" fill={`url(#${id}cs)`} stroke="#050403" strokeWidth="1"/>
    <rect x="4" y="9" width="112" height="9" rx="1.5" fill="#26221e"/><circle cx="12" cy="13.5" r="2" fill="#7a6a4e"/><circle cx="20" cy="13.5" r="2" fill="#7a6a4e"/><rect x="90" y="11.5" width="20" height="4" rx="1" fill="#0b0a09"/>
    {Array.from({length:whites},(_,i)=><rect key={i} x={4+i*w+.3} y="19" width={w-.6} height="29" rx="1" fill={`url(#${id}iv)`} stroke="#9a978a" strokeWidth=".3"/>)}
    {Array.from({length:whites},(_,i)=>black.has(i)?<rect key={i} x={4+i*w-2.2} y="19" width="4.4" height="17" rx=".8" fill={`url(#${id}eb)`} stroke="#000" strokeWidth=".3"/>:null)}
  </>;
}
/** One source as a drawing. `viewBox` is 120 by 56 for every source, so they line up in a row. */
export function SourceArt({source,className}:{source:VoiceId;className?:string}) {
  const id=uid(useId());
  return <svg className={className} viewBox="0 0 120 56" aria-hidden="true" focusable="false">
    {source==='gm'?<Keys id={id}/>:<Plucked id={id} finish={finishes[source]} bass={source==='darkblack-bass'||source==='babyblue-bass'}/>}
  </svg>;
}

/** A track as a small drawing of what plays it: a guitar, a bass, drums or keys, by the track's General MIDI program. */
export type TrackKind='guitar'|'bass'|'drums'|'keys';
export const trackKind=(program:number,percussion:boolean):TrackKind=>percussion?'drums':program>=24&&program<=31?'guitar':program>=32&&program<=39?'bass':'keys';
export function TrackGlyph({kind}:{kind:TrackKind}) {
  const id=uid(useId());
  return <svg className="rig-track-glyph" viewBox="0 0 120 56" aria-hidden="true" focusable="false">
    {kind==='guitar'?<Plucked id={id} finish={finishes['black-guitar']} bass={false}/>:kind==='bass'?<Plucked id={id} finish={finishes['darkblack-bass']} bass/>:kind==='keys'?<Keys id={id}/>:<>
      <defs><radialGradient id={`${id}h`} cx=".4" cy=".3" r=".8"><stop offset="0" stopColor="#fffdf3"/><stop offset="1" stopColor="#9a9d98"/></radialGradient><linearGradient id={`${id}sh`} x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#4e090d"/><stop offset=".45" stopColor="#e34240"/><stop offset="1" stopColor="#3d090d"/></linearGradient><radialGradient id={`${id}s`}><stop offset="0" stopColor="#000" stopOpacity=".55"/><stop offset="1" stopColor="#000" stopOpacity="0"/></radialGradient></defs>
      <ellipse cx="60" cy="52" rx="42" ry="4" fill={`url(#${id}s)`}/>
      <path d="M22 28V44C22 50 98 50 98 44V28Z" fill={`url(#${id}sh)`} stroke="#222" strokeWidth=".8"/><ellipse cx="60" cy="28" rx="38" ry="12" fill={`url(#${id}h)`} stroke="#8a9399" strokeWidth="2"/>
      <path d="M30 14L52 26M90 14L68 26" stroke="#e8e4d4" strokeWidth="2" strokeLinecap="round"/>
    </>}
  </svg>;
}
