import { useEffect, useMemo,useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { DocumentController } from './controller';
import { describeSelection, effectiveAudioSettings } from './engine';
import type { BeatTarget, EditCommand } from './project';
import { repairMeasureSelection,repairSelection, validSelectionIndices } from './selection';
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
import type { MusicSelection } from './editor/range-types';
import { rangeFromBeats,selectionForTrack } from './editor/range-selection';
import { planMeasureMap } from './editor/measures';
import { ClipboardStore } from './editor/ClipboardStore';
import { ClipboardPanel } from './editor/ClipboardPanel';
import { musicClipSelection,scoreFromMusicClip } from './editor/clipboard-source';
import type { ClipboardMode,PasteOptions } from './editor/clipboard-types';
import { PracticePanel } from './audio/PracticePanel';
const noPlaybackSubscribe=()=>()=>{};
const textEntry=(target:EventTarget)=>target instanceof HTMLElement&&(['INPUT','SELECT','TEXTAREA'].includes(target.tagName)||target.isContentEditable);

export function App({controller}: {controller: DocumentController}) {
  const state=useSyncExternalStore(controller.subscribe,controller.getState);
  const [player,setPlayer]=useState<NativePlaybackController|null>(null);
  const playbackState=useSyncExternalStore(player?.subscribe??noPlaybackSubscribe,()=>player?.getState()??null);
  useEffect(()=>{const playback=new NativePlaybackController({onEdit:command=>controller.edit(command).then(()=>setSelection(old=>repairSelection(controller.getState().score,old)))});setPlayer(playback);return()=>playback.destroy();},[controller]);
  useEffect(()=>{controller.setBeforeChange(()=>player?.beforeScoreChange());return()=>controller.setBeforeChange(()=>{});},[controller,player]);
  const [selection,setSelection]=useState<BeatTarget>({track:0,staff:0,bar:0,voice:0,beat:0});
  const [musicSelection,setMusicSelection]=useState<MusicSelection|null>(null),rangeAnchor=useRef<BeatTarget|null>(null);
  const [clipboard]=useState(()=>new ClipboardStore()),[clipboardVersion,setClipboardVersion]=useState(0),[clipboardError,setClipboardError]=useState<string|null>(null);
  const clip=useMemo(()=>clipboard.get(),[clipboard,clipboardVersion]),clipboardSection=useRef<HTMLDivElement>(null);
  useEffect(()=>{setMusicSelection(null);rangeAnchor.current=null;},[state.documentEpoch]);
  const editorSelection=(value:MusicSelection|null)=>{rangeAnchor.current=null;setMusicSelection(value);};
  const [selectedString,setString]=useState(6); const [fret,setFret]=useState(0);
  const [selectedNoteIndex,setNoteIndex]=useState<number|null>(null);
  const [zoom,setZoom]=useState(100); const [profile,setProfile]=useState('ScoreTab');
  const [instrumentVisible,setInstrumentVisible]=useState(false);
  const digits=useRef({text:'',time:0});
  const target=repairSelection(state.score,selection);
  useEffect(()=>{if(player)void player.loadDocument(state.snapshot.project,state,target.track,state.documentEpoch);},[player,state.snapshot.project,state.score,state.settings,state.embeddedBacking,target.track,state.documentEpoch]);
  const location=describeSelection(state.score,target);
  const indexed=location.staff.isPercussion||!location.staff.tuning.length;
  const noteIndex=selectedNoteIndex!==null&&location.beat?.notes[selectedNoteIndex]?selectedNoteIndex:null;
  const string=Math.max(1,Math.min(selectedString,location.staff.tuning.length));
  useEffect(()=>{
    setFret(location.beat?.notes.find(n=>n.string===string)?.fret ?? 0);digits.current.text='';
  },[state.score,target.track,target.staff,target.bar,target.voice,target.beat,string]);
  const act=(job: Promise<unknown>)=>{void job.catch(()=>{});};
  const change=(job:Promise<unknown>)=>{setClipboardError(null);act(job.then(()=>{setSelection(old=>repairSelection(controller.getState().score,old));editorSelection(null);}));};
  const edit=(command:EditCommand)=>{
    setClipboardError(null);
    const oldCount=state.score.masterBars.length;
    act(controller.edit(command).then(()=>{
      const score=controller.getState().score,map=command.type==='insertMeasures'||command.type==='removeMeasures'?planMeasureMap(oldCount,command):null;
      setSelection(old=>map?repairMeasureSelection(score,old,map):repairSelection(score,old));
      if(command.type==='pasteMusic')setNoteIndex(null);
      if(!('selection'in command)||command.type==='eraseSelection')editorSelection(null);
    }));
  };
  const copyMusic=(mode:ClipboardMode,cut=false)=>{
    if(!musicSelection||state.busy)return;setClipboardError(null);
    try{
      const scope=musicClipSelection(state.score,musicSelection,mode),bars=scope as Extract<MusicSelection,{kind:'bars'}>;
      const map=cut&&mode==='multiTrack'?planMeasureMap(state.score.masterBars.length,{type:'removeMeasures',firstBar:bars.firstBar,lastBar:bars.lastBar}):null;
      act((cut?controller.cutMusic(scope,mode):controller.copyMusic(scope,mode)).then(value=>{
        clipboard.set(value);setClipboardVersion(version=>version+1);
        if(cut){setSelection(old=>map?repairMeasureSelection(controller.getState().score,old,map):repairSelection(controller.getState().score,old));editorSelection(null);}
      }).catch(reason=>setClipboardError(reason instanceof Error?reason.message:String(reason))));
    }catch(reason){setClipboardError(reason instanceof Error?reason.message:String(reason));}
  };
  const pasteMusic=(options?:PasteOptions)=>{
    if(!clip||state.busy)return;
    try{
      const source=options?null:scoreFromMusicClip(clip),multi=clip.mode==='multiTrack';
      edit({type:'pasteMusic',clip,options:options??{target:{...target},destinations:source!.tracks.map((track,index)=>({sourceTrack:index,track:target.track+index,staffMap:track.staves.map((_,staff)=>clip.kind==='phrase'?target.staff:staff)})),count:1,placement:clip.kind==='phrase'?'currentBar':'beforeBar',filters:{diagrams:true,texts:true,timers:true,trackAutomations:true,masterAutomations:multi,sections:multi}}});
    }catch(reason){setClipboardError(reason instanceof Error?reason.message:String(reason));}
  };
  const showClipboard=()=>{const section=clipboardSection.current?.querySelector('details');if(section){section.open=true;section.querySelector('summary')?.focus();section.scrollIntoView({block:'nearest'});}};
  const documentAction=(job:Promise<unknown>)=>change(job);
  const [exportOpen,setExportOpen]=useState(false),[exportError,setExportError]=useState<string|null>(null),[exportLaunching,setExportLaunching]=useState(false);const exportCancelled=useRef(false);
  const audioSettings=effectiveAudioSettings(state.snapshot.project,state),practiceRatio=player?player.exportPracticeRatio():1;
  const exports=useExportCoordinator({score:state.score,settings:audioSettings,currentSpeed:practiceRatio,bridge:nativeBridge,embeddedBacking:state.embeddedBacking});
  const runExport=(options:ExportOptions)=>{setExportError(null);setExportLaunching(true);exportCancelled.current=false;act((async()=>{
    if((options.format==='pdf'||options.format==='print')&&JSON.stringify(options.layout)!==JSON.stringify(state.settings.print))await controller.edit({type:'setPrintLayout',layout:options.layout});
    if(exportCancelled.current)return;
    if(await exports.run(options))setExportOpen(false);
  })().catch(error=>{setExportError(error instanceof Error?error.message:String(error));}).finally(()=>setExportLaunching(false)));};
  const cancelExport=()=>{exportCancelled.current=true;if(exports.busy)act(exports.cancel().then(()=>setExportOpen(false)).catch(error=>setExportError(String(error))));else setExportOpen(false);};
  const backingEdit=(command:EditCommand,candidate?:BackingCandidate)=>controller.edit(command,candidate);
  const selectedTrack=state.score.tracks[target.track],trackId=trackIdentity(selectedTrack);
  const originalBacking=state.embeddedBacking&&!state.snapshot.project.edits.some(edit=>edit.type==='setBacking');
  const select=(next:BeatTarget,s=string,index?:number)=>{
    if (!validSelectionIndices(next) || !Number.isInteger(s)) return;
    const fixed=repairSelection(state.score,next);setSelection(fixed);
    setNoteIndex(index!==undefined&&Number.isInteger(index)&&index>=0?index:null);
    const beat=describeSelection(state.score,fixed).beat;
    const count=state.score.tracks[fixed.track].staves[fixed.staff].tuning.length;
    const chosen=Math.max(1,Math.min(s,count));setString(chosen);
    setFret(beat?.notes.find(n=>n.string===chosen)?.fret ?? 0);digits.current.text='';
  };
  function keys(event:KeyboardEvent) {
    if (textEntry(event.target)||(event.target as HTMLElement).tagName==='BUTTON') return;
    let next={...target};
    if(event.key==='ArrowRight') {
      if(next.beat<location.voice.beats.length-1) next.beat++;
      else if(next.bar<state.score.masterBars.length-1) {next.bar++;next.beat=0;}
    } else if(event.key==='ArrowLeft') {
      if(next.beat>0) next.beat--;
      else if(next.bar>0) {next.bar--;next.beat=state.score.tracks[next.track].staves[next.staff].bars[next.bar].voices[next.voice].beats.length-1;}
    } else if(event.key==='ArrowDown'||event.key==='ArrowUp') {
      if(indexed)setNoteIndex(Math.max(0,Math.min((location.beat?.notes.length??1)-1,(noteIndex??0)+(event.key==='ArrowUp'?1:-1))));
      else select(next,string+(event.key==='ArrowUp'?1:-1));event.preventDefault();return;
    }
    else if(/^\d$/.test(event.key)&&!indexed) {
      const now=Date.now();digits.current.text=(now-digits.current.time<1000?digits.current.text:'')+event.key;
      digits.current.text=digits.current.text.slice(-2);digits.current.time=now;setFret(Number(digits.current.text));event.preventDefault();return;
    } else if(event.key==='Enter' && location.beat && !state.busy&&!indexed) {edit({type:'setNote',target,string,fret});event.preventDefault();return;}
    else return;
    if(event.shiftKey&&(event.key==='ArrowLeft'||event.key==='ArrowRight')){
      const anchor=rangeAnchor.current??target;
      try{setMusicSelection({kind:'range',range:rangeFromBeats(state.score,anchor,next,[{track:target.track,staff:target.staff,voice:target.voice}])});rangeAnchor.current=anchor;}catch{ /* An empty voice has no attack endpoint. */ }
    }else editorSelection(null);
    select(next);event.preventDefault();
  }
  function selectionKeys(event:KeyboardEvent){
    if(textEntry(event.target)||exportOpen||(event.target instanceof Element&&event.target.closest('[role="dialog"]')))return;
    const key=event.key.toLowerCase();
    if((event.ctrlKey||event.metaKey)&&['c','x','v'].includes(key)){
      event.preventDefault();if(state.busy)return;
      if(key==='v'){if(event.shiftKey)showClipboard();else pasteMusic();}
      else copyMusic(event.shiftKey?'multiTrack':'singleTrack',key==='x');
    }
    else if((event.ctrlKey||event.metaKey)&&key==='a'){editorSelection(selectionForTrack(state.score,target.track));event.preventDefault();}
    else if(event.key==='Escape'){editorSelection(null);event.preventDefault();}
  }
  return <div className="app-shell" onKeyDown={selectionKeys}>
    <header className="toolbar"><h1>TabPlayer</h1><nav aria-label="File and history">
      <button disabled={state.busy} onClick={()=>documentAction(controller.new())}>New</button>
      <button disabled={state.busy} onClick={()=>documentAction(controller.open())}>Open</button>
      <button disabled={state.busy} onClick={()=>act(controller.save())}>Save</button>
      <button disabled={state.busy} onClick={()=>act(controller.save(true))}>Save As</button>
      <button disabled={state.busy || !state.snapshot.canUndo} onClick={()=>change(controller.undo())}>Undo</button>
      <button disabled={state.busy || !state.snapshot.canRedo} onClick={()=>change(controller.redo())}>Redo</button>
    </nav><span className="document-title">{state.score.title || 'Untitled'}{state.snapshot.dirty?' •':''}</span>
    <button disabled={state.busy||exports.busy} onClick={()=>{setExportError(null);setExportOpen(true);}}>Export score</button><button disabled={state.busy||exports.busy} onClick={()=>act(controller.export())}>Export GP</button></header>
    {(clipboardError||state.error||(!exportOpen&&exportError)) && <div className="error" role="alert">{clipboardError||state.error||exportError}</div>}
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
        <div className="paper-scroll"><div className="paper"><ScoreView score={state.score} track={target.track} zoom={zoom} profile={profile} onSelect={select} playback={player} editorSelection={musicSelection} onEditorSelection={editorSelection}/></div></div>
        <div className="score-hint">Measure {target.bar+1} · Beat {target.beat+1} · {indexed?`${location.staff.isPercussion?'Percussion':'Pitched'} note ${noteIndex===null?'entry':noteIndex+1} — Click a note to edit it in the inspector.`:`String ${string} · Fret ${fret} — Click the score, then use arrow keys, digits and Enter.`}</div>
        {instrumentVisible&&<LiveInstrumentView score={state.score} track={target.track} staff={target.staff} player={player}/>}
      </section>
      <EditorPanel score={state.score} target={target} string={string} fret={fret} noteIndex={noteIndex} onSelectNote={setNoteIndex} busy={state.busy} onSelect={next=>{editorSelection(null);select(next);}} onString={s=>select(target,s)} onFret={setFret} onEdit={edit} musicSelection={musicSelection} onMusicSelection={editorSelection}>
        <div ref={clipboardSection}><ClipboardPanel score={state.score} target={target} selection={musicSelection} clip={clip} busy={state.busy} onCopy={mode=>copyMusic(mode)} onCut={mode=>copyMusic(mode,true)} onPaste={pasteMusic}/></div>
        {player&&playbackState&&<PracticePanel key={state.documentEpoch} settings={playbackState.practice.settings} busy={state.busy||playbackState.practicePending||!playbackState.ready} hasBacking={!!audioSettings.backing} onChange={settings=>player.setPractice(settings)}/>}
      </EditorPanel>
    </div>
    {player && <Transport player={player} measures={state.score.masterBars.length} busy={state.busy}/>}
    {exportOpen&&<ExportDialog score={state.score} layout={state.settings.print} currentSpeedAvailable={practiceRatio!==null} busy={exports.busy||state.busy||exportLaunching} progress={exports.progress} failure={exportError} onExport={runExport} onCancel={cancelExport}/>}
    <footer className="statusbar">{state.busy?'Working…':state.snapshot.dirty?'Unsaved changes':'Saved'}<span>{state.snapshot.path ?? 'Save a .tabplayer project to keep the original score and edits.'}</span></footer>
  </div>;
}
