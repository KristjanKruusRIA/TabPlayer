import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { DocumentController } from './controller';
import { describeSelection, effectiveAudioSettings } from './engine';
import type { BeatTarget, EditCommand } from './project';
import { repairSelection, validSelectionIndices } from './selection';
import { ScoreView } from './ScoreView';
import { EditorPanel } from './EditorPanel';
import { TrackPanel } from './TrackPanel';
import './styles.css';
import { NativePlaybackController } from './audio/NativePlaybackController';
import { SoundPanel } from './audio/SoundPanel';
import { BackingPanel } from './audio/BackingPanel';
import type { BackingCandidate } from './audio/bridge';
import { trackIdentity } from './engine';
import { nativeBridge } from './bridge';
import { ExportDialog } from './export/ExportDialog';
import { useExportCoordinator } from './export/useExportCoordinator';
import type { ExportOptions } from './export/types';
import { Transport } from './Transport';
import { LiveInstrumentView } from './instruments/LiveInstrumentView';
const noPlaybackSubscribe=()=>()=>{};

export function App({controller}: {controller: DocumentController}) {
  const state=useSyncExternalStore(controller.subscribe,controller.getState);
  const [player,setPlayer]=useState<NativePlaybackController|null>(null);
  const practiceSpeed=useSyncExternalStore(player?.subscribe??noPlaybackSubscribe,()=>player?.getState().speed??100);
  useEffect(()=>{const playback=new NativePlaybackController({onEdit:command=>controller.edit(command).then(()=>setSelection(old=>repairSelection(controller.getState().score,old)))});setPlayer(playback);return()=>playback.destroy();},[controller]);
  useEffect(()=>{controller.setBeforeChange(()=>player?.beforeScoreChange());return()=>controller.setBeforeChange(()=>{});},[controller,player]);
  const [selection,setSelection]=useState<BeatTarget>({track:0,staff:0,bar:0,voice:0,beat:0});
  const [selectedString,setString]=useState(6); const [fret,setFret]=useState(0);
  const [zoom,setZoom]=useState(100); const [profile,setProfile]=useState('ScoreTab');
  const [instrumentVisible,setInstrumentVisible]=useState(false);
  const digits=useRef({text:'',time:0});
  const target=repairSelection(state.score,selection);
  useEffect(()=>{if(player)void player.loadDocument(state.snapshot.project,state,target.track,state.documentEpoch);},[player,state.snapshot.project,state.score,state.settings,state.embeddedBacking,target.track,state.documentEpoch]);
  const location=describeSelection(state.score,target);
  const string=Math.max(1,Math.min(selectedString,location.staff.tuning.length));
  useEffect(()=>{
    setFret(location.beat?.notes.find(n=>n.string===string)?.fret ?? 0);digits.current.text='';
  },[state.score,target.track,target.staff,target.bar,target.voice,target.beat,string]);
  const act=(job: Promise<unknown>)=>{void job.catch(()=>{});};
  const change=(job:Promise<unknown>)=>act(job.then(()=>setSelection(old=>repairSelection(controller.getState().score,old))));
  const edit=(command:EditCommand)=>change(controller.edit(command));
  const documentAction=(job:Promise<unknown>)=>change(job);
  const [exportOpen,setExportOpen]=useState(false),[exportError,setExportError]=useState<string|null>(null),[exportLaunching,setExportLaunching]=useState(false);const exportCancelled=useRef(false);
  const exports=useExportCoordinator({score:state.score,settings:effectiveAudioSettings(state.snapshot.project,state),currentSpeed:practiceSpeed/100,bridge:nativeBridge,embeddedBacking:state.embeddedBacking});
  const runExport=(options:ExportOptions)=>{setExportError(null);setExportLaunching(true);exportCancelled.current=false;act((async()=>{
    if((options.format==='pdf'||options.format==='print')&&JSON.stringify(options.layout)!==JSON.stringify(state.settings.print))await controller.edit({type:'setPrintLayout',layout:options.layout});
    if(exportCancelled.current)return;
    if(await exports.run(options))setExportOpen(false);
  })().catch(error=>{setExportError(error instanceof Error?error.message:String(error));}).finally(()=>setExportLaunching(false)));};
  const cancelExport=()=>{exportCancelled.current=true;if(exports.busy)act(exports.cancel().then(()=>setExportOpen(false)).catch(error=>setExportError(String(error))));else setExportOpen(false);};
  const backingEdit=(command:EditCommand,candidate?:BackingCandidate)=>controller.edit(command,candidate);
  const selectedTrack=state.score.tracks[target.track],trackId=trackIdentity(selectedTrack);
  const originalBacking=state.embeddedBacking&&!state.snapshot.project.edits.some(edit=>edit.type==='setBacking');
  const select=(next:BeatTarget,s=string)=>{
    if (!validSelectionIndices(next) || !Number.isInteger(s)) return;
    const fixed=repairSelection(state.score,next);setSelection(fixed);
    const beat=describeSelection(state.score,fixed).beat;
    const count=state.score.tracks[fixed.track].staves[fixed.staff].tuning.length;
    const chosen=Math.max(1,Math.min(s,count));setString(chosen);
    setFret(beat?.notes.find(n=>n.string===chosen)?.fret ?? 0);digits.current.text='';
  };
  function keys(event:KeyboardEvent) {
    if (['INPUT','SELECT','TEXTAREA','BUTTON'].includes((event.target as HTMLElement).tagName)) return;
    let next={...target};
    if(event.key==='ArrowRight') {
      if(next.beat<location.voice.beats.length-1) next.beat++;
      else if(next.bar<state.score.masterBars.length-1) {next.bar++;next.beat=0;}
    } else if(event.key==='ArrowLeft') {
      if(next.beat>0) next.beat--;
      else if(next.bar>0) {next.bar--;next.beat=state.score.tracks[next.track].staves[next.staff].bars[next.bar].voices[next.voice].beats.length-1;}
    } else if(event.key==='ArrowDown') {select(next,string-1);event.preventDefault();return;}
    else if(event.key==='ArrowUp') {select(next,string+1);event.preventDefault();return;}
    else if(/^\d$/.test(event.key)) {
      const now=Date.now();digits.current.text=(now-digits.current.time<1000?digits.current.text:'')+event.key;
      digits.current.text=digits.current.text.slice(-2);digits.current.time=now;setFret(Number(digits.current.text));event.preventDefault();return;
    } else if(event.key==='Enter' && location.beat && !state.busy) {edit({type:'setNote',target,string,fret});event.preventDefault();return;}
    else return;
    select(next);event.preventDefault();
  }
  return <div className="app-shell">
    <header className="toolbar"><h1>TabPlayer</h1><nav aria-label="File and history">
      <button disabled={state.busy} onClick={()=>documentAction(controller.new())}>New</button>
      <button disabled={state.busy} onClick={()=>documentAction(controller.open())}>Open</button>
      <button disabled={state.busy} onClick={()=>act(controller.save())}>Save</button>
      <button disabled={state.busy} onClick={()=>act(controller.save(true))}>Save As</button>
      <button disabled={state.busy || !state.snapshot.canUndo} onClick={()=>change(controller.undo())}>Undo</button>
      <button disabled={state.busy || !state.snapshot.canRedo} onClick={()=>change(controller.redo())}>Redo</button>
    </nav><span className="document-title">{state.score.title || 'Untitled'}{state.snapshot.dirty?' •':''}</span>
    <button disabled={state.busy||exports.busy} onClick={()=>{setExportError(null);setExportOpen(true);}}>Export score</button><button disabled={state.busy||exports.busy} onClick={()=>act(controller.export())}>Export GP</button></header>
    {(state.error||(!exportOpen&&exportError)) && <div className="error" role="alert">{state.error||exportError}</div>}
    {state.importNotice && <div className="notice" role="status">{state.importNotice}</div>}
    <div className="workspace">
      <TrackPanel score={state.score} selected={target.track} busy={state.busy} player={player} onSelect={track=>select({track,staff:0,bar:target.bar,voice:0,beat:0},state.score.tracks[track].staves[0].tuning.length)} onEdit={edit}>
        <SoundPanel trackId={trackId} sound={state.settings.sounds[trackId]} onEdit={command=>controller.edit(command)} playback={player} busy={state.busy}/>
        <BackingPanel settings={originalBacking?undefined:state.settings.backing} originalSettings={state.embeddedBackingSettings?{assetId:'embedded',...state.embeddedBackingSettings}:null} assets={state.snapshot.project.assets} embedded={state.embeddedBacking} playback={player} onEdit={backingEdit} busy={state.busy}/>
      </TrackPanel>
      <section className="score-workspace" aria-label="Score workspace" tabIndex={0} onKeyDown={keys}>
        <div className="score-tools"><span>{state.score.masterBars.length} measures · {state.score.tracks.length} tracks</span>
          <label>View<select value={profile} onChange={e=>setProfile(e.target.value)}><option>ScoreTab</option><option>Tab</option><option>Score</option></select></label>
          <label>Zoom<select value={zoom} onChange={e=>setZoom(Number(e.target.value))}>{[70,85,100,115,130].map(z=><option key={z} value={z}>{z}%</option>)}</select></label>
          <button aria-pressed={instrumentVisible} onClick={()=>setInstrumentVisible(visible=>!visible)}>{instrumentVisible?'Hide instrument':'Show instrument'}</button>
        </div>
        <div className="paper-scroll"><div className="paper"><ScoreView score={state.score} track={target.track} zoom={zoom} profile={profile} onSelect={select} playback={player}/></div></div>
        <div className="score-hint">Measure {target.bar+1} · Beat {target.beat+1} · String {string} · Fret {fret} — Click the score, then use arrow keys, digits and Enter.</div>
        {instrumentVisible&&<LiveInstrumentView score={state.score} track={target.track} staff={target.staff} player={player}/>}
      </section>
      <EditorPanel score={state.score} target={target} string={string} fret={fret} busy={state.busy} onSelect={select} onString={s=>select(target,s)} onFret={setFret} onEdit={edit}/>
    </div>
    {player && <Transport player={player} measures={state.score.masterBars.length} busy={state.busy}/>}
    {exportOpen&&<ExportDialog score={state.score} layout={state.settings.print} busy={exports.busy||state.busy||exportLaunching} progress={exports.progress} failure={exportError} onExport={runExport} onCancel={cancelExport}/>}
    <footer className="statusbar">{state.busy?'Working…':state.snapshot.dirty?'Unsaved changes':'Saved'}<span>{state.snapshot.path ?? 'Save a .tabplayer project to keep the original score and edits.'}</span></footer>
  </div>;
}
