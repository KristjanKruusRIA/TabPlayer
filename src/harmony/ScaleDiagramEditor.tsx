import { busyGuard } from '../ui/useBusyGuard';
import { useEffect,useState } from 'react';
import type { model } from '@coderline/alphatab';
import type { BeatTarget } from '../project';
import type { MusicSelection } from '../editor/range-types';
import { ScaleDiagramView } from './ScaleDiagramView';
import {
  blankScaleDiagram,defaultMarkColor,defaultTextColor,getScaleDiagram,markAt,newMark,resized,scaleDiagramFromPitchClasses,sameScaleDiagram,scaleDiagramFromSelection,scaleMarkShapes,
  validateScaleDiagram,withMark,withoutMark,type ScaleDiagram,type ScaleDiagramCommand,type ScaleMark,type ScaleMarkShape,
} from './scale-diagram';
import { Segmented } from '../ui/Segmented';

export interface ScaleDiagramEditorProps {
  score:model.Score;staff?:model.Staff;beat?:model.Beat;target:BeatTarget|null;selection:MusicSelection|null;busy:boolean;
  /** The scale currently chosen in the browser, used to lay out a diagram over the fretboard. */
  scale:{root:number;classes:ReadonlySet<number>;name:string}|null;
  onEdit:(command:ScaleDiagramCommand)=>void;
}
const same=sameScaleDiagram;
const shapeOptions=scaleMarkShapes.map(value=>({value,label:value}));
const orientationOptions:ReadonlyArray<{value:ScaleDiagram['orientation'];label:string}>=[
  {value:'horizontal',label:'Horizontal'},
  {value:'vertical',label:'Vertical'},
];
/** Commits a typed number on blur or Enter, so "10" is never read as "1" on the way. */
function NumberField({label,value,min,max,change}:{label:string;value:number;min:number;max:number;change:(value:number)=>void}) {
  const [text,setText]=useState(String(value));
  useEffect(()=>setText(String(value)),[value]);
  const commit=()=>{const next=Number(text);if(text.trim()!==''&&Number.isInteger(next)){const clamped=Math.min(max,Math.max(min,next));setText(String(clamped));if(clamped!==value)change(clamped);}else setText(String(value));};
  return <label>{label}<input type="number" min={min} max={max} value={text} onChange={event=>setText(event.target.value)} onBlur={commit} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();commit();}}}/></label>;
}
const message=(cause:unknown)=>cause instanceof Error?cause.message:String(cause);

/** Authors the scale diagram on the selected beat: blank, from the selected notes, or from the scale chosen above. */
export function ScaleDiagramEditor({score,staff,beat,target,selection,busy,scale,onEdit}:ScaleDiagramEditorProps) {
  const stored=getScaleDiagram(beat),storedKey=JSON.stringify(stored),beatKey=target?`${target.track}/${target.staff}/${target.bar}/${target.voice}/${target.beat}`:'';
  const [draft,setDraft]=useState<ScaleDiagram|null>(stored),[selected,setSelected]=useState<{string:number;fret:number}|null>(null),[error,setError]=useState('');
  const [shape,setShape]=useState<ScaleMarkShape>('circle'),[color,setColor]=useState(defaultMarkColor),[textColor,setTextColor]=useState(defaultTextColor);
  useEffect(()=>{setDraft(stored);setSelected(null);setError('');},[beatKey,storedKey]);
  const strings=staff?.tuning.length?staff.tuning.length:6,usable=!!target&&!!beat&&!beat.isEmpty&&!staff?.isPercussion,busyOrUnusable=busy||!usable;
  const edit=(change:(value:ScaleDiagram)=>ScaleDiagram)=>{if(draft)setDraft(change(draft));};
  const make=(build:()=>ScaleDiagram)=>{try{setDraft(build());setSelected(null);setError('');}catch(cause){setError(message(cause));}};
  const mark=draft&&selected?markAt(draft,selected.string,selected.fret):undefined;
  const patch=(change:Partial<ScaleMark>)=>{if(draft&&mark)edit(value=>withMark(value,{...mark,...change}));};
  function apply(value:ScaleDiagram|null) {
    if(!target)return;
    try{if(value)validateScaleDiagram(value);onEdit({type:'setScaleDiagram',target,diagram:value});setError('');}catch(cause){setError(message(cause));}
  }
  function cell(string:number,fret:number) {
    if(!draft)return;
    if(!markAt(draft,string,fret))edit(value=>withMark(value,newMark(string,fret,shape,color,'',textColor)));
    setSelected({string,fret});
  }
  return <section aria-label="Scale diagram" className="scale-diagram-editor">
    <h3>Scale diagram</h3>
    {!usable&&<p className="muted">Select a written beat on a stringed or keyboard staff to give it a scale diagram.</p>}
    <p className="muted">{stored?`This beat has a diagram${stored.name?` named “${stored.name}”`:''} with ${stored.marks.length} marks.`:'This beat has no scale diagram.'}</p>
    <div role="group" aria-label="Start a scale diagram">
      <button type="button" {...busyGuard({busy:busy,unavailable:!usable,onClick:()=>make(()=>blankScaleDiagram(strings))})}>Blank diagram</button>
      <button type="button" {...busyGuard({busy:busy,unavailable:!usable||!selection||!staff,onClick:()=>make(()=>scaleDiagramFromSelection(score,selection!,staff!))})}>From selected notes</button>
      <button type="button" {...busyGuard({busy:busy,unavailable:!usable||!scale||!staff,onClick:()=>make(()=>scaleDiagramFromPitchClasses(staff!,scale!.root,scale!.classes,scale!.name))})}>From scale above</button>
    </div>
    {error&&<p role="alert">{error}</p>}
    {draft&&<>
      <label>Diagram name<input value={draft.name} maxLength={64} onChange={event=>edit(value=>({...value,name:event.target.value}))}/></label>
      <NumberField label="Diagram strings" value={draft.strings} min={3} max={10} change={next=>edit(value=>resized(value,{strings:next}))}/>
      <NumberField label="Diagram frets" value={draft.frets} min={4} max={24} change={next=>edit(value=>resized(value,{frets:next}))}/>
      <NumberField label="Starting fret" value={draft.firstFret} min={1} max={128-draft.frets} change={next=>edit(value=>resized(value,{firstFret:next}))}/>
      <div className="tp-field">
        <span className="tp-field-label" aria-hidden="true">Diagram orientation</span>
        <Segmented label="Diagram orientation" value={draft.orientation} options={orientationOptions} onChange={orientation=>edit(value=>({...value,orientation}))}/>
      </div>
      <label><input type="checkbox" checked={draft.showFretMarkers} onChange={event=>edit(value=>({...value,showFretMarkers:event.target.checked}))}/> Show fret markers</label>
      <fieldset><legend>New marks</legend>
        <div className="tp-field">
          <span className="tp-field-label" aria-hidden="true">Default shape</span>
          <Segmented label="Default shape" value={shape} options={shapeOptions} onChange={setShape}/>
        </div>
        <label>Default mark color<input type="color" value={color} onChange={event=>setColor(event.target.value)}/></label>
        <label>Default text color<input type="color" value={textColor} onChange={event=>setTextColor(event.target.value)}/></label>
      </fieldset>
      <p className="muted">Click a position to add a mark, click a mark to edit it, double-click or press Delete to remove it.</p>
      <ScaleDiagramView diagram={draft} selected={selected} onCell={cell} onRemove={(string,fret)=>{edit(value=>withoutMark(value,string,fret));setSelected(null);}}/>
      {mark?<fieldset><legend>{`Mark on string ${mark.string}, ${mark.fret===0?'open':`fret ${mark.fret}`}`}</legend>
        <div className="tp-field">
          <span className="tp-field-label" aria-hidden="true">Mark shape</span>
          <Segmented label="Mark shape" value={mark.shape} options={shapeOptions} onChange={nextShape=>patch({shape:nextShape})}/>
        </div>
        <label>Mark color<input type="color" value={mark.color} onChange={event=>patch({color:event.target.value})}/></label>
        <label>Mark text<input value={mark.text} aria-describedby="scale-mark-text-hint" onChange={event=>patch({text:[...event.target.value].slice(0,3).join('')})}/></label>
        <span id="scale-mark-text-hint" className="muted">Up to 3 characters: a note name or a finger.</span>
        <label>Mark text color<input type="color" value={mark.textColor} onChange={event=>patch({textColor:event.target.value})}/></label>
        <button type="button" onClick={()=>{edit(value=>withoutMark(value,mark.string,mark.fret));setSelected(null);}}>Remove mark</button>
      </fieldset>:<p className="muted">No mark selected.</p>}
      <div role="group" aria-label="Apply scale diagram">
        <button type="button" {...busyGuard({busy:busy,unavailable:!usable||same(draft,stored),onClick:()=>apply(draft)})}>Apply diagram to beat</button>
        <button type="button" {...busyGuard({unavailable:!draft.marks.length,onClick:()=>{edit(value=>({...value,marks:[]}));setSelected(null);}})}>Reset marks</button>
        <button type="button" {...busyGuard({unavailable:same(draft,stored),onClick:()=>{setDraft(stored);setSelected(null);setError('');}})}>Discard changes</button>
      </div>
    </>}
    {stored&&<button type="button" {...busyGuard({busy:busy,unavailable:!usable,onClick:()=>apply(null)})}>Delete diagram from beat</button>}
  </section>;
}
