import { useId, useMemo, useState, type ReactNode } from 'react';
import type { model } from '@coderline/alphatab';
import type { PlanNote } from '../audio/types';
import { formatPitch } from '../tuning';
import './instruments.css';

export interface InstrumentViewProps {
  score: model.Score; track: number; staff: number; notes: readonly PlanNote[];
  /** Names the list of shown notes; it describes sounding notes by default. */
  caption?: string; empty?: string;
  /** Extra controls placed before the view mode. */
  controls?: ReactNode;
}
type InstrumentMode = 'auto' | 'guitar' | 'bass' | 'drums' | 'keys';
type FretPosition = { note: PlanNote; string: number; fret: number };
const blackKeys = new Set([1,3,6,8,10]);
const percussionNames = [
  'Acoustic bass drum','Bass drum','Side stick','Acoustic snare','Hand clap','Electric snare','Low floor tom','Closed hi-hat','High floor tom','Pedal hi-hat','Low tom','Open hi-hat','Low-mid tom','Hi-mid tom','Crash cymbal 1','High tom','Ride cymbal 1','Chinese cymbal','Ride bell','Tambourine','Splash cymbal','Cowbell','Crash cymbal 2','Vibraslap','Ride cymbal 2','Hi bongo','Low bongo','Mute hi conga','Open hi conga','Low conga','High timbale','Low timbale','High agogo','Low agogo','Cabasa','Maracas','Short whistle','Long whistle','Short guiro','Long guiro','Claves','Hi wood block','Low wood block','Mute cuica','Open cuica','Mute triangle','Open triangle',
];
const drumPieces = [
  {id:'kick',label:'Kick',keys:[35,36],x:415,y:148,r:57},
  {id:'snare',label:'Snare',keys:[37,38,40],x:270,y:154,r:39},
  {id:'floor-tom',label:'Floor tom',keys:[41,43],x:594,y:143,r:48},
  {id:'low-tom',label:'Low tom',keys:[45,47],x:411,y:70,r:35},
  {id:'high-tom',label:'High tom',keys:[48,50],x:321,y:64,r:32},
  {id:'hi-hat',label:'Hi-hat',keys:[42,44,46],x:157,y:117,r:40},
  {id:'crash',label:'Crash',keys:[49,57],x:215,y:33,r:61},
  {id:'ride',label:'Ride',keys:[51,53,59],x:566,y:38,r:66},
  {id:'china',label:'China',keys:[52],x:713,y:99,r:54},
  {id:'splash',label:'Splash',keys:[55],x:104,y:42,r:33},
];
const percussionName = (key: number) => percussionNames[key-35] ?? `Percussion ${formatPitch(key)} (${key})`;

function Fretboard({staff, notes, mode}: {staff: model.Staff; notes: readonly PlanNote[]; mode: 'guitar' | 'bass'}) {
  const id=useId();
  if (!staff.tuning.length) return <p className="instrument-empty">No string tuning on this staff. Choose Keys to view its pitches.</p>;
  const positions: FretPosition[] = [];
  for (const note of notes) {
    if (note.source.target.staff !== staff.index) continue;
    const {target,string} = note.source, beat = staff.bars[target.bar]?.voices[target.voice]?.beats[target.beat];
    const source = beat?.notes.find(n => n.string === string);
    if (string < 1 || string > staff.tuning.length || (!source && !beat?.deadSlapped)) continue;
    // Trills and ornaments retain their source string; harmonics retain their
    // authored touch position rather than moving to a guessed sounding fret.
    const fret = beat?.deadSlapped ? 0 : source!.fret + (source!.harmonicType === 0 ? note.key - source!.realValue : 0);
    if (fret >= 0) positions.push({note,string,fret});
  }
  const maxFret = Math.max(24,...positions.map(p => Math.ceil(p.fret))), left = 64, neckLength=770, height=226;
  const neckHeight=Math.max(55,mode==='bass'?65+(staff.tuning.length-4)*10:65+(staff.tuning.length-6)*6),row=(neckHeight-26)/Math.max(1,staff.tuning.length-1);
  const top=(height-(staff.tuning.length-1)*row)/2, body=left+neckLength-6, width=body+254;
  const boundary=(fret:number)=>left+neckLength*(1-2**(-fret/12))/(1-2**(-maxFret/12));
  const position=(fret:number)=>fret===0?left-17:(boundary(fret-1)+boundary(fret))/2;
  const wood=`url(#${id}-wood)`,metal=`url(#${id}-metal)`,cream=`url(#${id}-cream)`;
  return <>
    <p className="instrument-detail">Staff {staff.index+1} · {staff.tuning.length} strings · Capo {staff.capo}{staff.capo ? ' · fret numbers relative to capo' : ''} · Open {staff.tuning.map(pitch=>formatPitch(pitch+staff.capo-staff.transpositionPitch)).join(' ')}</p>
    <div className="instrument-canvas instrument-fretboard"><svg role="img" aria-label={`${mode === 'bass' ? 'Bass' : 'Guitar'} fretboard`} viewBox={`0 0 ${width} ${height}`}>
      <title>{`${mode === 'bass' ? 'Bass' : 'Guitar'} fretboard`}</title>
      <defs>
        <linearGradient id={`${id}-wood`} x1="0" y1="0" x2="0" y2="1"><stop stopColor="#28130d"/><stop offset=".18" stopColor="#6a3822"/><stop offset=".52" stopColor="#824b31"/><stop offset=".83" stopColor="#512817"/><stop offset="1" stopColor="#25160f"/></linearGradient>
        <linearGradient id={`${id}-metal`} x1="0" y1="0" x2="1" y2="0"><stop stopColor="#52565a"/><stop offset=".3" stopColor="#e5e7e9"/><stop offset=".55" stopColor="#b6bec3"/><stop offset=".7" stopColor="#f7f8f6"/><stop offset="1" stopColor="#676c71"/></linearGradient>
        <linearGradient id={`${id}-cream`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#a19d8e"/><stop offset=".1" stopColor="#fffbed"/><stop offset=".46" stopColor="#e1dac3"/><stop offset=".74" stopColor="#fffbed"/><stop offset="1" stopColor="#ada898"/></linearGradient>
        <linearGradient id={`${id}-string`} x1="0" y1="0" x2="0" y2="1"><stop stopColor="#c7c3b8"/><stop offset=".45" stopColor="#fffefa"/><stop offset="1" stopColor="#686965"/></linearGradient>
        <pattern id={`${id}-grain`} patternUnits="userSpaceOnUse" width="190" height="24"><path d="M0 2C48 7 120-2 190 4M0 9C55 1 116 19 190 11M0 16C84 8 109 25 190 16M0 23C74 29 105 12 190 22" fill="none" stroke="#1c0a03" strokeWidth=".7" opacity=".4"/><path d="M0 6C70 15 120 4 190 8M0 20C40 12 125 27 190 21" fill="none" stroke="#d5a875" strokeWidth=".6" opacity=".25"/></pattern>
        <pattern id={`${id}-tortoise`} patternUnits="userSpaceOnUse" width="19" height="23"><rect width="19" height="23" fill="#281510"/><path d="M1 4L8 1 11 8 6 11ZM8 15L15 10 19 17 13 22Z" fill="#853c21"/><path d="M3 14L7 12 9 19 4 21ZM11 2L18 4 16 9 12 7Z" fill="#b56636" opacity=".6"/></pattern>
      </defs>
      <ellipse cx={body+113} cy="209" rx="119" ry="12" fill="#000" opacity=".35"/>
      <g data-instrument-part="body" transform={`translate(${body},113)`}>
        <path d="M7-45C29-42 17-79 37-89C72-113 112-91 150-83C184-97 213-93 231-70C249-47 248-19 235 4C253 39 247 75 225 96C194 122 151 104 113 108C66 114 14 102-2 70C-20 42 31 22 43 2C57-24 31-24 7-45Z" fill={cream} stroke="#827c6f" strokeWidth="2"/>
        <path d="M11-44C31-45 22-76 40-86M26 93C76 114 135 98 172 106C200 110 220 95 230 79" fill="none" stroke="#fffbed" strokeWidth="2.5" opacity=".65"/>
        <path d="M17-43C39-40 38-16 55-12L167-24C190-4 194 20 184 46L154 78L58 83C24 75 35 47 55 29C78 9 43-10 17-43Z" fill={`url(#${id}-tortoise)`} stroke="#d0c9b7" strokeWidth="2"/>
        {[[-0,-40],[174,-12],[183,40],[147,78],[56,76]].map(([x,y],index)=><g key={index}><circle cx={x} cy={y} r="2.3" fill={metal}/><path d={`M${x-1.5} ${y}h3`} stroke="#53504a" strokeWidth=".6"/></g>)}
        {[0,1].map(index=><g key={index} transform={`translate(${173+index*21},${58-index*24})`}><circle r="10" fill={cream} stroke="#857f72"/><circle r="6" fill="#eee8d7" stroke="#d4cbb8"/><path d="M0-8V-4" stroke="#5d625f" strokeWidth="1.3"/></g>)}
        <path d="M200 38L218 30Q230 40 224 51L207 57Z" fill={metal} stroke="#62676a"/><ellipse cx="216" cy="42" rx="4" ry="6" fill="#252b2b"/>
      </g>
      <g data-instrument-part="neck"><rect x={left} y={top-15} width={neckLength+34} height={neckHeight+4} rx="2" fill="#b69c73" stroke="#51412f"/><rect x={left} y={top-12} width={neckLength+34} height={neckHeight-2} fill={wood}/><rect x={left} y={top-12} width={neckLength+34} height={neckHeight-2} fill={`url(#${id}-grain)`}/><path d={`M${left} ${top-12}H${body+34}M${left} ${top+neckHeight-14}H${body+34}`} stroke="#ba8d68" strokeWidth="1" opacity=".6"/></g>
      {Array.from({length:maxFret+1},(_,fret)=><g key={fret} data-fret-column={fret}><text className="fret-number" x={position(fret)} y={top-22} textAnchor="middle">{fret===0?'OPEN':fret}</text><line data-fret-boundary={fret} x1={boundary(fret)} x2={boundary(fret)} y1={top-12} y2={top+neckHeight-14} stroke={fret===0?'#e8dcc5':'#131711'} strokeWidth={fret===0?5:3}/>{fret>0?<rect x={boundary(fret)-1} y={top-12} width="2" height={neckHeight-2} fill={metal}/>:null}</g>)}
      {[3,5,7,9,12,15,17,19,21,24].filter(fret=>fret<=maxFret).flatMap(fret=>(fret%12===0?[-neckHeight*.2,neckHeight*.2]:[0]).map((offset,index)=><circle key={`${fret}/${index}`} cx={position(fret)} cy={height/2+offset} r="3.5" fill="#e8e0c6" stroke="#b7ae95" strokeWidth=".7"/>))}
      <g data-instrument-part="bridge"><rect x={body+144} y={top-11} width="36" height={neckHeight-4} rx="3" fill={metal} stroke="#4a4a43"/>{staff.tuning.map((_,index)=><g key={index}><rect x={body+147} y={top+index*row-5} width="25" height="10" rx="2" fill={metal} stroke="#6a6c66"/><circle cx={body+176} cy={top+index*row} r="2" fill="#343933"/></g>)}</g>
      {[40,91].map((offset,pickup)=><g key={offset} data-instrument-part={pickup===0?'neck-pickup':'bridge-pickup'}><rect x={body+offset-9} y={top-11} width="19" height={neckHeight-4} rx="8" fill="#eee7d2" stroke="#7e7a6e"/>{staff.tuning.map((_,index)=><circle data-pickup-string={staff.tuning.length-index} key={index} cx={body+offset} cy={top+index*row} r="2.5" fill={metal} stroke="#5c5b56" strokeWidth=".7"/>)}</g>)}
      {staff.tuning.map((pitch,index)=>{
        const string = staff.tuning.length-index, y = top+index*row;
        return <g key={string} data-string-row={string}><title>{`String ${string} · ${formatPitch(pitch+staff.capo-staff.transpositionPitch)}`}</title><line x1={left-31} x2={body+176} y1={y+1.2} y2={y+1.2} stroke="#160e08" opacity=".65" strokeWidth={1+index*.17}/><rect x={left-31} y={y-(.7+index*.16)/2} width={body+207-left} height={.7+index*.16} fill={`url(#${id}-string)`}/></g>;
      })}
      {positions.map(({note,string,fret})=><g key={note.id} className="fret-note" data-note-id={note.id} data-string={string} data-fret={fret} data-key={note.key}>
        <circle className="fret-note-halo" cx={position(fret)} cy={top+(staff.tuning.length-string)*row} r="4.6"/><circle cx={position(fret)} cy={top+(staff.tuning.length-string)*row} r="3.2"/><title>{`${formatPitch(note.key)} · string ${string} · fret ${fret}`}</title>
      </g>)}
    </svg></div>
  </>;
}

function Keyboard({track,notes,compact}: {track: model.Track; notes: readonly PlanNote[]; compact:boolean}) {
  const id=useId();
  const sourceRange = useMemo(()=>{
    let low=128,high=-1;
    for (const staff of track.staves) for (const bar of staff.bars) for (const voice of bar.voices) for (const beat of voice.beats) for (const note of beat.notes) {
      if (staff.isPercussion) continue;
      const key=note.realValue; low=Math.min(low,key); high=Math.max(high,key);
    }
    return high<low ? [48,83] : [low,high];
  },[track]);
  const active = new Set(notes.map(note=>note.key)), low = Math.max(0,Math.floor(Math.min(sourceRange[0],...active)/12)*12), high = Math.min(127,Math.max(low+35,Math.ceil((Math.max(sourceRange[1],...active)+1)/12)*12-1));
  const white: {key:number;x:number}[] = [], black: {key:number;x:number}[] = [], keyWidth = 28;
  for (let key=low;key<=high;key++) {
    if (blackKeys.has(key%12)) black.push({key,x:white.length*keyWidth-8}); else white.push({key,x:white.length*keyWidth});
  }
  return <div className="instrument-canvas instrument-keyboard"><svg role="img" aria-label="Keyboard" viewBox={`0 0 ${white.length*keyWidth} 125`} style={{minWidth:white.length*keyWidth*(compact?80/125:1)}}>
    <title>{`Keyboard · sounding pitches ${formatPitch(low)} to ${formatPitch(high)}`}</title>
    <defs><linearGradient id={`${id}-ivory`} x1="0" y1="0" x2="0" y2="1"><stop stopColor="#bcbcb3"/><stop offset=".12" stopColor="#fffef7"/><stop offset=".85" stopColor="#f0eddf"/><stop offset="1" stopColor="#bfbcae"/></linearGradient><linearGradient id={`${id}-ebony`} x1="0" y1="0" x2=".7" y2="1"><stop stopColor="#111519"/><stop offset=".3" stopColor="#42494e"/><stop offset=".78" stopColor="#20262b"/><stop offset="1" stopColor="#090c0e"/></linearGradient></defs>
    <rect width={white.length*keyWidth} height="125" rx="4" fill="#090e12"/><path d={`M0 5H${white.length*keyWidth}`} stroke="#4d5459" strokeWidth="2"/>
    {white.map(({key,x})=><g key={key} data-key={key} data-key-color="white" data-active={active.has(key)} className={`piano-key white${active.has(key)?' active':''}`}><rect x={x+1} y="9" width={keyWidth-2} height="110" rx="3" fill={`url(#${id}-ivory)`}/><path d={`M${x+3} 113H${x+keyWidth-3}`} stroke="#fffff8" strokeWidth="2" opacity=".7"/>{active.has(key)?<rect className="key-hit" x={x+3} y="88" width={keyWidth-6} height="27" rx="3"/>:null}<text x={x+keyWidth/2} y="107" textAnchor="middle">{active.has(key)||key%12===0?formatPitch(key):''}</text><title>{formatPitch(key)}</title></g>)}
    {black.map(({key,x})=><g key={key} data-key={key} data-key-color="black" data-active={active.has(key)} className={`piano-key black${active.has(key)?' active':''}`}><rect x={x} y="8" width="16" height="69" rx="3" fill={`url(#${id}-ebony)`}/><path d={`M${x+2} 11V67M${x+3} 73H${x+13}`} stroke="#626a6e" strokeWidth=".7"/>{active.has(key)?<rect className="key-hit" x={x+2} y="53" width="12" height="19" rx="2"/>:null}<text x={x+8} y="66" textAnchor="middle">{active.has(key)?formatPitch(key):''}</text><title>{formatPitch(key)}</title></g>)}
  </svg></div>;
}

function DrumKit({notes}: {notes: readonly PlanNote[]}) {
  const id=useId();
  const keys = new Set(notes.map(note=>note.key)), kitKeys = new Set(drumPieces.flatMap(piece=>piece.keys)), auxiliary = [...keys].filter(key=>!kitKeys.has(key));
  return <>
    <div className="instrument-canvas instrument-drums"><svg role="img" aria-label="Drum kit" viewBox="0 0 860 242">
      <title>Drum kit · active percussion</title>
      <defs>
        <linearGradient id={`${id}-shell`}><stop stopColor="#4e090d"/><stop offset=".18" stopColor="#b5202b"/><stop offset=".43" stopColor="#e34240"/><stop offset=".64" stopColor="#9a1621"/><stop offset="1" stopColor="#3d090d"/></linearGradient>
        <radialGradient id={`${id}-head`} cx=".42" cy=".25" r=".8"><stop stopColor="#fffdf3"/><stop offset=".65" stopColor="#e0e0d6"/><stop offset="1" stopColor="#a8aca6"/></radialGradient>
        <radialGradient id={`${id}-brass`} cx=".47" cy=".35" r=".62"><stop stopColor="#fff6cd"/><stop offset=".13" stopColor="#b49b5f"/><stop offset=".37" stopColor="#e0c37d"/><stop offset=".63" stopColor="#a78a45"/><stop offset=".82" stopColor="#e6cc8c"/><stop offset="1" stopColor="#76602d"/></radialGradient>
        <linearGradient id={`${id}-chrome`}><stop stopColor="#545a5f"/><stop offset=".35" stopColor="#f4f5ef"/><stop offset=".55" stopColor="#8e999e"/><stop offset=".8" stopColor="#e0e5e4"/><stop offset="1" stopColor="#444c50"/></linearGradient>
      </defs>
      <ellipse cx="431" cy="217" rx="300" ry="18" fill="#000" opacity=".35"/>
      <g className="kit-stands">{drumPieces.filter(piece=>['hi-hat','crash','ride','china','splash'].includes(piece.id)).map(piece=><g key={piece.id}><path d={`M${piece.x} ${piece.y}V213M${piece.x} 186L${piece.x-25} 222M${piece.x} 186L${piece.x+27} 223M${piece.x} 186L${piece.x+3} 226`} fill="none" stroke="#48535a" strokeWidth="5"/><path d={`M${piece.x} ${piece.y}V213M${piece.x} 186L${piece.x-25} 222M${piece.x} 186L${piece.x+27} 223M${piece.x} 186L${piece.x+3} 226`} fill="none" stroke="#b7c0c3" strokeWidth="2"/><circle cx={piece.x} cy="167" r="3" fill="#e4e7e4"/></g>)}</g>
      {[...drumPieces].sort((a,b)=>a.y-b.y).map(piece=>{
        const active=piece.keys.some(key=>keys.has(key)), cymbal=['hi-hat','crash','ride','china','splash'].includes(piece.id);
        const r=piece.r,ry=r*.43,shellHeight=piece.id==='floor-tom'?55:piece.id==='snare'?20:32;
        return <g key={piece.id} data-drum={piece.id} data-active={active} className={`drum-piece${cymbal?' cymbal':''}${active?' active':''}`} transform={`translate(${piece.x},${piece.y})`}>
          <title>{`${piece.label}${active?` · ${piece.keys.filter(key=>keys.has(key)).map(percussionName).join(', ')}`:''}`}</title>
          {cymbal ? <>
            <ellipse data-drum-surface="cymbal" cx="0" cy="0" rx={r} ry={ry} fill={`url(#${id}-brass)`} stroke="#948151" strokeWidth="1.5"/>
            {[.3,.5,.7,.88].map(scale=><ellipse key={scale} cx="0" cy="0" rx={r*scale} ry={ry*scale} fill="none" stroke="#77642d" strokeWidth=".55" opacity=".4"/>)}
            <path d={`M${-r*.8} ${-ry*.27}Q0 ${-ry*1.1} ${r*.8} ${-ry*.15}`} fill="none" stroke="#fff4c4" strokeWidth="2" opacity=".35"/>
            <ellipse cx="0" cy="-2" rx={r*.13} ry={ry*.3} fill="#dfc786" stroke="#8d773e"/><ellipse cx="0" cy="-5" rx="3.5" ry="2" fill="#28251c"/>
            {active?<ellipse className="drum-hit" cx="0" cy="0" rx={r-2} ry={ry-1}/>:null}
            <text className="drum-label" x="0" y={ry+14} textAnchor="middle">{piece.label}</text>
          </> : piece.id==='kick' ? <>
            <ellipse cx="8" cy="4" rx={r+6} ry={r*.9} fill={`url(#${id}-shell)`} stroke="#747d80" strokeWidth="3"/>
            <circle data-drum-surface="head" cx="0" cy="0" r={r} fill={`url(#${id}-head)`} stroke={`url(#${id}-chrome)`} strokeWidth="5"/>
            <circle cx="0" cy="0" r={r-5} fill="none" stroke="#828e8c" strokeWidth="1.5"/>
            {Array.from({length:10},(_,index)=>{const angle=index*Math.PI/5;return <circle key={index} cx={Math.cos(angle)*(r-1)} cy={Math.sin(angle)*(r-1)} r="2.5" fill={`url(#${id}-chrome)`} stroke="#657174"/>;})}
            <circle cx={r*.5} cy={r*.37} r="10" fill="#151a1d" stroke="#777e79"/>
            <path d={`M${-r*.8} ${r*.5}l-15 29M${r*.8} ${r*.5}l16 29`} stroke="#b1babd" strokeWidth="4" fill="none"/>
            <g data-drum-surface="pedal"><path d={`M-10 ${r+28}L-7 ${r-4}H8L12 ${r+28}Z`} fill={`url(#${id}-chrome)`} stroke="#576267" strokeWidth="1.5"/><path d={`M-6 ${r+25}L-4 ${r+1}H5L8 ${r+25}Z`} fill="#27343b"/>{[7,12,17,22].map(y=><path key={y} d={`M-3 ${r+y}H6`} stroke="#717d7f" strokeWidth="1.5"/>)}<path d={`M0 ${r}V${r-27}`} stroke="#c1c9c8" strokeWidth="3"/><circle cx="0" cy={r-30} r="5" fill="#e2dbbd"/></g>
            {active?<circle className="drum-hit" cx="0" cy="0" r={r-5}/>:null}
            <text className="drum-label on-head" x="0" y="3" textAnchor="middle">{piece.label}</text>
          </> : <>
            <path d={`M${-r*.75} ${shellHeight}l-8 ${224-piece.y-shellHeight}M${r*.75} ${shellHeight}l8 ${224-piece.y-shellHeight}`} stroke="#89979b" strokeWidth="3" fill="none"/>
            <ellipse cx="0" cy={shellHeight} rx={r} ry={ry} fill={`url(#${id}-shell)`} stroke="#69777a" strokeWidth="3"/>
            <path data-drum-surface="shell" d={`M${-r} 0V${shellHeight}C${-r} ${shellHeight+ry} ${r} ${shellHeight+ry} ${r} ${shellHeight}V0Z`} fill={`url(#${id}-shell)`}/>
            <path d={`M${-r} ${shellHeight}C${-r} ${shellHeight+ry} ${r} ${shellHeight+ry} ${r} ${shellHeight}`} fill="none" stroke="#adb8b9" strokeWidth="2.5"/>
            {[-.82,-.45,0,.45,.82].map(fraction=>{const x=r*fraction,y=ry*Math.sqrt(1-fraction*fraction);return <g key={fraction}><path d={`M${x} ${y+1}v${shellHeight-3}`} stroke="#bec6c5" strokeWidth="2"/><rect x={x-2.5} y={y+shellHeight-8} width="5" height="7" rx="1" fill={`url(#${id}-chrome)`}/></g>;})}
            <ellipse data-drum-surface="head" cx="0" cy="0" rx={r} ry={ry} fill={`url(#${id}-head)`} stroke={`url(#${id}-chrome)`} strokeWidth="3"/>
            <ellipse cx="0" cy="0" rx={r-4} ry={ry-2} fill="none" stroke="#86948f" strokeWidth=".8"/>
            {active?<ellipse className="drum-hit" cx="0" cy="0" rx={r-3} ry={ry-2}/>:null}
            <text className="drum-label on-head" x="0" y="3" textAnchor="middle">{piece.label}</text>
          </>}
        </g>;
      })}
    </svg></div>
    {auxiliary.length>0 ? <div className="instrument-percussion-pads" aria-label="Additional percussion">{auxiliary.map(key=><span className="percussion-pad" data-percussion-key={key} data-active="true" key={key}>{percussionName(key)}</span>)}</div> : null}
  </>;
}

export function InstrumentView({score,track:trackIndex,staff:staffIndex,notes,caption='Sounding notes',empty='No notes sounding',controls}: InstrumentViewProps) {
  const [requestedMode,setMode] = useState<InstrumentMode>('auto'), track = score.tracks[trackIndex], staff = track.staves[staffIndex];
  const [expanded,setExpanded] = useState(false);
  const automatic: Exclude<InstrumentMode,'auto'> = staff.isPercussion ? 'drums' : track.playbackInfo.program>=24 && track.playbackInfo.program<=31 ? 'guitar' : track.playbackInfo.program>=32 && track.playbackInfo.program<=39 ? 'bass' : 'keys';
  const mode = requestedMode==='auto' ? automatic : requestedMode, active = notes.filter(note=>note.source.target.track===trackIndex);
  const labels = [...new Set(active.map(note=>mode==='drums'?percussionName(note.key):formatPitch(note.key)))];
  return <div className="instrument-view" data-size={expanded?'expanded':'compact'}>
    <div className="instrument-header"><h3>{track.name}<span> · {mode==='keys'?'Keys':mode[0].toUpperCase()+mode.slice(1)}</span></h3><div className="instrument-controls">{controls}<label>Instrument view mode<select value={requestedMode} onChange={event=>setMode(event.target.value as InstrumentMode)}><option value="auto">Auto</option><option value="guitar">Guitar</option><option value="bass">Bass</option><option value="drums">Drums</option><option value="keys">Keys</option></select></label><button type="button" aria-label={expanded?'Compact instrument view':'Expand instrument view'} aria-expanded={expanded} onClick={()=>setExpanded(value=>!value)}>{expanded?'Compact':'Expand'}</button></div></div>
    {mode==='guitar'||mode==='bass' ? <Fretboard staff={staff} notes={active} mode={mode}/> : mode==='drums' ? <DrumKit notes={active}/> : <Keyboard track={track} notes={active} compact={!expanded}/>}
    <div className="instrument-playing" role="group" aria-label={caption}>{labels.length ? labels.map(label=><span className="instrument-note" key={label}>{label}</span>) : <span className="instrument-empty">{empty}</span>}</div>
  </div>;
}
