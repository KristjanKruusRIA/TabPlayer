import { useCallback,useEffect,useLayoutEffect, useMemo,useRef, useState, useSyncExternalStore, type KeyboardEvent,type ReactNode } from 'react';
import {model,Settings} from '@coderline/alphatab';
import { DocumentController } from './controller';
import { describeSelection, effectiveAudioSettings } from './engine';
import type { BeatTarget, EditCommand } from './project';
import { projectCommands } from './project';
import { repairMeasureSelection,repairSelection, validSelectionIndices } from './selection';
import { ScoreView } from './ScoreView';
import { EditorPanel } from './EditorPanel';
import { TrackPanel } from './TrackPanel';
import './styles.css';
import { NativePlaybackController } from './audio/NativePlaybackController';
import { SoundPanel } from './audio/SoundPanel';
import { BackingPanel } from './audio/BackingPanel';
import { BackingWaveform } from './audio/BackingWaveform';
import { useReferenceSyncEdit } from './audio/useReferenceSyncEdit';
import { disableReferenceSync,initializeReferenceSync,referenceSyncTiming } from './audio/reference-sync';
import { scoreTemposFromSync,syncPointsFromScore } from './audio/tempo-conversion';
import { backingLocationsForScore,buildPlaybackPlanFromJson } from './audio/plan';
import { scoreFromJson } from './model-clone';
import { captureNoteLinks,restoreNoteLinks } from './editor/links';
import type { ReferenceSyncControls } from './audio/reference-sync-types';
import { gpBackingSelectionIssue } from './interchange/backing-projection';
import { makeEmbeddedWaveformSource } from './audio/backing-waveform-bridge';
import type { BackingWaveformProps,NativeBackingWaveformBridge,WaveformSourceInput } from './audio/backing-waveform-types';
import type { BackingCandidate,NativeAudioBridge } from './audio/bridge';
import type { ExportNativeBridge } from './export/bridge';
import type { NativeBridge } from './bridge';
import type { DocumentViewState } from './workspace/types';
import { trackIdentity } from './engine';
import { ExportDialog } from './export/ExportDialog';
import { useExportCoordinator } from './export/useExportCoordinator';
import type { ExportOptions,ExportSelection } from './export/types';
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
import { EngravingPanel } from './engraving/EngravingPanel';
import { PageLayoutPanel } from './engraving/PageLayoutPanel';
import { TrackDisplayControls } from './engraving/TrackDisplayControls';
import { projectEngraving } from './engraving/projection';
import { effectivePageLayout } from './engraving/page';
import { resolveVisibleTracks,type TrackView } from './engraving/view';
import { resolveScoreDisplay,type ScoreDisplayPreferences } from './engraving/screen-view';
import { defaultPrintLayout } from './document-settings';
import { HarmonyChordDialog } from './harmony/HarmonyChordDialog';
import { ScaleToolPanel } from './harmony/ScaleToolPanel';
import { getHarmonyChord } from './harmony/chord-source';
import { readHarmonyLibrary,putHarmonyLibraryEntry,removeHarmonyLibraryEntry } from './harmony/library';
import type { HarmonyLibrary } from './editor/harmony-types';
import { HarmonyTransposePanel } from './harmony/HarmonyTransposePanel';
import { TrackSettingsPanel } from './workstation/TrackSettingsPanel';
import './workstation/workstation-shell.css';
const noPlaybackSubscribe=()=>()=>{};
const textEntry=(target:EventTarget)=>target instanceof HTMLElement&&(['INPUT','SELECT','TEXTAREA'].includes(target.tagName)||target.isContentEditable);

export interface AppProps {
  controller:DocumentController;audioBridge:NativeAudioBridge;waveformBridge:NativeBackingWaveformBridge;exportBridge:ExportNativeBridge;
  documentBridge:Pick<NativeBridge,'confirmExport'|'exportGp'|'readBackingAsset'>;
  documentView:DocumentViewState;onViewChange:(view:DocumentViewState)=>void;clipboard:ClipboardStore;
  workspaceBusy:boolean;workspaceError:string|null;beginEditorOperation:()=>()=>void;
  onNew:()=>Promise<boolean>;onOpen:()=>Promise<boolean>;onClose:()=>Promise<boolean>;onCloseAll:()=>Promise<boolean>;
  documentTabs:ReactNode;
  sessionMenu?:ReactNode;libraryMenu?:ReactNode;onFileCommandCapture?:(element:HTMLElement)=>void;recoveryStatus?:ReactNode;playbackResumeEpoch?:number;
}

export function App({controller,audioBridge,waveformBridge,exportBridge,documentBridge,documentView,onViewChange,clipboard,workspaceBusy,workspaceError,beginEditorOperation,onNew,onOpen,onClose,onCloseAll,documentTabs,sessionMenu,libraryMenu,onFileCommandCapture,recoveryStatus,playbackResumeEpoch=0}:AppProps) {
  const state=useSyncExternalStore(controller.subscribe,controller.getState);
  const controlsBusy=state.busy||workspaceBusy;
  const [player,setPlayer]=useState<NativePlaybackController|null>(null);
  const playbackState=useSyncExternalStore(player?.subscribe??noPlaybackSubscribe,()=>player?.getState()??null);
  useEffect(()=>{const playback=new NativePlaybackController({bridge:audioBridge,onEdit:command=>controller.edit(command).then(()=>setSelection(old=>repairSelection(controller.getState().score,old)))});setPlayer(playback);return()=>playback.destroy();},[controller,audioBridge]);
  useEffect(()=>{controller.setBeforeChange(()=>player?.beforeScoreChange());return()=>controller.setBeforeChange(()=>{});},[controller,player]);
  const referenceLifetime=useMemo(()=>({active:true}),[controller,waveformBridge]);
  useEffect(()=>{referenceLifetime.active=true;const unbind=controller.setReferenceWaveformBridge(waveformBridge);return()=>{referenceLifetime.active=false;unbind();};},[controller,waveformBridge,referenceLifetime]);
  const [selection,setSelection]=useState<BeatTarget>(documentView.target);
  const [musicSelection,setMusicSelection]=useState<MusicSelection|null>(null),rangeAnchor=useRef<BeatTarget|null>(null);
  const [clipboardVersion,setClipboardVersion]=useState(0),[clipboardError,setClipboardError]=useState<string|null>(null);
  const clip=useMemo(()=>clipboard.get(),[clipboard,clipboardVersion]),clipboardSection=useRef<HTMLDivElement>(null);
  useEffect(()=>{setMusicSelection(null);rangeAnchor.current=null;},[state.documentEpoch]);
  const editorSelection=(value:MusicSelection|null)=>{rangeAnchor.current=null;setMusicSelection(value);};
  const [selectedString,setString]=useState(documentView.selectedString); const [fret,setFret]=useState(0);
  const [selectedNoteIndex,setNoteIndex]=useState<number|null>(documentView.selectedNoteIndex);
  const [zoom,setZoom]=useState(documentView.zoom),[trackView,setTrackView]=useState<TrackView>(documentView.trackView);
  const [scoreDisplay,setScoreDisplay]=useState<ScoreDisplayPreferences|undefined>(documentView.scoreDisplay);
  const display=useMemo(()=>resolveScoreDisplay(scoreDisplay),[scoreDisplay]);
  const [displayStatus,setDisplayStatus]=useState<{zoomPercent:number;fitLimited:boolean;pageError:string|null}|null>(null);
  const onDisplayStatus=useCallback((status:{zoomPercent:number;fitLimited:boolean;pageError:string|null})=>{
    setDisplayStatus(old=>old&&old.zoomPercent===status.zoomPercent&&old.fitLimited===status.fitLimited&&old.pageError===status.pageError?old:status);
  },[]);
  const manualZoom=(value:number)=>{setZoom(value);setScoreDisplay(old=>old&&old.zoomMode!=='manual'?{...old,zoomMode:'manual'}:old);};
  const [instrumentVisible,setInstrumentVisible]=useState(documentView.instrumentVisible);
  const [leftTask,setLeftTask]=useState<'track'|'sound'|'backing'>('track');
  const [leftVisible,setLeftVisible]=useState(true),[inspectorVisible,setInspectorVisible]=useState(true),[dockVisible,setDockVisible]=useState(true);
  const [narrowPane,setNarrowPane]=useState<'track'|'sound'|'backing'|'inspector'>('inspector');
  const [viewport,setViewport]=useState(()=>({width:window.innerWidth,height:window.innerHeight}));
  const [dockMode,setDockMode]=useState<'overview'|'mixer'|'backing'>('overview'),[dockForced,setDockForced]=useState(false),[waveformOpened,setWaveformOpened]=useState(false);
  const shell=useRef<HTMLDivElement>(null),workspace=useRef<HTMLDivElement>(null),scorePane=useRef<HTMLElement>(null),commandBar=useRef<HTMLElement>(null);
  const leftPane=useRef<HTMLElement>(null),inspectorPane=useRef<HTMLDivElement>(null),paneRail=useRef<HTMLElement>(null),viewMenu=useRef<HTMLDetailsElement>(null);
  const paneFocusIntent=useRef<{pane:'track'|'sound'|'backing'|'inspector';trigger:boolean}|null>(null),[paneFocusTick,setPaneFocusTick]=useState(0);
  const [workspaceHeight,setWorkspaceHeight]=useState(Infinity),[clipboardFocus,setClipboardFocus]=useState(0);
  const narrow=viewport.width<1180,leftShown=leftVisible&&(!narrow||narrowPane!=='inspector'),inspectorShown=inspectorVisible&&(!narrow||narrowPane==='inspector');
  const dockHeight=instrumentVisible?(viewport.height<800?160:184):(viewport.height<800?dockMode==='backing'?176:144:viewport.width>=1440?192:176);
  const dockCollapsed=dockVisible&&!dockForced&&workspaceHeight-dockHeight<200;
  const instrumentShown=instrumentVisible&&dockVisible&&!dockCollapsed;
  const requestPaneFocus=(pane:'track'|'sound'|'backing'|'inspector',trigger=false)=>{paneFocusIntent.current={pane,trigger};setPaneFocusTick(value=>value+1);};
  useEffect(()=>{const resize=()=>{if(window.innerWidth<1180){if(narrowPane==='inspector'&&leftPane.current?.contains(document.activeElement))requestPaneFocus(leftTask,true);else if(narrowPane!=='inspector'&&inspectorPane.current?.contains(document.activeElement))requestPaneFocus('inspector',true);}setViewport({width:window.innerWidth,height:window.innerHeight});};window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize);},[narrowPane,leftTask]);
  useLayoutEffect(()=>{if(!workspace.current||typeof ResizeObserver==='undefined')return;const observer=new ResizeObserver(entries=>{const height=entries[0]?.contentRect.height;if(height>0)setWorkspaceHeight(height);});observer.observe(workspace.current);return()=>observer.disconnect();},[]);
  const closeCommands=(focus=false)=>{commandBar.current?.querySelectorAll<HTMLDetailsElement>('details[open]').forEach(details=>{details.open=false;if(focus)details.querySelector('summary')?.focus();});};
  const commandToggle=(current:HTMLDetailsElement)=>{if(current.open)commandBar.current?.querySelectorAll<HTMLDetailsElement>('details[open]').forEach(other=>{if(other!==current)other.open=false;});};
  useEffect(()=>{const outside=(event:PointerEvent)=>{if(event.target instanceof Node&&!commandBar.current?.contains(event.target))closeCommands(true);};document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside);},[]);
  useLayoutEffect(()=>{const intent=paneFocusIntent.current;if(!intent)return;paneFocusIntent.current=null;if(document.activeElement instanceof Element&&document.activeElement.closest('[role="dialog"]'))return;const pane=intent.pane==='inspector'?inspectorPane.current:leftPane.current;const activeTask=intent.pane==='inspector'?pane:pane?.querySelector<HTMLElement>('.workstation-task:not([hidden])');const destination=intent.trigger?paneRail.current?.querySelector<HTMLElement>(`[data-pane="${intent.pane}"]`):activeTask?.querySelector<HTMLElement>('summary,button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)');destination?.focus();},[paneFocusTick,leftShown,inspectorShown,leftTask,narrowPane,viewport.width]);
  useLayoutEffect(()=>{if(!clipboardFocus)return;const section=clipboardSection.current?.querySelector('details');if(section){for(let parent=section.parentElement;parent;parent=parent.parentElement)if(parent instanceof HTMLDetailsElement)parent.open=true;section.open=true;section.querySelector('summary')?.focus();section.scrollIntoView?.({block:'nearest'});}},[clipboardFocus]);
  const showTask=(task:'track'|'sound'|'backing')=>{closeCommands();setLeftVisible(true);setLeftTask(task);setNarrowPane(task);requestPaneFocus(task);};
  const showInspector=()=>{closeCommands();setInspectorVisible(true);setNarrowPane('inspector');requestPaneFocus('inspector');};
  const chooseDock=(mode:'overview'|'mixer'|'instrument'|'backing')=>{setDockVisible(true);setDockForced(true);setInstrumentVisible(mode==='instrument');if(mode!=='instrument')setDockMode(mode);if(mode==='backing')setWaveformOpened(true);};
  const hideDock=()=>{setDockVisible(false);viewMenu.current?.querySelector('summary')?.focus();};
  const [harmonyOpen,setHarmonyOpen]=useState(false),[scaleOpen,setScaleOpen]=useState(false),[libraryLoading,setLibraryLoading]=useState(false),[libraryError,setLibraryError]=useState<string|null>(null);
  const [library,setLibrary]=useState<HarmonyLibrary>({format:'TabPlayerHarmonyLibrary',version:1,entries:[]});
  const libraryRevision=useRef(0);
  useEffect(()=>{setHarmonyOpen(false);setScaleOpen(false);},[state.documentEpoch]);
  useEffect(()=>{
    if(!harmonyOpen)return;let active=true;const revision=++libraryRevision.current;setLibraryLoading(true);setLibraryError(null);
    void readHarmonyLibrary().then(value=>{if(active&&revision===libraryRevision.current)setLibrary(value);}).catch(error=>{if(active&&revision===libraryRevision.current)setLibraryError(`Chord library: ${error instanceof Error?error.message:String(error)}`);}).finally(()=>{if(active&&revision===libraryRevision.current)setLibraryLoading(false);});
    return()=>{active=false;};
  },[harmonyOpen]);
  const digits=useRef({text:'',time:0});
  const target=repairSelection(state.score,selection);
  useEffect(()=>{onViewChange({target,selectedString,selectedNoteIndex,zoom,trackView,instrumentVisible,...(scoreDisplay?{scoreDisplay}:{})});},[target.track,target.staff,target.bar,target.voice,target.beat,selectedString,selectedNoteIndex,zoom,trackView,instrumentVisible,scoreDisplay,onViewChange]);
  const trackIds=useMemo(()=>state.score.tracks.map(trackIdentity),[state.score]);
  const visibleTracks=useMemo(()=>resolveVisibleTracks(trackIds,target.track,trackView),[trackIds,target.track,trackView]);
  const projection=useMemo(()=>projectEngraving(state.score,trackIds,state.settings.engraving),[state.score,trackIds,state.settings.engraving]);
  const pageState=useMemo(()=>{
    try{return {page:effectivePageLayout(state.settings),error:null};}
    catch(error){return {page:effectivePageLayout({page:null,print:defaultPrintLayout()}),error:`Saved print layout cannot be exported: ${error instanceof Error?error.message:String(error)} Apply a valid page layout.`};}
  },[state.settings.page,state.settings.print]),page=pageState.page;
  useEffect(()=>{if(player)void player.loadDocument(state.snapshot.project,state,target.track,state.documentEpoch,playbackResumeEpoch);},[player,state.snapshot.project,state.score,state.settings,state.embeddedBacking,target.track,state.documentEpoch,playbackResumeEpoch]);
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
    if(!musicSelection||controlsBusy)return;setClipboardError(null);
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
    if(!clip||controlsBusy)return;
    try{
      const source=options?null:scoreFromMusicClip(clip),multi=clip.mode==='multiTrack';
      edit({type:'pasteMusic',clip,options:options??{target:{...target},destinations:source!.tracks.map((track,index)=>({sourceTrack:index,track:target.track+index,staffMap:track.staves.map((_,staff)=>clip.kind==='phrase'?target.staff:staff)})),count:1,placement:clip.kind==='phrase'?'currentBar':'beforeBar',filters:{diagrams:true,texts:true,timers:true,trackAutomations:true,masterAutomations:multi,sections:multi}}});
    }catch(reason){setClipboardError(reason instanceof Error?reason.message:String(reason));}
  };
  const showClipboard=()=>{showInspector();setClipboardFocus(value=>value+1);};
  const documentAction=(job:Promise<unknown>)=>change(job);
  const [exportOpen,setExportOpen]=useState(false),[exportError,setExportError]=useState<string|null>(null),[exportLaunching,setExportLaunching]=useState(false);const exportCancelled=useRef(false),exportRunning=useRef<Promise<void>|null>(null),modalRelease=useRef<(()=>void)|null>(null);
  useEffect(()=>()=>{modalRelease.current?.();},[]);
  const closeModal=()=>{setExportOpen(false);setHarmonyOpen(false);setScaleOpen(false);modalRelease.current?.();modalRelease.current=null;};
  const openModal=(kind:'export'|'harmony'|'scale')=>{
    if(controlsBusy)return;
    try {modalRelease.current=beginEditorOperation();if(kind==='export'){setExportError(null);setExportOpen(true);}else if(kind==='harmony'){setLibraryLoading(true);setHarmonyOpen(true);}else setScaleOpen(true);}
    catch(error){setClipboardError(error instanceof Error?error.message:String(error));}
  };
  const directExport=()=>{act((async()=>{const release=beginEditorOperation();try{await controller.export();}finally{release();}})());};
  const audioSettings=useMemo(()=>effectiveAudioSettings(state.snapshot.project,state),[state.snapshot.project,state.settings,state.embeddedBacking,state.embeddedBackingSettings,state.sourceMixes]),practiceRatio=player?player.exportPracticeRatio():1;
  const gpBackingIssue=useCallback((selection:ExportSelection)=>gpBackingSelectionIssue(state.score,audioSettings.backing,selection),[state.score,audioSettings.backing]);
  const exports=useExportCoordinator({score:state.score,settings:audioSettings,currentSpeed:practiceRatio,bridge:documentBridge,native:exportBridge,embeddedBacking:state.embeddedBacking,revision:state.revision});
  const runExport=(options:ExportOptions)=>{if(exportRunning.current)return;setExportError(null);setExportLaunching(true);exportCancelled.current=false;const running=(async()=>{
    if(options.format==='pdf'||options.format==='print'||options.format==='svg'||options.format==='png'){
      if(options.page){if(pageState.error||JSON.stringify(options.page)!==JSON.stringify(page))await controller.edit({type:'setPageLayout',layout:options.page});}
      else if(JSON.stringify(options.layout)!==JSON.stringify(state.settings.print))await controller.edit({type:'setPrintLayout',layout:options.layout});
    }
    if(exportCancelled.current)return;
    const latest=controller.getState();
    if(await exports.run(options,{score:latest.score,settings:effectiveAudioSettings(latest.snapshot.project,latest),embeddedBacking:latest.embeddedBacking,revision:latest.revision})&&!exportCancelled.current)closeModal();
  })().catch(error=>{setExportError(error instanceof Error?error.message:String(error));}).finally(()=>{setExportLaunching(false);exportRunning.current=null;});exportRunning.current=running;act(running);};
  const cancelExport=()=>{exportCancelled.current=true;const running=exportRunning.current;act((async()=>{let failed=false;try{await exports.cancel();}catch(error){failed=true;setExportError(String(error));}await running;if(!failed)closeModal();})());};
  const backingEdit=(command:EditCommand,candidate?:BackingCandidate)=>controller.edit(command,candidate);
  const selectedTrack=state.score.tracks[target.track],trackId=trackIdentity(selectedTrack);
  const originalBacking=state.embeddedBacking&&!projectCommands(state.snapshot.project).some(edit=>edit.type==='setBacking');
  const baseKey=originalBacking&&state.snapshot.project.base.kind==='file'?state.snapshot.project.base.sha256:null;
  const [embeddedSource,setEmbeddedSource]=useState<{bytes:Uint8Array;key:string;source:WaveformSourceInput|null;error:string|null}|null>(null),[embeddedRetry,setEmbeddedRetry]=useState(0);
  useEffect(()=>{
    if(!waveformOpened||!baseKey||!state.embeddedBacking)return;
    let active=true;const bytes=state.embeddedBacking,key=baseKey;
    setEmbeddedSource(null);
    void makeEmbeddedWaveformSource(key,bytes).then(source=>{if(active)setEmbeddedSource({bytes,key,source,error:null});}).catch(error=>{if(active)setEmbeddedSource({bytes,key,source:null,error:error instanceof Error?error.message:String(error)});});
    return()=>{active=false;};
  },[waveformOpened,baseKey,state.embeddedBacking,embeddedRetry]);
  const currentEmbedded=embeddedSource?.bytes===state.embeddedBacking&&embeddedSource?.key===baseKey?embeddedSource:null;
  const waveformSource:WaveformSourceInput|null=state.settings.backing?{kind:'asset',assetId:state.settings.backing.assetId}:originalBacking?currentEmbedded?.source??null:null;
  const waveformEnabled=dockVisible&&!dockCollapsed&&!instrumentVisible&&dockMode==='backing';
  const backingTimeline=player?.backingTimeline()??null;
  const referenceVisible=leftShown&&leftTask==='backing',metadataVisible=referenceVisible||waveformEnabled;
  const sourceAssetId=state.settings.backing&&state.snapshot.project.assets[state.settings.backing.assetId]?state.settings.backing.assetId:null;
  const sourceOwner=useRef({controller,bridge:waveformBridge,assetId:sourceAssetId});sourceOwner.current={controller,bridge:waveformBridge,assetId:sourceAssetId};
  const [sourceMetadata,setSourceMetadata]=useState<{bridge:NativeBackingWaveformBridge;assetId:string;durationMs:number|null;error:string|null}|null>(null),[sourceRetry,setSourceRetry]=useState(0);
  const currentMetadata=sourceMetadata?.bridge===waveformBridge&&sourceMetadata.assetId===sourceAssetId?sourceMetadata:null;
  const sourceDurationMs=currentMetadata?.durationMs??null;
  useEffect(()=>{
    if(!metadataVisible||!sourceAssetId||sourceDurationMs!==null)return;
    let active=true;const document={documentId:state.documentId,revision:state.revision},assetId=sourceAssetId,owner=waveformBridge.owner;
    const current=()=>{const now=controller.getState();return active&&referenceLifetime.active&&sourceOwner.current.controller===controller&&sourceOwner.current.bridge===waveformBridge&&sourceOwner.current.assetId===assetId&&now.documentId===document.documentId&&now.revision===document.revision&&now.settings.backing?.assetId===assetId;};
    setSourceMetadata(null);
    void waveformBridge.read(document,{kind:'asset',assetId},1).then(receipt=>{
      if(!current())return;
      if(owner.documentId!==document.documentId||receipt.owner.documentId!==owner.documentId||receipt.owner.activationId!==owner.activationId||receipt.document.documentId!==document.documentId||receipt.document.revision!==document.revision||receipt.source.kind!=='asset'||receipt.source.assetId!==assetId||!Number.isFinite(receipt.durationMs)||receipt.durationMs<=0)throw new Error('The backing timing source changed. Retry to load the current audio.');
      setSourceMetadata({bridge:waveformBridge,assetId,durationMs:receipt.durationMs,error:null});
    }).catch(error=>{if(current())setSourceMetadata({bridge:waveformBridge,assetId,durationMs:null,error:error instanceof Error?error.message:String(error)});});
    return()=>{active=false;};
  },[controller,waveformBridge,referenceLifetime,sourceAssetId,state.documentId,state.revision,metadataVisible,sourceRetry]);
  const backingSelection=useMemo(()=>player?.backingScoreSelection(target,musicSelection)??{points:[],spans:[]},[player,backingTimeline?.generation,backingTimeline?.tempos,backingTimeline?.occurrences,target.track,target.staff,target.bar,target.voice,target.beat,musicSelection]);
  const waveformCurrent=(document:Parameters<BackingWaveformProps['isCurrent']>[0],settings:Parameters<BackingWaveformProps['isCurrent']>[1])=>{
    const current=controller.getState();return referenceLifetime.active&&sourceOwner.current.controller===controller&&sourceOwner.current.bridge===waveformBridge&&waveformBridge.owner.documentId===document.documentId&&current.documentId===document.documentId&&current.revision===document.revision&&JSON.stringify(current.settings.backing)===JSON.stringify(settings);
  };
  const referenceReady=sourceAssetId!==null&&sourceDurationMs!==null&&!!backingTimeline?.occurrences.length;
  const referenceEdit=useReferenceSyncEdit({owner:waveformBridge.owner,document:{documentId:state.documentId,revision:state.revision},sourceKey:sourceAssetId,settings:state.settings.backing,timeline:backingTimeline,durationMs:sourceDurationMs,visible:{number:referenceVisible,waveform:waveformEnabled},busy:controlsBusy,beginOperation:beginEditorOperation,isCurrent:waveformCurrent,onCommit:async(backing,document)=>{
    if(!state.settings.backing||!waveformCurrent(document,state.settings.backing)||backing.assetId!==sourceAssetId)throw new Error('The active reference source changed. Try the edit again.');
    await controller.editAtRevision({type:'setBacking',backing},document);
  }});
  const referenceTiming=useMemo(()=>{
    if(!referenceReady||!state.settings.backing)return null;
    try{return referenceSyncTiming(referenceEdit.preview??state.settings.backing,backingTimeline!.occurrences,sourceDurationMs!);}catch{return null;}
  },[referenceReady,state.settings.backing,referenceEdit.preview,backingTimeline?.occurrences,sourceDurationMs]);
  const referenceAction=async(action:'score'|'reference'|'replace'|'add'|'write')=>{
    const captured=controller.getState(),document={documentId:captured.documentId,revision:captured.revision},backing=captured.settings.backing;
    if(controlsBusy||captured.busy||!referenceReady||!backing||captured.documentId!==state.documentId||captured.revision!==state.revision||backing.assetId!==sourceAssetId||!waveformCurrent(document,backing))throw new Error('Wait for backing timing to load before changing synchronization.');
    const release=beginEditorOperation();
    try{
      const settings=structuredClone(backing),json=model.JsonConverter.scoreToJson(captured.score);let command:EditCommand;
      if(action==='write'){
        const score=scoreFromJson(json,new Settings());restoreNoteLinks(score,captureNoteLinks(captured.score));
        const locations=backingLocationsForScore(score),timing=referenceSyncTiming(settings,locations,sourceDurationMs!);
        if(!timing)throw new Error('Enable Score follows audio before writing score tempos.');
        command={type:'replaceTempoAutomations',points:scoreTemposFromSync(score,timing,locations)};
      }else if(action==='score')command={type:'setBacking',backing:disableReferenceSync(settings)};
      else{
        const authored=buildPlaybackPlanFromJson(json,captured.score.tracks.map(trackIdentity),backingTimeline!.generation);
        command={type:'setBacking',backing:action==='reference'?initializeReferenceSync(settings,authored,sourceDurationMs!):syncPointsFromScore(authored,settings,action,sourceDurationMs!)};
      }
      if(!waveformCurrent(document,backing))throw new Error('The active reference source changed. Try the edit again.');
      await controller.editAtRevision(command,document);
    }finally{release();}
  };
  const reference:ReferenceSyncControls={ready:referenceReady,timing:referenceTiming,edit:referenceEdit,onModeChange:referenceAction,onFromScore:referenceAction,onWriteScore:()=>referenceAction('write')};
  const sourceMetadataStatus=sourceAssetId&&sourceDurationMs===null?<div className="backing-waveform-state">{currentMetadata?.error?<><p role="alert">{currentMetadata.error}</p><button onClick={()=>setSourceRetry(value=>value+1)}>Retry</button></>:<p role="status">Loading backing timing…</p>}</div>:null;
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
    } else if(event.key==='Enter' && location.beat && !controlsBusy&&!indexed) {edit({type:'setNote',target,string,fret});event.preventDefault();return;}
    else return;
    if(event.shiftKey&&(event.key==='ArrowLeft'||event.key==='ArrowRight')){
      const anchor=rangeAnchor.current??target;
      try{setMusicSelection({kind:'range',range:rangeFromBeats(state.score,anchor,next,[{track:target.track,staff:target.staff,voice:target.voice}])});rangeAnchor.current=anchor;}catch{ /* An empty voice has no attack endpoint. */ }
    }else editorSelection(null);
    select(next);event.preventDefault();
  }
  function selectionKeys(event:KeyboardEvent){
    if(textEntry(event.target)||exportOpen||harmonyOpen||scaleOpen||(event.target instanceof Element&&event.target.closest('[role="dialog"]')))return;
    const key=event.key.toLowerCase();
    if((event.ctrlKey||event.metaKey)&&!event.altKey&&['n','o','s','z','y'].includes(key)){
      event.preventDefault();if(controlsBusy||event.repeat)return;
      if(key==='n')documentAction(onNew());
      else if(key==='o')documentAction(onOpen());
      else if(key==='s')act(controller.save(event.shiftKey));
      else if(key==='y'||key==='z'&&event.shiftKey){if(state.snapshot.canRedo)change(controller.redo());}
      else if(state.snapshot.canUndo)change(controller.undo());
      return;
    }
    if(key===' '&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.repeat&&!(event.target instanceof Element&&event.target.closest('button,summary,a,[role="button"]'))){
      event.preventDefault();event.currentTarget.querySelector<HTMLButtonElement>('[aria-keyshortcuts="Space"]')?.click();return;
    }
    if((event.ctrlKey||event.metaKey)&&['c','x','v'].includes(key)){
      event.preventDefault();if(controlsBusy)return;
      if(key==='v'){if(event.shiftKey)showClipboard();else pasteMusic();}
      else copyMusic(event.shiftKey?'multiTrack':'singleTrack',key==='x');
    }
    else if((event.ctrlKey||event.metaKey)&&key==='a'){editorSelection(selectionForTrack(state.score,target.track));event.preventDefault();}
    else if(event.key==='Escape'){editorSelection(null);event.preventDefault();}
  }
  return <div ref={shell} className="app-shell" aria-busy={controlsBusy} data-narrow={narrow} onKeyDown={selectionKeys}>
    <header ref={commandBar} className="toolbar" onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeCommands(true);}}} onClickCapture={event=>{if(!(event.target instanceof Element))return;if(event.target instanceof HTMLElement)onFileCommandCapture?.(event.target);const disclosure=event.target.closest('summary')?.parentElement;if(disclosure instanceof HTMLDetailsElement)commandBar.current?.querySelectorAll<HTMLDetailsElement>('details[open]').forEach(other=>{if(other!==disclosure)other.open=false;});else if(event.target.closest('button'))closeCommands(true);}}><h1>TabPlayer</h1><nav aria-label="File and history">
      <details className="command-menu" onToggle={event=>commandToggle(event.currentTarget)}><summary>File</summary><section aria-label="File commands">
      <button disabled={controlsBusy} onClick={()=>documentAction(onNew())}>New</button>
      <button disabled={controlsBusy} onClick={()=>documentAction(onOpen())}>Open</button>
      <button disabled={controlsBusy} onClick={()=>act(controller.save())}>Save</button>
      <button disabled={controlsBusy} onClick={()=>act(controller.save(true))}>Save As</button>
      <button disabled={controlsBusy} onClick={()=>documentAction(onClose())}>Close score</button>
      <button disabled={controlsBusy} onClick={()=>documentAction(onCloseAll())}>Close all scores</button>
      <button disabled={controlsBusy||exports.busy} onClick={()=>openModal('export')}>Export score</button><button disabled={controlsBusy||exports.busy} onClick={directExport}>Export GP</button>
      {libraryMenu}{sessionMenu}</section></details>
      <details ref={viewMenu} className="command-menu" onToggle={event=>commandToggle(event.currentTarget)}><summary>View</summary><section aria-label="Workspace view">
        <label className="check"><input type="checkbox" checked={leftVisible} onChange={event=>event.target.checked?showTask(leftTask):setLeftVisible(false)}/>Track panel</label>
        <label className="check"><input type="checkbox" checked={inspectorVisible} onChange={event=>event.target.checked?showInspector():setInspectorVisible(false)}/>Inspector</label>
        <label className="check"><input type="checkbox" checked={dockVisible} onChange={event=>setDockVisible(event.target.checked)}/>Bottom dock</label>
      </section></details>
      <button disabled={controlsBusy || !state.snapshot.canUndo} onClick={()=>change(controller.undo())}>Undo</button>
      <button disabled={controlsBusy || !state.snapshot.canRedo} onClick={()=>change(controller.redo())}>Redo</button>
    </nav><details className="keyboard-help" onToggle={event=>commandToggle(event.currentTarget)} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();event.currentTarget.open=false;event.currentTarget.querySelector('summary')?.focus();}}}><summary>Help</summary><section role="region" aria-label="Keyboard and editing help">
      <h2>Keyboard & editing</h2><p>Use these shortcuts outside input fields and dialogs.</p>
      <dl><dt>Ctrl/Cmd + N / O</dt><dd>New score / Open score</dd><dt>Ctrl/Cmd + S</dt><dd>Save; add Shift for Save As</dd><dt>Ctrl/Cmd + W</dt><dd>Close the current score</dd><dt>Ctrl/Cmd + Tab</dt><dd>Next score; add Shift for the previous score</dd><dt>Ctrl/Cmd + Z</dt><dd>Undo; add Shift to redo. Ctrl/Cmd + Y also redoes.</dd><dt>Space</dt><dd>Play or pause</dd></dl>
      <h3>With the score focused</h3><dl><dt>Left / Right</dt><dd>Previous / next beat</dd><dt>Up / Down</dt><dd>Change string, or choose a pitched/percussion note</dd><dt>Digits, then Enter</dt><dd>Enter a fret and set the note on a fretted track</dd><dt>Shift + Left/Right</dt><dd>Extend the musical selection</dd><dt>Ctrl/Cmd + A</dt><dd>Select the current track</dd><dt>Ctrl/Cmd + C / X / V</dt><dd>Copy / Cut / Paste music. Add Shift to Copy/Cut for all selected tracks; Shift + Paste opens paste options.</dd><dt>Escape</dt><dd>Clear the musical selection</dd></dl>
      <p>The blue outline marks your edit target. Green follows playback or a selected passage. Use the inspector’s Edit, Practice and Presentation buttons to reach tools; changes apply only when you use their action buttons.</p>
    </section></details><span className="document-title">{state.score.title || 'Untitled'}{state.snapshot.dirty?' •':''}</span>
    </header>
    {documentTabs}
    {player && <Transport player={player} measures={state.score.masterBars.length} busy={controlsBusy} cursor={target} selection={musicSelection}/>}
    {(clipboardError||workspaceError||state.error||(!exportOpen&&exportError)||pageState.error||harmonyOpen&&libraryError) && <div className="error" role="alert">{clipboardError||workspaceError||state.error||exportError||pageState.error||libraryError}</div>}
    <div ref={workspace} className="workspace workstation-workspace" data-left={leftShown} data-inspector={inspectorShown} data-dock={dockVisible} data-dock-collapsed={dockCollapsed} style={{'--dock-height':`${dockHeight}px`} as React.CSSProperties}>
      <nav ref={paneRail} className="workstation-rail" aria-label="Workspace panes">
        <button data-pane="track" aria-pressed={leftShown&&leftTask==='track'} onClick={()=>showTask('track')}>Track</button><button data-pane="sound" aria-pressed={leftShown&&leftTask==='sound'} onClick={()=>showTask('sound')}>Sound</button><button data-pane="backing" aria-pressed={leftShown&&leftTask==='backing'} onClick={()=>showTask('backing')}>Backing</button><button data-pane="inspector" aria-pressed={inspectorShown} onClick={showInspector}>Inspector</button>
      </nav>
      <section ref={leftPane} className="workstation-left" aria-label="Track tools" hidden={!leftShown}>
        <nav aria-label="Track tools"><button aria-pressed={leftTask==='track'} onClick={()=>showTask('track')}>Track</button><button aria-pressed={leftTask==='sound'} onClick={()=>showTask('sound')}>Sound</button><button aria-pressed={leftTask==='backing'} onClick={()=>showTask('backing')}>Backing</button></nav>
        <div className="workstation-task" hidden={leftTask!=='track'}><TrackSettingsPanel score={state.score} selected={target.track} busy={controlsBusy} onEdit={edit}/></div>
        <div className="workstation-task" hidden={leftTask!=='sound'}>
        <SoundPanel trackId={trackId} sound={state.settings.sounds[trackId]} onEdit={command=>controller.edit(command)} playback={player} busy={controlsBusy}/>
        </div><div className="workstation-task" hidden={leftTask!=='backing'}><BackingPanel visible={referenceVisible} settings={originalBacking?undefined:state.settings.backing} originalSettings={state.embeddedBackingSettings?{assetId:'embedded',...state.embeddedBackingSettings}:null} assets={state.snapshot.project.assets} embedded={state.embeddedBacking} playback={player} onEdit={backingEdit} stageBacking={audioBridge.stageBacking} stageEmbeddedBacking={audioBridge.stageEmbeddedBacking} beginOperation={beginEditorOperation} busy={controlsBusy} durationMs={sourceDurationMs??undefined} reference={reference} onShowWaveform={()=>chooseDock('backing')}/>{referenceVisible&&sourceMetadataStatus}</div>
      </section>
      <section ref={scorePane} className="score-workspace" aria-label="Score workspace" tabIndex={0} onKeyDown={keys}>
        <div className="score-tools"><span>{state.score.masterBars.length} measures · {state.score.tracks.length} tracks</span>
          <TrackDisplayControls ids={trackIds} names={state.score.tracks.map(track=>track.name)} selected={target.track} view={trackView} zoom={zoom} disabled={controlsBusy} onView={setTrackView} onZoom={manualZoom} display={display} onDisplay={setScoreDisplay} actualZoom={displayStatus?.zoomPercent} fitLimited={displayStatus?.fitLimited} pageError={displayStatus?.pageError}/>
          <button aria-pressed={instrumentShown} onClick={()=>instrumentShown?setInstrumentVisible(false):chooseDock('instrument')}>{instrumentShown?'Hide instrument':'Show instrument'}</button>
        </div>
        <div className="paper-scroll"><div className="paper score-paper-host"><ScoreView score={state.score} track={target.track} zoom={zoom} display={display} page={page} onDisplayStatus={onDisplayStatus} profile="Default" projection={projection} engraving={state.settings.engraving} visibleTracks={visibleTracks} onSelect={select} playback={player} editorSelection={musicSelection} onEditorSelection={editorSelection} editTarget={target} editString={indexed?undefined:string} editNoteIndex={noteIndex}/></div></div>
        <div className="score-hint">Measure {target.bar+1} · Beat {target.beat+1} · {indexed?`${location.staff.isPercussion?'Percussion':'Pitched'} note ${noteIndex===null?'entry':noteIndex+1} — Click a note to edit it in the inspector.`:`String ${string} · Fret ${fret} — Click the score, then use arrow keys, digits and Enter.`}</div>
      </section>
      <div ref={inspectorPane} className="workstation-inspector" hidden={!inspectorShown}>
      <EditorPanel score={state.score} target={target} string={string} fret={fret} noteIndex={noteIndex} onSelectNote={setNoteIndex} busy={controlsBusy} onSelect={next=>{editorSelection(null);select(next);}} onString={s=>select(target,s)} onFret={setFret} onEdit={edit} musicSelection={musicSelection} onMusicSelection={editorSelection} onChord={()=>openModal('harmony')} onScales={()=>openModal('scale')}
        practiceTools={player&&playbackState&&<PracticePanel key={state.documentEpoch} settings={playbackState.practice.settings} busy={controlsBusy||playbackState.practicePending||!playbackState.ready} hasBacking={!!audioSettings.backing} onChange={settings=>player.setPractice(settings)}/>}
        presentationTools={<><EngravingPanel key={`engraving/${state.documentEpoch}`} score={state.score} trackIds={trackIds} value={state.settings.engraving} busy={controlsBusy} onEdit={edit}/><PageLayoutPanel key={`page/${state.documentEpoch}`} value={page} busy={controlsBusy} onEdit={edit}/></>}>
        <div ref={clipboardSection}><ClipboardPanel score={state.score} target={target} selection={musicSelection} clip={clip} busy={controlsBusy} onCopy={mode=>copyMusic(mode)} onCut={mode=>copyMusic(mode,true)} onPaste={pasteMusic}/></div>
        <HarmonyTransposePanel key={`harmony/${state.documentEpoch}`} score={state.score} selection={musicSelection} busy={controlsBusy} onEdit={edit}/>
      </EditorPanel>
      </div>
      <section className="workstation-dock" aria-label="Bottom dock" hidden={!dockVisible}>
        <nav aria-label="Dock views"><button aria-pressed={!instrumentVisible&&dockMode==='overview'} onClick={()=>chooseDock('overview')}>Overview</button><button aria-pressed={!instrumentVisible&&dockMode==='mixer'} onClick={()=>chooseDock('mixer')}>Mixer</button><button aria-pressed={instrumentVisible} onClick={()=>chooseDock('instrument')}>Instrument</button><button aria-pressed={!instrumentVisible&&dockMode==='backing'} onClick={()=>chooseDock('backing')}>Backing</button><button className="dock-collapse" aria-label={dockCollapsed?'Expand bottom dock':'Hide bottom dock'} onClick={()=>dockCollapsed?setDockForced(true):hideDock()}>{dockCollapsed?'Expand':'Hide'}</button></nav>
        <div className="workstation-dock-content" hidden={dockCollapsed}>
          <div className="workstation-dock-tracks" hidden={instrumentVisible||dockMode==='backing'}><TrackPanel score={state.score} selected={target.track} busy={controlsBusy} player={player} view={dockMode==='mixer'?'mixer':'overview'} target={target} onExitOverview={()=>scorePane.current?.focus()} onSelectPosition={(track,bar)=>select({track,staff:0,bar,voice:0,beat:0})} onSelect={track=>select({track,staff:0,bar:target.bar,voice:0,beat:0},state.score.tracks[track].staves[0].tuning.length)}/></div>
          {instrumentVisible&&<LiveInstrumentView score={state.score} track={target.track} staff={target.staff} player={player}/>}
          <div className="workstation-dock-backing" hidden={instrumentVisible||dockMode!=='backing'}>
            {waveformEnabled&&!referenceVisible&&sourceMetadataStatus}
            {originalBacking&&!currentEmbedded?.source?<div className="backing-waveform-state">{currentEmbedded?.error?<><p role="alert">{currentEmbedded.error}</p><button onClick={()=>setEmbeddedRetry(value=>value+1)}>Retry</button></>:<p role="status">Loading waveform…</p>}</div>:<BackingWaveform document={{documentId:state.documentId,revision:state.revision}} source={waveformSource} filename={state.settings.backing?state.snapshot.project.assets[state.settings.backing.assetId]?.filename??'Backing audio':state.snapshot.project.base.kind==='file'?state.snapshot.project.base.filename:'Backing audio'} bridge={waveformBridge} timeline={backingTimeline} selection={backingSelection} settings={state.settings.backing} effectiveBacking={audioSettings.backing} reference={reference} scoreTimeMs={playbackState?.ready&&!playbackState.error&&!['countIn','ended'].includes(playbackState.practice.phase)?playbackState.time:null} enabled={waveformEnabled} busy={controlsBusy} beginOperation={beginEditorOperation} isCurrent={waveformCurrent} onEdit={command=>controller.edit(command)}/>}
          </div>
        </div>
      </section>
    </div>
    {exportOpen&&<ExportDialog score={state.score} layout={state.settings.print} page={page} currentSpeedAvailable={practiceRatio!==null} busy={exports.busy||state.busy||exportLaunching} progress={exports.progress} failure={exportError} gpBackingIssue={gpBackingIssue} onExport={runExport} onCancel={cancelExport}/>}
    {harmonyOpen&&location.beat&&<HarmonyChordDialog score={state.score} target={target} selection={musicSelection} value={location.beat.chord?getHarmonyChord(location.beat.chord):null} busy={state.busy||libraryLoading} library={library} onEdit={edit} onClose={closeModal} onLibraryPut={async entry=>{const revision=++libraryRevision.current,value=await putHarmonyLibraryEntry(entry);if(revision===libraryRevision.current)setLibrary(value);}} onLibraryRemove={async id=>{const revision=++libraryRevision.current,value=await removeHarmonyLibraryEntry(id);if(revision===libraryRevision.current)setLibrary(value);}}/>}
    {scaleOpen&&<ScaleToolPanel score={state.score} staff={location.staff} selection={musicSelection} busy={state.busy} onClose={closeModal}/>}
    <footer className="statusbar">{state.busy?'Working…':state.snapshot.dirty?'Unsaved changes':state.snapshot.path?'Saved':state.snapshot.project.base.kind==='file'?'Not saved':'New score'}<span>{state.snapshot.path ?? 'Save a .tabplayer project to keep the original score and edits.'}</span>{recoveryStatus}</footer>
  </div>;
}
