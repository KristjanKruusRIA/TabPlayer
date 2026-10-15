import { model } from '@coderline/alphatab';
import type { ChordDiagramPreviewProps,HarmonyChord } from '../editor/harmony-types';

const noteNames=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
export const harmonyPitchName=(pitch:number)=>`${noteNames[((pitch%12)+12)%12]}${Math.floor(pitch/12)-1}`;
export function soundingChordPitches(chord:HarmonyChord,staff:model.Staff):Array<number|null> {
  const bar=new model.Bar(),voice=new model.Voice(),beat=new model.Beat(),note=new model.Note();bar.staff=staff;voice.bar=bar;beat.voice=voice;note.beat=beat;
  return chord.frets.map((fret,index)=>{
    if(fret<0||staff.isPercussion||staff.tuning.length!==chord.frets.length)return null;
    note.string=chord.frets.length-index;note.fret=fret;const pitch=note.realValue;return Number.isInteger(pitch)&&pitch>=0&&pitch<=127?pitch:null;
  });
}
export function ChordDiagramPreview({chord,staff,highlightRoot,onToggle}:ChordDiagramPreviewProps) {
  if(chord.frets.length===0)return <p className="muted">Name-only chord; no strings.</p>;
  const pitches=soundingChordPitches(chord,staff),first=Math.max(1,chord.firstFret),rows=[...new Set([...Array.from({length:Math.min(5,128-first)},(_,i)=>first+i),...chord.frets.filter(fret=>fret>0)])].sort((a,b)=>a-b);
  const width=Math.max(140,chord.frets.length*40+40),height=rows.length*30+80,root=chord.recipe?(([0,2,4,5,7,9,11][chord.recipe.root.step]+chord.recipe.root.alteration+12)%12):null;
  const label=(index:number,fret:number)=>{
    if(fret<0)return `String ${index+1} muted`;
    const candidate={...chord,frets:chord.frets.map((value,i)=>i===index?fret:value)},pitch=soundingChordPitches(candidate,staff)[index];
    return `String ${index+1} ${fret===0?'open':`fret ${fret}`}: ${pitch===null?'unavailable':harmonyPitchName(pitch)}${highlightRoot&&pitch!==null&&pitch%12===root?', root':''}`;
  };
  return <figure style={{margin:0}}><svg role="group" aria-label="Chord diagram preview" viewBox={`0 0 ${width} ${height}`} style={{width:'100%',background:'#fffdf8',borderRadius:6,color:'#161c24'}}>
    <text x={8} y={16} fill="currentColor" fontSize={11}>First fret {chord.firstFret}</text>
    {rows.map((fret,row)=><g key={fret}><line x1={32} x2={width-16} y1={55+row*30} y2={55+row*30} stroke="#97a6b6"/><text x={8} y={62+row*30} fill="currentColor" fontSize={11}>{fret}</text></g>)}
    {chord.frets.map((current,index)=>{
      const x=40+index*40;
      return <g key={index}><line x1={x} x2={x} y1={40} y2={height-25} stroke="#465363"/>
        {current<0&&<text x={x} y={36} textAnchor="middle" aria-label={label(index,-1)} fill="currentColor">×</text>}
        {[0,...rows].map(fret=>{
          const selected=current===fret,y=fret===0?29:70+rows.indexOf(fret)*30,pitch=selected?pitches[index]:null,isRoot=highlightRoot&&pitch!==null&&pitch%12===root;
          if(!selected&&!onToggle)return null;
          return <g key={fret} role={onToggle?'button':undefined} tabIndex={onToggle?0:undefined} aria-label={label(index,fret)} onClick={onToggle?()=>onToggle(index,fret):undefined} onKeyDown={onToggle?event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();onToggle(index,fret);}}:undefined} style={{cursor:onToggle?'pointer':undefined}}>
            <circle cx={x} cy={y} r={12} fill={selected?(isRoot?'#b5df73':'#1d2530'):'transparent'} stroke={selected?'#465363':'transparent'}/>
            {selected&&<text x={x} y={y+4} textAnchor="middle" fill={isRoot?'#161c24':'#fffdf8'} fontSize={10}>{chord.showFingering&&chord.fingers[index]>=0?(chord.fingers[index]===0?'T':chord.fingers[index]):fret===0?'O':'●'}</text>}
          </g>;
        })}
        <text x={x} y={height-7} textAnchor="middle" fill="currentColor" fontSize={10}>{pitches[index]===null?'×':harmonyPitchName(pitches[index])}</text>
      </g>;
    })}
    {chord.barreFrets.map((fret,index)=>{const positions=chord.frets.flatMap((value,i)=>value>=fret?[i]:[]),row=rows.indexOf(fret);return row<0||positions.length<2?null:<line key={index} x1={40+positions[0]*40} x2={40+positions.at(-1)!*40} y1={70+row*30} y2={70+row*30} stroke="#465363" strokeWidth={4} opacity={.5}/>;})}
  </svg><figcaption className="muted">Sounding pitches · capo {staff.capo} · sounding offset {staff.transpositionPitch}. Strings run high to low in diagram order.{!chord.showDiagram?' Diagram hidden in score.':''}</figcaption></figure>;
}
