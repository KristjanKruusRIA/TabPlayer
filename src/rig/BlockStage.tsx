import type { ReactNode } from 'react';
import { defaultEffects, delayDivisions, modulationDivisions, syncedBlocks } from '../document-settings';
import type { EffectBlock } from '../edit-types';
import { ampModels, blockNames, cabinetModels, graphicBands, modelName, parameters } from '../audio/sound-model';
import type { NumericControl } from '../audio/sound-model';
import type { Board, SoundEditing } from '../audio/useSoundEditing';
import { Fader, Knob, Segmented } from '../ui';
import { AmpArt, CabinetArt, PedalArt, micSpots } from './art';
import { blockLook } from './blocks';
import type { BlockRef } from './blocks';

const defaults=defaultEffects() as unknown as Record<string,Record<string,unknown>>;
const capital=(text:string)=>text[0].toUpperCase()+text.slice(1);
/** `Gain (dB)` as the name `Gain` and the unit ` dB`. */
function nameAndUnit(label:string) {
  const match=label.match(/^(.*?)\s*\((.*)\)$/);
  return match?{short:match[1],unit:` ${match[2]}`}:{short:label,unit:''};
}
const settingsOf=(board:Board,block:EffectBlock)=>board.effects[block] as unknown as Record<string,unknown>;

/** The knobs for the numeric fields of a block, with the same accessible names the inspector's fields have. */
function BlockKnobs({editing,board,block,tone}:{editing:SoundEditing;board:Board;block:EffectBlock;tone:'pedal'|'amp'}) {
  const settings=settingsOf(board,block),{fx,syncOf,busy}=editing;
  return <>{parameters[block].map((p:NumericControl)=>{
    const {short,unit}=nameAndUnit(p.label);
    // Switched off by the mode or by following the tempo, as the inspector's fields are.
    const off=block==='wah'&&p.key===(board.effects.wah.mode==='auto'?'position':'sensitivity')||p.key==='rateHz'&&syncOf(board,block)!==0;
    return <Knob key={p.key} tone={tone} label={short} ariaLabel={board.name(`${block} ${p.label}`)} unit={unit} min={p.min} max={p.max} step={p.step} value={Number(settings[p.key]??0)} defaultValue={Number(defaults[block][p.key]??0)} disabled={busy||off} onCommit={value=>fx(board,block,p.key,value)}/>;
  })}</>;
}
function Choice<T extends string|number>({label,value,options,onChange,disabled}:{label:string;value:T;options:readonly (readonly [T,string])[];onChange:(value:T)=>void;disabled:boolean}) {
  return <div className="rig-field"><span className="rig-field-name" aria-hidden="true">{label.replace(/^Second pedalboard: /,'')}</span><Segmented label={label} value={value} options={options.map(([v,text])=>({value:v,label:text}))} onChange={onChange} disabled={disabled}/></div>;
}
function Dropdown({label,visible,value,options,onChange,disabled}:{label:string;visible:string;value:number;options:readonly (readonly [number,string])[];onChange:(value:number)=>void;disabled:boolean}) {
  return <label className="rig-field"><span className="rig-field-name">{visible}</span><select className="rig-select" aria-label={label} value={value} disabled={disabled} onChange={event=>onChange(Number(event.target.value))}>{options.map(([v,text])=><option key={v} value={v}>{text}</option>)}</select></label>;
}
/** The footswitch: switches a block on or off. */
function Footswitch({editing,board,block}:{editing:SoundEditing;board:Board;block:EffectBlock}) {
  const on=board.effects[block].enabled;
  return <button type="button" role="switch" aria-checked={on} aria-label={board.name(`Enable ${block}`)} className="rig-switch" disabled={editing.busy} onClick={()=>editing.fx(board,block,'enabled',!on)}>
    <span className="rig-switch-lamp" aria-hidden="true"/><span className="rig-switch-text" aria-hidden="true">{on?'On':'Bypassed'}</span>
  </button>;
}

/** What each block adds beside its knobs: its models and any tempo sync. */
function BlockOptions({editing,board,block}:{editing:SoundEditing;board:Board;block:EffectBlock}) {
  const {fx,sync,syncOf,busy}=editing,name=board.name,e=board.effects;
  return <>
    {block==='drive'&&<Choice label={name('Drive model')} value={e.drive.model} disabled={busy} onChange={value=>fx(board,'drive','model',value)} options={[['overdrive','Overdrive'],['distortion','Distortion'],['fuzz','Fuzz']]}/>}
    {block==='reverb'&&<Choice label={name('Reverb model')} value={e.reverb.model} disabled={busy} onChange={value=>fx(board,'reverb','model',value)} options={[['room','Room'],['hall','Hall'],['plate','Plate'],['spring','Spring']]}/>}
    {block==='wah'&&<>
      <Choice label={name('Wah model')} value={e.wah.model} disabled={busy} onChange={value=>fx(board,'wah','model',value)} options={[['classic','Classic'],['vintage','Vintage (vocal)'],['wide','Wide range'],['bass','Bass']]}/>
      <Choice label={name('Wah mode')} value={e.wah.mode} disabled={busy} onChange={value=>fx(board,'wah','mode',value)} options={[['manual','Manual pedal'],['auto','Auto (follows playing)']]}/>
    </>}
    {block==='tremolo'&&<Choice label={name('Tremolo shape')} value={e.tremolo.shape} disabled={busy} onChange={value=>fx(board,'tremolo','shape',value)} options={[['sine','Sine'],['square','Square']]}/>}
    {block==='phaser'&&<Choice label={name('Phaser stages')} value={e.phaser.stages} disabled={busy} onChange={value=>fx(board,'phaser','stages',value)} options={[[2,'2'],[4,'4'],[6,'6'],[8,'8']]}/>}
    {block==='delay'&&<>
      <Choice label={name('Delay model')} value={e.delay.model} disabled={busy} onChange={value=>fx(board,'delay','model',value)} options={[['digital','Digital'],['tape','Tape'],['analog','Analog']]}/>
      <Dropdown label={name('Delay time')} visible="Delay time" value={e.delay.quarterNotes} options={delayDivisions} disabled={busy} onChange={value=>fx(board,'delay','quarterNotes',value)}/>
      <p className="rig-note">Delay times are limited to 16 seconds.</p>
    </>}
    {syncedBlocks.includes(block)&&<Dropdown label={name(`${blockNames[block]} tempo sync`)} visible="Tempo sync" value={syncOf(board,block)} options={[[0,'Off (free rate)'],...modulationDivisions]} disabled={busy} onChange={value=>sync(board,block,value)}/>}
  </>;
}

function AmpStage({editing,board}:{editing:SoundEditing;board:Board}) {
  const model=board.effects.amp.model;
  return <div className="rig-amp-stage">
    <Choice label={board.name('Amp model')} value={model} disabled={editing.busy} onChange={value=>editing.fx(board,'amp','model',value)} options={ampModels.map(item=>[item,capital(modelName(item))] as const)}/>
    <div className="rig-art-slot"><div className="rig-amp" data-on={board.effects.amp.enabled}>
      <AmpArt model={modelName(model)}/>
      <div className="rig-amp-knobs"><BlockKnobs editing={editing} board={board} block="amp" tone="amp"/></div>
    </div></div>
  </div>;
}

/** The four placements as spots over a speaker, the model of cabinet and the mic's output. The microphone is its own block, so a
 * cabinet's stage offers its switch too. */
function CabinetStage({editing,board,block,cabinetResponse}:{editing:SoundEditing;board:Board;block:'cabinet'|'microphone';cabinetResponse?:ReactNode}) {
  const {fx,busy}=editing,mic=board.effects.microphone,off=!mic.enabled;
  const placements=(['close','standard','edge','room'] as const).map(value=>({value,label:<><span className="rig-spot-dot" aria-hidden="true"/><span className="rig-spot-name">{capital(value)}</span></>,style:{left:`${micSpots[value].x}%`,top:`${micSpots[value].y}%`,...(value==='close'?{flexDirection:'column-reverse' as const}:{})}}));
  return <div className="rig-cab-stage">
    <div className="rig-art-slot"><div className="rig-cab" data-off={off||undefined}>
      <CabinetArt/>
      <Segmented className="rig-spots" label={board.name('Microphone placement')} value={mic.placement} options={placements} disabled={busy} onChange={value=>fx(board,'microphone','placement',value)}/>
    </div></div>
    <div className="rig-cab-side">
      {block==='cabinet'&&<Choice label={board.name('Cabinet model')} value={board.effects.cabinet.model} disabled={busy} onChange={value=>fx(board,'cabinet','model',value)} options={cabinetModels.map(item=>[item,capital(modelName(item))] as const)}/>}
      <Choice label={board.name('Microphone output')} value={mic.output} disabled={busy} onChange={value=>fx(board,'microphone','output',value)} options={[['stereo','Stereo'],['mono','Mono']]}/>
      {block==='cabinet'&&<div className="rig-field"><span className="rig-field-name">Microphone</span><Footswitch editing={editing} board={board} block="microphone"/></div>}
      <p className="rig-note">{off?'The microphone block is bypassed; its placement is kept.':`Microphone: ${capital(mic.placement)}.`}</p>
      {/* Reserved for the cabinet impulse response control, `src/audio/CabinetResponse.tsx`, from its own branch. */}
      <div className="rig-slot" data-slot="cabinet-response">{cabinetResponse}</div>
    </div>
  </div>;
}

function GraphicEqStage({editing,board}:{editing:SoundEditing;board:Board}) {
  const gains=board.effects.graphicEq.gainsDb,{fx,busy}=editing;
  return <div className="rig-geq-stage">
    <div className="rig-geq" role="group" aria-label={board.name('Graphic EQ bands')}>
      {graphicBands.map((band,index)=><Fader key={band} label={band} ariaLabel={board.name(`Graphic EQ ${band} Hz (dB)`)} unit="" bipolar min={-12} max={12} step={.5} defaultValue={0} value={gains[index]} disabled={busy} onCommit={value=>fx(board,'graphicEq','gainsDb',gains.map((gain,other)=>other===index?value:gain))}/>)}
    </div>
    <div className="rig-geq-side">
      <BlockKnobs editing={editing} board={board} block="graphicEq" tone="pedal"/>
      <button type="button" className="rig-button" aria-label={board.name('Flatten graphic EQ')} disabled={busy} onClick={()=>fx(board,'graphicEq','gainsDb',graphicBands.map(()=>0))}>Flatten graphic EQ</button>
    </div>
  </div>;
}

function PedalStage({editing,board,block}:{editing:SoundEditing;board:Board;block:EffectBlock}) {
  const on=board.effects[block].enabled,look=blockLook[block],count=parameters[block].length;
  return <div className="rig-pedal-stage">
    <div className="rig-art-slot"><div className="rig-pedal" data-on={on} style={{'--pedal':look.color,'--columns':Math.min(3,Math.max(1,count))} as React.CSSProperties}>
      <PedalArt name={blockNames[block]} on={on}/>
      <div className="rig-pedal-knobs"><BlockKnobs editing={editing} board={board} block={block} tone="pedal"/></div>
      {/* A pointer shortcut for the switch in the stage's head, so it is left out of the tab order and the accessibility tree. */}
      <button type="button" aria-hidden="true" className="rig-footswitch" tabIndex={-1} disabled={editing.busy} onClick={()=>editing.fx(board,block,'enabled',!on)}/>
    </div></div>
    <div className="rig-pedal-side"><BlockOptions editing={editing} board={board} block={block}/></div>
  </div>;
}

/** The selected block's controls: drawn as the gear it is, with its knobs, models and the actions every block shares. */
export function BlockStage({editing,selected,cabinetResponse}:{editing:SoundEditing;selected:BlockRef;cabinetResponse?:ReactNode}) {
  const {block}=selected,board=selected.second&&editing.second?editing.second:editing.first;
  const {order,busy,clipboard,second}=editing,index=order.indexOf(block);
  const name=blockNames[block];
  let body:ReactNode;
  if(block==='amp')body=<AmpStage editing={editing} board={board}/>;
  else if(block==='cabinet'||block==='microphone')body=<CabinetStage editing={editing} board={board} block={block} cabinetResponse={cabinetResponse}/>;
  else if(block==='graphicEq')body=<GraphicEqStage editing={editing} board={board}/>;
  else body=<PedalStage editing={editing} board={board} block={block}/>;
  return <section className="rig-stage" role="tabpanel" aria-label={board.second?`Second pedalboard: ${name}`:name} data-block={block}>
    <header className="rig-stage-head">
      <h2>{board.second?'Second pedalboard · ':''}{name}</h2>
      {!board.second&&<span className="rig-stage-place">{index+1} of {order.length}</span>}
      <div className="rig-stage-actions">
        <Footswitch editing={editing} board={board} block={block}/>
        <button type="button" className="rig-button" aria-label={board.name(`Copy pedal: ${name}`)} disabled={busy} onClick={()=>editing.copyPedalOf(board,block)}>Copy pedal</button>
        <button type="button" className="rig-button" aria-label={board.name(`Paste pedal: ${name}`)} disabled={busy||clipboard.pedal?.block!==block} onClick={()=>editing.pastePedal(board)}>Paste pedal</button>
        {board.second
          ?<button type="button" className="rig-button" aria-label={`Remove duplicate: ${name}`} disabled={busy} onClick={()=>editing.fx(board,block,'enabled',false)}>Remove duplicate</button>
          :<button type="button" className="rig-button" aria-label={`Duplicate pedal: ${name}`} disabled={busy||!!second?.effects[block].enabled} onClick={()=>editing.duplicate(block)}>Duplicate pedal</button>}
        {!board.second&&<>
          <button type="button" className="rig-button" aria-label={`Move ${name} earlier`} disabled={busy||index===0} onClick={()=>editing.move(block,-1)}>Move earlier</button>
          <button type="button" className="rig-button" aria-label={`Move ${name} later`} disabled={busy||index===order.length-1} onClick={()=>editing.move(block,1)}>Move later</button>
        </>}
      </div>
    </header>
    {body}
  </section>;
}
