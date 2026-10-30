import type { BlockKind } from './blocks';

/** The hardware artwork. Everything here is drawn as SVG paths and shapes owned by this app; none of it is a bitmap, so it stays sharp at any size and takes its colours from the design tokens. */

/** A block in the signal chain, small: a pedal, an amp head, a cabinet, a microphone or an equaliser. */
export function BlockIcon({kind,color,on}:{kind:BlockKind;color:string;on:boolean}) {
  const body=on?color:'var(--tp-raised)',edge=on?'rgb(0 0 0 / .45)':'var(--tp-line-subtle)',led=on?'var(--tp-on)':'var(--tp-line-subtle)',ink=on?'rgb(0 0 0 / .35)':'var(--tp-line-strong)';
  return <svg className="rig-icon" viewBox="0 0 44 52" aria-hidden="true" focusable="false">
    {kind==='amp'?<>
      <rect x="2" y="12" width="40" height="30" rx="3" fill={body} stroke={edge}/>
      <rect x="5" y="15" width="34" height="11" rx="1.5" fill={ink}/>
      {[0,1,2,3,4].map(i=><circle key={i} cx={9+i*6.5} cy="34" r="2.3" fill="var(--tp-text)" opacity={on?.9:.5}/>)}
      <path d="M14 12v-4a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v4" fill="none" stroke={edge} strokeWidth="1.5"/>
    </>:kind==='cabinet'?<>
      <rect x="4" y="6" width="36" height="40" rx="3" fill={body} stroke={edge}/>
      <circle cx="22" cy="26" r="13" fill={ink}/><circle cx="22" cy="26" r="8" fill="none" stroke="var(--tp-text)" strokeWidth="1" opacity={on?.55:.35}/><circle cx="22" cy="26" r="3" fill="var(--tp-text)" opacity={on?.8:.45}/>
    </>:kind==='mic'?<>
      <rect x="6" y="6" width="32" height="40" rx="3" fill={body} stroke={edge}/>
      <rect x="18" y="12" width="8" height="15" rx="4" fill="var(--tp-text)" opacity={on?.85:.45}/>
      <path d="M14 23a8 8 0 0 0 16 0M22 31v6M17 37h10" fill="none" stroke="var(--tp-text)" strokeWidth="1.5" strokeLinecap="round" opacity={on?.85:.45}/>
    </>:<>
      <rect x="5" y="2" width="34" height="48" rx="4" fill={body} stroke={edge}/>
      <circle cx="22" cy="9" r="2" fill={led}/>
      {kind==='eq'
        ?[0,1,2,3,4].map(i=><g key={i}><rect x={9+i*6.4} y="14" width="1.6" height="17" rx=".8" fill={ink}/><rect x={7.8+i*6.4} y={19+((i*7)%9)} width="4" height="3" rx=".8" fill="var(--tp-text)" opacity={on?.9:.5}/></g>)
        :<><circle cx="14" cy="19" r="4.2" fill="var(--tp-text)" opacity={on?.85:.45}/><circle cx="30" cy="19" r="4.2" fill="var(--tp-text)" opacity={on?.85:.45}/><circle cx="14" cy="19" r="1.2" fill={ink}/><circle cx="30" cy="19" r="1.2" fill={ink}/></>}
      <circle cx="22" cy="42" r="5.6" fill={ink}/><circle cx="22" cy="42" r="3.4" fill="var(--tp-text)" opacity={on?.75:.4}/>
    </>}
  </svg>;
}

/** The face of a stage pedal: body, plate and footswitch. The knobs and the real bypass button sit over it. */
export function PedalArt({name,on}:{name:string;on:boolean}) {
  return <svg className="rig-pedal-art" viewBox="0 0 320 300" aria-hidden="true" focusable="false">
    <rect x="3" y="3" width="314" height="294" rx="14" fill="var(--pedal)" stroke="rgb(0 0 0 / .5)" strokeWidth="2"/>
    <rect x="12" y="12" width="296" height="276" rx="10" fill="rgb(0 0 0 / .16)"/>
    {[[24,24],[296,24],[24,276],[296,276]].map(([x,y])=><g key={`${x}${y}`}><circle cx={x} cy={y} r="5" fill="rgb(0 0 0 / .35)"/><path d={`M${x-3} ${y}h6`} stroke="var(--tp-text)" strokeOpacity=".4" strokeWidth="1.2"/></g>)}
    <circle cx="160" cy="26" r="6" fill={on?'var(--tp-on)':'var(--tp-line-subtle)'} stroke="rgb(0 0 0 / .5)"/>
    {on&&<circle cx="160" cy="26" r="11" fill="var(--tp-on)" opacity=".16"/>}
    <rect x="76" y="204" width="168" height="22" rx="3" fill="rgb(0 0 0 / .28)"/>
    <text x="160" y="220" textAnchor="middle" className="rig-pedal-name">{name.toUpperCase()}</text>
    <circle cx="160" cy="258" r="25" fill="rgb(0 0 0 / .4)"/><circle cx="160" cy="258" r="21" fill="var(--tp-line-strong)"/><circle cx="160" cy="258" r="16" fill="var(--tp-raised)" stroke="var(--tp-text)" strokeOpacity=".35"/>
  </svg>;
}

/** An amp head: handle, grille cloth and a tungsten faceplate. The six knobs sit over the plate. */
export function AmpArt({model}:{model:string}) {
  const lines=Array.from({length:22},(_,i)=>50+i*4);
  return <svg className="rig-amp-art" viewBox="0 0 640 300" aria-hidden="true" focusable="false">
    <path d="M230 30V16a10 10 0 0 1 10-10h160a10 10 0 0 1 10 10v14" fill="none" stroke="#0d0b09" strokeWidth="9" strokeLinejoin="round"/>
    <path d="M230 30V16a10 10 0 0 1 10-10h160a10 10 0 0 1 10 10v14" fill="none" stroke="var(--tp-line-subtle)" strokeWidth="3" strokeLinejoin="round"/>
    <rect x="2" y="28" width="636" height="264" rx="10" fill="#191613" stroke="#0d0b09" strokeWidth="2"/>
    <rect x="20" y="44" width="600" height="92" rx="4" fill="#2A241C" stroke="#0d0b09"/>
    {lines.map(y=><line key={y} x1="22" x2="618" y1={y} y2={y} stroke="#0d0b09" strokeOpacity=".5"/>)}
    {Array.from({length:60},(_,i)=><line key={i} x1={32+i*10} x2={32+i*10} y1="46" y2="134" stroke="#3a3126" strokeOpacity=".55"/>)}
    <rect x="20" y="144" width="600" height="140" rx="4" fill="var(--tp-amp)" stroke="#0d0b09"/>
    <rect x="26" y="150" width="588" height="128" rx="2" fill="none" stroke="var(--tp-amp-ink)" strokeOpacity=".4"/>
    {[[34,158],[606,158],[34,270],[606,270]].map(([x,y])=><g key={`${x}${y}`}><circle cx={x} cy={y} r="5" fill="var(--tp-amp-ink)" fillOpacity=".7"/><path d={`M${x-3} ${y}h6`} stroke="var(--tp-amp)" strokeWidth="1.2"/></g>)}
    <text x="320" y="172" textAnchor="middle" className="rig-amp-model">{model.toUpperCase()}</text>
    <rect x="72" y="298" width="40" height="2" fill="#0d0b09"/><rect x="528" y="298" width="40" height="2" fill="#0d0b09"/>
  </svg>;
}

/** The mic's four placements over a speaker, as proportions of the picture: the real engine has these four and nothing finer. */
export const micSpots:Record<'close'|'standard'|'edge'|'room',{x:number;y:number}>={close:{x:50,y:50},standard:{x:66,y:50},edge:{x:84,y:50},room:{x:50,y:90}};
/** A cabinet front with one speaker. The placement spots are real buttons laid over it. */
export function CabinetArt() {
  return <svg className="rig-cab-art" viewBox="0 0 268 268" aria-hidden="true" focusable="false">
    <rect x="1" y="1" width="266" height="266" rx="6" fill="#191613" stroke="#0d0b09" strokeWidth="2"/>
    <rect x="10" y="10" width="248" height="248" rx="3" fill="#2A241C"/>
    {Array.from({length:24},(_,i)=><line key={i} x1="10" x2="258" y1={20+i*10} y2={20+i*10} stroke="#0d0b09" strokeOpacity=".35"/>)}
    <circle cx="134" cy="134" r="104" fill="#0D0C0A" stroke="var(--tp-line-subtle)" strokeWidth="2"/>
    <circle cx="134" cy="134" r="84" fill="none" stroke="var(--tp-line-subtle)" strokeWidth="2"/>
    <circle cx="134" cy="134" r="58" fill="none" stroke="var(--tp-line-subtle)" strokeOpacity=".6"/>
    <circle cx="134" cy="134" r="30" fill="var(--tp-raised)"/><circle cx="134" cy="134" r="12" fill="var(--tp-base)"/>
    {[[22,22],[246,22],[22,246],[246,246]].map(([x,y])=><circle key={`${x}${y}`} cx={x} cy={y} r="3.5" fill="#0d0b09"/>)}
  </svg>;
}
