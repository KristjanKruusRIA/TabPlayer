import { useCallback,useEffect,useLayoutEffect, useMemo,useRef, useState, useSyncExternalStore, type KeyboardEvent,type ReactNode } from 'react';
import {model,Settings} from '@coderline/alphatab';
import { DocumentController } from './controller';
import { describeSelection, effectiveAudioSettings } from './engine';
import type { BeatTarget, EditCommand } from './project';
import { FINALIZED_MESSAGE, isFinalized, projectCommands } from './project';
import { followSelectedTrack,movedTrackIndex,repairMeasureSelection,repairSelection, validSelectionIndices } from './selection';
import { ScoreView } from './ScoreView';
import { EditorPanel, type InspectorContextScope } from './EditorPanel';
import { TrackPanel } from './TrackPanel';
import './styles.css';
import { NativePlaybackController } from './audio/NativePlaybackController';
import { SoundPanel } from './audio/SoundPanel';
import { SoundRig } from './rig/SoundRig';
import { Segmented } from './ui';
import { InterpretationPanel } from './audio/InterpretationPanel';
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
import { followEntry, type EntryFollow } from './instruments/entry';
import type { MusicSelection } from './editor/range-types';
import { rangeFromBeats,selectionForTrack } from './editor/range-selection';
import { planMeasureMap } from './editor/measures';
import { ClipboardStore } from './editor/ClipboardStore';
import { AUTO_DURATION_UNFIT,InputPreferencesPanel,applyInOrder,autoDurationEdit,autoDurationSkip,entryAfterWrite,numpadDurationEdit,numpadKey,useInputPreferences,type EntryDuration } from './editor/input-preferences';
import { ClipboardPanel } from './editor/ClipboardPanel';
import { NotationEntryPanel } from './editor/NotationEntryPanel';
import { ScoreErrorsPanel } from './editor/ScoreErrorsPanel';
import { CommandPalette } from './editor/CommandPalette';
import { AsciiTabImportDialog } from './workspace/AsciiTabImportDialog';
import { MidiImportDialog } from './workspace/MidiImportDialog';
import { HelpDialog } from './help/HelpDialog';
import { topicFor,type HelpTopicId } from './help/help-topics';
import type { PaletteAction } from './editor/command-palette';
import { ViewDefaultsPanel } from './workspace/ViewDefaultsPanel';
import { currentViewDefaults,writeViewDefaults } from './workspace/view-defaults';
import { findScoreErrors,readScoreErrorDisplay,writeScoreErrorDisplay } from './editor/score-errors';
import { editAudition,readAuditionWhileEditing,tuningAudition,writeAuditionWhileEditing,type TuningAudition } from './audio/audition';
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
  onNew:()=>Promise<boolean>;onOpen:()=>Promise<boolean>;onImportConverted?:(name:string,bytes:Uint8Array)=>Promise<boolean>;onClose:()=>Promise<boolean>;onCloseAll:()=>Promise<boolean>;
  documentTabs:ReactNode;
  sessionMenu?:ReactNode;libraryMenu?:ReactNode;onFileCommandCapture?:(element:HTMLElement)=>void;recoveryStatus?:ReactNode;playbackResumeEpoch?:number;
}

export function App({controller,audioBridge,waveformBridge,exportBridge,documentBridge,documentView,onViewChange,clipboard,workspaceBusy,workspaceError,beginEditorOperation,onNew,onOpen,onImportConverted,onClose,onCloseAll,documentTabs,sessionMenu,libraryMenu,onFileCommandCapture,recoveryStatus,playbackResumeEpoch=0}:AppProps) {
  const state=useSyncExternalStore(controller.subscribe,controller.getState);
  const controlsBusy=state.busy||workspaceBusy;
  // A finalized document refuses every change to its music and layout. This is kept apart from controlsBusy so
  // playback, practice, selection, the mixer, export and save stay usable.
  const editLocked=isFinalized(state.snapshot.project),editBusy=controlsBusy||editLocked;
  const [player,setPlayer]=useState<NativePlaybackController|null>(null);
  const playbackState=useSyncExternalStore(player?.subscribe??noPlaybackSubscribe,()=>player?.getState()??null);
  useEffect(()=>{const playback=new NativePlaybackController({bridge:audioBridge,latestMix:id=>controller.getState().settings.mixes[id],onEdit:command=>controller.edit(command).then(()=>setSelection(old=>repairSelection(controller.getState().score,old)))});setPlayer(playback);return()=>playback.destroy();},[controller,audioBridge]);
  useEffect(()=>{controller.setBeforeChange(()=>player?.beforeScoreChange());return()=>controller.setBeforeChange(()=>{});},[controller,player]);
  const referenceLifetime=useMemo(()=>({active:true}),[controller,waveformBridge]);
  useEffect(()=>{referenceLifetime.active=true;const unbind=controller.setReferenceWaveformBridge(waveformBridge);return()=>{referenceLifetime.active=false;unbind();};},[controller,waveformBridge,referenceLifetime]);
  const [selection,setSelection]=useState<BeatTarget>(documentView.target);
  const [musicSelection,setMusicSelection]=useState<MusicSelection|null>(null),rangeAnchor=useRef<BeatTarget|null>(null);
  const [clipboardVersion,setClipboardVersion]=useState(0),[clipboardError,setClipboardError]=useState<string|null>(null),[contextScope,setContextScope]=useState<InspectorContextScope>('all');
  const [inputPrefs,setInputPrefs]=useInputPreferences(),entryDuration=useRef<EntryDuration|null>(null),[inputNotice,setInputNotice]=useState<{text:string;at:string}|null>(null);
  const [auditionEdits,setAuditionEdits]=useState(readAuditionWhileEditing),auditionEditsNow=useRef(auditionEdits);auditionEditsNow.current=auditionEdits;
  const [markErrors,setMarkErrors]=useState(readScoreErrorDisplay),scoreErrors=useMemo(()=>findScoreErrors(state.score),[state.score]);
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
  /** The centre region shows the score or the Sound rig; the transport and the rest of the shell stay as they are. */
  const [view,setView]=useState<'score'|'sound'>('score');
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
  // A click in the instrument view leaves its clicked fret as the entry fret, even when that note was just removed.
  const entryFret=useRef<{string:number;fret:number;score:model.Score}|null>(null);
  useEffect(()=>{
    const kept=entryFret.current;entryFret.current=null;
    setFret(kept&&kept.score===state.score&&kept.string===string?kept.fret:location.beat?.notes.find(n=>n.string===string)?.fret ?? 0);digits.current.text='';
  },[state.score,target.track,target.staff,target.bar,target.voice,target.beat,string]);
  const act=(job: Promise<unknown>)=>{void job.catch(()=>{});};
  const change=(job:Promise<unknown>)=>{const before=state.score;setClipboardError(null);act(job.then(()=>{const score=controller.getState().score;setSelection(old=>repairSelection(score,followSelectedTrack(before,score,old)));editorSelection(null);}));};
  const edit=(command:EditCommand,after?:(score:model.Score)=>void)=>{
    setClipboardError(null);
    const oldCount=state.score.masterBars.length;
    const wasPlaying=player?.getState().playing??false;
    const landed=controller.edit(command),done=landed.then(()=>{
      const score=controller.getState().score,map=command.type==='insertMeasures'||command.type==='removeMeasures'?planMeasureMap(oldCount,command):null;
      setSelection(old=>map?repairMeasureSelection(score,old,map):repairSelection(score,command.type==='moveTrack'?{...old,track:movedTrackIndex(old.track,command)}:command.type==='duplicateTrack'?{...old,track:command.track+1}:old));
      if(command.type==='pasteMusic')setNoteIndex(null);
      after?.(score);
      if(!('selection'in command)||command.type==='eraseSelection')editorSelection(null);
      // Hearing an entered note is a courtesy: only note-setting edits, and only while nothing is playing.
      if(auditionEditsNow.current&&player&&!wasPlaying&&!player.getState().playing){const heard=editAudition(score,command);if(heard){const current=controller.getState();player.audition({trackId:trackIdentity(score.tracks[heard.track])},heard.notes,heard.durationMs,{project:current.snapshot.project,built:current});}}
    });
    // The outcome is the edit's own: a failing follow-up (selection, audition) does not make a landed edit a refusal.
    act(done);return landed.then(()=>true,()=>false);
  };
  const instrumentEdit=(command:EditCommand,follow:EntryFollow)=>edit(command,score=>{
    const next=followEntry(score,target,follow);
    if(next.string!==undefined){setString(next.string);setFret(next.fret??0);entryFret.current={string:next.string,fret:next.fret??0,score};}
    if(next.noteIndex!==undefined)setNoteIndex(next.noteIndex);
  });
  const auditionTuning:TuningAudition=(source,pitches,strum)=>{const heard=tuningAudition(pitches,strum);player?.audition(source,heard.notes,heard.durationMs);};
  const copyMusic=(mode:ClipboardMode,cut=false)=>{
    if(!musicSelection||controlsBusy||cut&&editLocked)return;setClipboardError(null);
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
    if(!clip||editBusy)return;
    try{
      const source=options?null:scoreFromMusicClip(clip),multi=clip.mode==='multiTrack';
      edit({type:'pasteMusic',clip,options:options??{target:{...target},destinations:source!.tracks.map((track,index)=>({sourceTrack:index,track:target.track+index,staffMap:track.staves.map((_,staff)=>clip.kind==='phrase'?target.staff:staff)})),count:1,placement:clip.kind==='phrase'?'currentBar':'beforeBar',filters:{diagrams:inputPrefs.pasteDiagrams,texts:true,timers:true,trackAutomations:true,masterAutomations:multi,sections:multi}}});
    }catch(reason){setClipboardError(reason instanceof Error?reason.message:String(reason));}
  };
  const showClipboard=()=>{setContextScope('all');showInspector();setClipboardFocus(value=>value+1);};
  const documentAction=(job:Promise<unknown>)=>change(job);
  const [paletteOpen,setPaletteOpen]=useState(false),paletteReturn=useRef<HTMLElement|null>(null);
  const [asciiOpen,setAsciiOpen]=useState(false),asciiReturn=useRef<HTMLElement|null>(null),[midiOpen,setMidiOpen]=useState(false);
  const [helpTopic,setHelpTopic]=useState<HelpTopicId|null>(null),helpReturn=useRef<HTMLElement|null>(null);
  /** Opens help on the topic for what had focus; help only reads, so open scores and edits are untouched. */
  const openHelp=(topic?:HelpTopicId)=>{const focused=document.activeElement instanceof HTMLElement?document.activeElement:null;helpReturn.current=focused;closeCommands(false);setHelpTopic(topic??topicFor(focused));};
  // F1 is heard on the window so it works with nothing focused; it never opens help over another dialog.
  const helpKey=useRef<(event:globalThis.KeyboardEvent)=>void>(()=>{});
  helpKey.current=event=>{
    if(event.key!=='F1'||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey)return;
    event.preventDefault();
    if(event.repeat||helpTopic!==null||exportOpen||harmonyOpen||scaleOpen||paletteOpen||asciiOpen||document.querySelector('[role="dialog"]'))return;
    openHelp();
  };
  useEffect(()=>{const listener=(event:globalThis.KeyboardEvent)=>helpKey.current(event);window.addEventListener('keydown',listener);return ()=>window.removeEventListener('keydown',listener);},[]);
  const closeHelp=()=>{setHelpTopic(null);const back=helpReturn.current;helpReturn.current=null;if(back?.isConnected)back.focus();if(document.activeElement!==back)scorePane.current?.focus();};
  const openAscii=()=>{asciiReturn.current=document.activeElement instanceof HTMLElement?document.activeElement:null;closeCommands(false);setAsciiOpen(true);};
  const openMidi=()=>{asciiReturn.current=document.activeElement instanceof HTMLElement?document.activeElement:null;closeCommands(false);setMidiOpen(true);};
  const closeMidi=()=>{setMidiOpen(false);closeAscii();};
  const closeAscii=()=>{setAsciiOpen(false);const back=asciiReturn.current;asciiReturn.current=null;if(back?.isConnected)back.focus();if(document.activeElement!==back)scorePane.current?.focus();};
  const openPalette=()=>{paletteReturn.current=document.activeElement instanceof HTMLElement?document.activeElement:null;closeCommands(false);setPaletteOpen(true);};
  const closePalette=()=>{
    setPaletteOpen(false);const back=paletteReturn.current;paletteReturn.current=null;
    // A menu button may be hidden once its menu closes; the score then takes focus.
    if(back?.isConnected)back.focus();if(document.activeElement!==back)scorePane.current?.focus();
  };
  /** Runs a palette command through the same paths as the menus and inspector, so edits stay undoable. */
  const runPalette=(action:PaletteAction)=>{
    if(action.kind==='edit'){if(editLocked)setClipboardError(FINALIZED_MESSAGE);else edit(action.command);}
    else if(action.kind==='select'){editorSelection(null);select(action.target);}
    else if(action.name==='undo'){if(state.snapshot.canUndo&&!editLocked)change(controller.undo());}
    else if(action.name==='redo'){if(state.snapshot.canRedo&&!editLocked)change(controller.redo());}
    else if(action.name==='play')shell.current?.querySelector<HTMLButtonElement>('[aria-keyshortcuts="Space"]')?.click();
    else if(action.name==='new')documentAction(onNew());
    else if(action.name==='open')documentAction(onOpen());
    else if(action.name==='importAscii'){if(onImportConverted)openAscii();}
    else if(action.name==='help'||action.name==='about')openHelp(action.name==='about'?'about':undefined);
    else if(action.name==='save'||action.name==='saveAs')act(controller.save(action.name==='saveAs'));
    else openModal('export');
  };
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
    // A finalized document cannot change, so its exports use the layout it already has.
    if(!editLocked&&(options.format==='pdf'||options.format==='print'||options.format==='svg'||options.format==='png')){
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
  const referenceEdit=useReferenceSyncEdit({owner:waveformBridge.owner,document:{documentId:state.documentId,revision:state.revision},sourceKey:sourceAssetId,settings:state.settings.backing,timeline:backingTimeline,durationMs:sourceDurationMs,visible:{number:referenceVisible,waveform:waveformEnabled},busy:editBusy,beginOperation:beginEditorOperation,isCurrent:waveformCurrent,onCommit:async(backing,document)=>{
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
    entryFret.current=null;const fixed=repairSelection(state.score,next);setSelection(fixed);
    setNoteIndex(index!==undefined&&Number.isInteger(index)&&index>=0?index:null);
    const beat=describeSelection(state.score,fixed).beat;
    const count=state.score.tracks[fixed.track].staves[fixed.staff].tuning.length;
    const chosen=Math.max(1,Math.min(s,count));setString(chosen);
    setFret(beat?.notes.find(n=>n.string===chosen)?.fret ?? 0);digits.current.text='';
  };
  function keys(event:KeyboardEvent) {
    if (textEntry(event.target)||(event.target as HTMLElement).tagName==='BUTTON') return;
    const keypad=numpadKey(event,inputPrefs);
    if(keypad){event.preventDefault();const change=location.beat&&!editBusy?numpadDurationEdit(keypad,target,location.beat):null;if(change)void edit(change.command).then(accepted=>{if(accepted)entryDuration.current=change.entry;});return;}
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
    } else if(event.key==='Enter' && location.beat && !editBusy&&!indexed) {
      const beat=location.beat,lead=autoDurationEdit(inputPrefs,target,beat,entryDuration.current),note:EditCommand={type:'setNote',target,string,fret},project=state.snapshot.project;
      // The pair is checked before either edit, so a refused note never leaves a changed rhythm behind; an unfit duration falls back to a plain write.
      const pair=lead!==null&&applyInOrder(project,[lead,note]),why=pair?null:lead&&applyInOrder(project,[note])?AUTO_DURATION_UNFIT:autoDurationSkip(inputPrefs,beat,entryDuration.current);
      setInputNotice(why?{text:why,at:JSON.stringify(target)}:null);
      if(pair)void edit(lead!).then(done=>done&&edit(note));
      else void edit(note).then(accepted=>{if(accepted)entryDuration.current=entryAfterWrite(beat,entryDuration.current);});
      event.preventDefault();return;}
    else return;
    if(event.shiftKey&&(event.key==='ArrowLeft'||event.key==='ArrowRight')){
      const anchor=rangeAnchor.current??target;
      try{setMusicSelection({kind:'range',range:rangeFromBeats(state.score,anchor,next,[{track:target.track,staff:target.staff,voice:target.voice}])});rangeAnchor.current=anchor;}catch{ /* An empty voice has no attack endpoint. */ }
    }else editorSelection(null);
    select(next);event.preventDefault();
  }
  function selectionKeys(event:KeyboardEvent){
    if((event.ctrlKey||event.metaKey)&&event.shiftKey&&!event.altKey&&event.key.toLowerCase()==='p'&&!exportOpen&&!harmonyOpen&&!scaleOpen&&!paletteOpen&&!asciiOpen&&!midiOpen&&helpTopic===null&&!(event.target instanceof Element&&event.target.closest('[role="dialog"]'))){event.preventDefault();if(!event.repeat)openPalette();return;}
    if(textEntry(event.target)||exportOpen||harmonyOpen||scaleOpen||paletteOpen||asciiOpen||midiOpen||helpTopic!==null||(event.target instanceof Element&&event.target.closest('[role="dialog"]')))return;
    const key=event.key.toLowerCase();
    if((event.ctrlKey||event.metaKey)&&!event.altKey&&['n','o','s','z','y'].includes(key)){
      event.preventDefault();if(controlsBusy||event.repeat)return;
      if(key==='n')documentAction(onNew());
      else if(key==='o')documentAction(onOpen());
      else if(key==='s')act(controller.save(event.shiftKey));
      else if(key==='y'||key==='z'&&event.shiftKey){if(state.snapshot.canRedo&&!editLocked)change(controller.redo());}
      else if(state.snapshot.canUndo&&!editLocked)change(controller.undo());
      return;
    }
    if(key===' '&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.repeat&&!(event.target instanceof Element&&event.target.closest('button,summary,a,[role="button"]'))){
      event.preventDefault();event.currentTarget.querySelector<HTMLButtonElement>('[aria-keyshortcuts="Space"]')?.click();return;
    }
    if((event.ctrlKey||event.metaKey)&&['c','x','v'].includes(key)){
      event.preventDefault();if(controlsBusy)return;
      if(editLocked&&(key==='x'||key==='v'))return;
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
      {onImportConverted&&<button disabled={controlsBusy} onClick={openAscii}>Import ASCII tab…</button>}
      {onImportConverted&&<button disabled={controlsBusy} onClick={openMidi}>Import MIDI…</button>}
      <button disabled={controlsBusy} onClick={()=>act(controller.save())}>Save</button>
      <button disabled={controlsBusy} onClick={()=>act(controller.save(true))}>Save As</button>
      <button disabled={controlsBusy} onClick={()=>documentAction(onClose())}>Close score</button>
      <button disabled={controlsBusy} onClick={()=>documentAction(onCloseAll())}>Close all scores</button>
      {editLocked?<button disabled={controlsBusy} onClick={()=>act(controller.setLock(null))}>Unfinalize document</button>:<button disabled={controlsBusy} onClick={()=>act(controller.setLock({kind:'finalized'}))}>Finalize document</button>}
      <button disabled={controlsBusy||exports.busy} onClick={()=>openModal('export')}>Export score</button><button disabled={controlsBusy||exports.busy} onClick={directExport}>Export GP</button>
      {libraryMenu}{sessionMenu}</section></details>
      <details ref={viewMenu} className="command-menu" onToggle={event=>commandToggle(event.currentTarget)}><summary>View</summary><section aria-label="Workspace view">
        <label className="check"><input type="checkbox" checked={leftVisible} onChange={event=>event.target.checked?showTask(leftTask):setLeftVisible(false)}/>Track panel</label>
        <label className="check"><input type="checkbox" checked={inspectorVisible} onChange={event=>event.target.checked?showInspector():setInspectorVisible(false)}/>Inspector</label>
        <label className="check"><input type="checkbox" checked={dockVisible} onChange={event=>setDockVisible(event.target.checked)}/>Bottom dock</label>
        <InputPreferencesPanel preferences={inputPrefs} onChange={setInputPrefs} preview={auditionEdits} onPreview={play=>{setAuditionEdits(play);writeAuditionWhileEditing(play);}}/>
      </section></details>
      <button disabled={editBusy || !state.snapshot.canUndo} onClick={()=>change(controller.undo())}>Undo</button>
      <button disabled={editBusy || !state.snapshot.canRedo} onClick={()=>change(controller.redo())}>Redo</button>
    </nav><Segmented className="view-switch" label="View" value={view} onChange={setView} options={[{value:'score',label:'Score'},{value:'sound',label:'Sound'}]}/><details className="keyboard-help" onToggle={event=>commandToggle(event.currentTarget)} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();event.currentTarget.open=false;event.currentTarget.querySelector('summary')?.focus();}}}><summary>Help</summary><section role="region" aria-label="Keyboard and editing help">
      <div className="help-actions"><button type="button" onClick={()=>openHelp('start')}>Help topics (F1)</button><button type="button" onClick={()=>openHelp('about')}>About and updates</button></div>
      <h2>Keyboard & editing</h2><p>Use these shortcuts outside input fields and dialogs. F1 opens help about the part of the window you are using.</p>
      <dl><dt>Ctrl/Cmd + N / O</dt><dd>New score / Open score</dd><dt>Ctrl/Cmd + S</dt><dd>Save; add Shift for Save As</dd><dt>Ctrl/Cmd + W</dt><dd>Close the current score</dd><dt>Ctrl/Cmd + Tab</dt><dd>Next score; add Shift for the previous score</dd><dt>Ctrl/Cmd + Z</dt><dd>Undo; add Shift to redo. Ctrl/Cmd + Y also redoes.</dd><dt>Space</dt><dd>Play or pause</dd><dt>Ctrl/Cmd + Shift + P</dt><dd>Command palette: type a command such as measure 12, fret 5 or tempo 96</dd></dl>
      <button type="button" onClick={openPalette}>Open command palette</button>
      <h3>With the score focused</h3><dl><dt>Left / Right</dt><dd>Previous / next beat</dd><dt>Up / Down</dt><dd>Change string, or choose a pitched/percussion note</dd><dt>Digits, then Enter</dt><dd>Enter a fret and set the note on a fretted track</dd><dt>Shift + Left/Right</dt><dd>Extend the musical selection</dd><dt>Ctrl/Cmd + A</dt><dd>Select the current track</dd><dt>Ctrl/Cmd + C / X / V</dt><dd>Copy / Cut / Paste music. Add Shift to Copy/Cut for all selected tracks; Shift + Paste opens paste options.</dd><dt>Escape</dt><dd>Clear the musical selection</dd></dl>
      <p>The blue outline marks your edit target. Green follows playback or a selected passage. Use the inspector’s Edit, Practice and Presentation buttons to reach tools; changes apply only when you use their action buttons.</p>
    </section></details><span className="document-title">{state.score.title || 'Untitled'}{state.snapshot.dirty?' •':''}</span>
    </header>
    {documentTabs}
    {editLocked&&<div className="finalized-banner" role="status"><p>Finalized: editing is locked.</p><button disabled={controlsBusy} onClick={()=>act(controller.setLock(null))}>Unfinalize</button></div>}
    {player && <Transport player={player} measures={state.score.masterBars.length} busy={controlsBusy} cursor={target} selection={musicSelection}/>}
    {(clipboardError||workspaceError||state.error||(!exportOpen&&exportError)||pageState.error||harmonyOpen&&libraryError) && <div className="error" role="alert">{clipboardError||workspaceError||state.error||exportError||pageState.error||libraryError}</div>}
    <div ref={workspace} className="workspace workstation-workspace" data-view={view} data-left={leftShown} data-inspector={inspectorShown} data-dock={dockVisible} data-dock-collapsed={dockCollapsed} style={{'--dock-height':`${dockHeight}px`} as React.CSSProperties}>
      <nav ref={paneRail} className="workstation-rail" aria-label="Workspace panes">
        <button data-pane="track" aria-pressed={leftShown&&leftTask==='track'} onClick={()=>showTask('track')}>Track</button><button data-pane="sound" aria-pressed={leftShown&&leftTask==='sound'} onClick={()=>showTask('sound')}>Sound</button><button data-pane="backing" aria-pressed={leftShown&&leftTask==='backing'} onClick={()=>showTask('backing')}>Backing</button><button data-pane="inspector" aria-pressed={inspectorShown} onClick={showInspector}>Inspector</button>
      </nav>
      <section ref={leftPane} className="workstation-left" aria-label="Track tools" hidden={!leftShown}>
        <nav aria-label="Track tools"><button aria-pressed={leftTask==='track'} onClick={()=>showTask('track')}>Track</button><button aria-pressed={leftTask==='sound'} onClick={()=>showTask('sound')}>Sound</button><button aria-pressed={leftTask==='backing'} onClick={()=>showTask('backing')}>Backing</button></nav>
        <div className="workstation-task" hidden={leftTask!=='track'}><TrackSettingsPanel score={state.score} selected={target.track} busy={controlsBusy} locked={editLocked} onEdit={edit} onAudition={auditionTuning}/></div>
        <div className="workstation-task" hidden={leftTask!=='sound'}>
        {view==='score'&&<SoundPanel trackId={trackId} sound={state.settings.sounds[trackId]} onEdit={command=>controller.edit(command)} playback={player} busy={editBusy} shown={leftShown&&leftTask==='sound'}/>}
        <InterpretationPanel trackId={trackId} mix={state.settings.mixes[trackId]} stringed={selectedTrack.staves.some(staff=>staff.isStringed)} busy={controlsBusy} onEdit={command=>controller.edit(command)}/>
        </div><div className="workstation-task" hidden={leftTask!=='backing'}><BackingPanel visible={referenceVisible} settings={originalBacking?undefined:state.settings.backing} originalSettings={state.embeddedBackingSettings?{assetId:'embedded',...state.embeddedBackingSettings}:null} assets={state.snapshot.project.assets} embedded={state.embeddedBacking} playback={player} onEdit={backingEdit} stageBacking={audioBridge.stageBacking} stageEmbeddedBacking={audioBridge.stageEmbeddedBacking} beginOperation={beginEditorOperation} busy={editBusy} durationMs={sourceDurationMs??undefined} reference={reference} onShowWaveform={()=>chooseDock('backing')}/>{referenceVisible&&sourceMetadataStatus}</div>
      </section>
      <section ref={scorePane} className="score-workspace" aria-label="Score workspace" tabIndex={0} onKeyDown={keys}>
        <div className="score-tools"><span>{state.score.masterBars.length} measures · {state.score.tracks.length} tracks</span>
          <TrackDisplayControls ids={trackIds} names={state.score.tracks.map(track=>track.name)} selected={target.track} view={trackView} zoom={zoom} disabled={controlsBusy} onView={setTrackView} onZoom={manualZoom} display={display} onDisplay={setScoreDisplay} actualZoom={displayStatus?.zoomPercent} fitLimited={displayStatus?.fitLimited} pageError={displayStatus?.pageError}/>
          <button aria-pressed={instrumentShown} onClick={()=>instrumentShown?setInstrumentVisible(false):chooseDock('instrument')}>{instrumentShown?'Hide instrument':'Show instrument'}</button>
        </div>
        <div className="paper-scroll"><div className="paper score-paper-host"><ScoreView score={state.score} track={target.track} zoom={zoom} display={display} page={page} onDisplayStatus={onDisplayStatus} profile="Default" projection={projection} engraving={state.settings.engraving} visibleTracks={visibleTracks} onSelect={select} playback={player} editorSelection={musicSelection} onEditorSelection={editorSelection} editTarget={target} editString={indexed?undefined:string} editNoteIndex={noteIndex} errors={markErrors?scoreErrors:undefined}/></div></div>
        {inputNotice&&inputNotice.at===JSON.stringify(target)&&<div className="score-hint" role="status">{inputNotice.text}</div>}
        <div className="score-hint">Measure {target.bar+1} · Beat {target.beat+1} · {indexed?`${location.staff.isPercussion?'Percussion':'Pitched'} note ${noteIndex===null?'entry':noteIndex+1} — Click a note to edit it in the inspector.`:`String ${string} · Fret ${fret} — Click the score, then use arrow keys, digits and Enter.`}</div>
      </section>
      <div ref={inspectorPane} className="workstation-inspector" hidden={!inspectorShown}>
      <EditorPanel contextScope={contextScope} onContextScopeChange={setContextScope} score={state.score} target={target} string={string} fret={fret} noteIndex={noteIndex} onSelectNote={setNoteIndex} busy={controlsBusy} locked={editLocked} onSelect={next=>{editorSelection(null);select(next);}} onString={s=>select(target,s)} onFret={setFret} onEdit={edit} musicSelection={musicSelection} onMusicSelection={editorSelection} onChord={()=>openModal('harmony')} onScales={()=>openModal('scale')} onAudition={auditionTuning}
        practiceTools={player&&playbackState&&<PracticePanel key={state.documentEpoch} settings={playbackState.practice.settings} busy={controlsBusy||playbackState.practicePending||!playbackState.ready} hasBacking={!!audioSettings.backing} onChange={settings=>player.setPractice(settings)}/>}
        presentationTools={<><EngravingPanel key={`engraving/${state.documentEpoch}`} score={state.score} trackIds={trackIds} value={state.settings.engraving} busy={controlsBusy} onEdit={edit}/><PageLayoutPanel key={`page/${state.documentEpoch}`} value={page} busy={controlsBusy} onEdit={edit}/></>} presentationViewTools={<ViewDefaultsPanel current={{zoom,trackView,scoreDisplay}} load={currentViewDefaults} onSave={writeViewDefaults}/>}>
        <NotationEntryPanel score={state.score} target={target} busy={controlsBusy} locked={editLocked} onEdit={instrumentEdit} latestScore={()=>controller.getState().score}/>
        <div ref={clipboardSection}><ClipboardPanel score={state.score} target={target} selection={musicSelection} clip={clip} busy={controlsBusy} locked={editLocked} onCopy={mode=>copyMusic(mode)} onCut={mode=>copyMusic(mode,true)} onPaste={pasteMusic} diagramsDefault={inputPrefs.pasteDiagrams}/></div>
        <ScoreErrorsPanel errors={scoreErrors} mark={markErrors} onMark={mark=>{setMarkErrors(mark);writeScoreErrorDisplay(mark);}} onSelect={next=>select(next)} shownTracks={visibleTracks}/>
        <HarmonyTransposePanel key={`harmony/${state.documentEpoch}`} score={state.score} selection={musicSelection} busy={editBusy} onEdit={edit}/>
      </EditorPanel>
      </div>
      {view==='sound'&&<SoundRig trackId={trackId} sound={state.settings.sounds[trackId]} onEdit={command=>controller.edit(command)} playback={player} busy={editBusy}
        tracks={state.score.tracks.map((track,index)=>({id:trackIds[index],name:track.name||`Track ${index+1}`}))}
        onTrack={id=>{const index=trackIds.indexOf(id);if(index>=0)select({track:index,staff:0,bar:target.bar,voice:0,beat:0},state.score.tracks[index].staves[0].tuning.length);}}/>}
      <section className="workstation-dock" aria-label="Bottom dock" hidden={!dockVisible}>
        <nav aria-label="Dock views"><button aria-pressed={!instrumentVisible&&dockMode==='overview'} onClick={()=>chooseDock('overview')}>Overview</button><button aria-pressed={!instrumentVisible&&dockMode==='mixer'} onClick={()=>chooseDock('mixer')}>Mixer</button><button aria-pressed={instrumentVisible} onClick={()=>chooseDock('instrument')}>Instrument</button><button aria-pressed={!instrumentVisible&&dockMode==='backing'} onClick={()=>chooseDock('backing')}>Backing</button><button className="dock-collapse" aria-label={dockCollapsed?'Expand bottom dock':'Hide bottom dock'} onClick={()=>dockCollapsed?setDockForced(true):hideDock()}>{dockCollapsed?'Expand':'Hide'}</button></nav>
        <div className="workstation-dock-content" hidden={dockCollapsed}>
          <div className="workstation-dock-tracks" hidden={instrumentVisible||dockMode==='backing'}><TrackPanel score={state.score} selected={target.track} busy={controlsBusy} player={player} view={dockMode==='mixer'?'mixer':'overview'} target={target} onExitOverview={()=>scorePane.current?.focus()} onSelectPosition={(track,bar)=>select({track,staff:0,bar,voice:0,beat:0})} onSelect={track=>select({track,staff:0,bar:target.bar,voice:0,beat:0},state.score.tracks[track].staves[0].tuning.length)}/></div>
          {instrumentVisible&&<LiveInstrumentView score={state.score} track={target.track} staff={target.staff} target={target} player={player} onEdit={instrumentEdit} busy={controlsBusy} locked={editLocked} string={string}/>}
          <div className="workstation-dock-backing" hidden={instrumentVisible||dockMode!=='backing'}>
            {waveformEnabled&&!referenceVisible&&sourceMetadataStatus}
            {originalBacking&&!currentEmbedded?.source?<div className="backing-waveform-state">{currentEmbedded?.error?<><p role="alert">{currentEmbedded.error}</p><button onClick={()=>setEmbeddedRetry(value=>value+1)}>Retry</button></>:<p role="status">Loading waveform…</p>}</div>:<BackingWaveform document={{documentId:state.documentId,revision:state.revision}} source={waveformSource} filename={state.settings.backing?state.snapshot.project.assets[state.settings.backing.assetId]?.filename??'Backing audio':state.snapshot.project.base.kind==='file'?state.snapshot.project.base.filename:'Backing audio'} bridge={waveformBridge} timeline={backingTimeline} selection={backingSelection} settings={state.settings.backing} effectiveBacking={audioSettings.backing} reference={reference} scoreTimeMs={playbackState?.ready&&!playbackState.error&&!['countIn','ended'].includes(playbackState.practice.phase)?playbackState.time:null} enabled={waveformEnabled} busy={editBusy} beginOperation={beginEditorOperation} isCurrent={waveformCurrent} onEdit={command=>controller.edit(command)}/>}
          </div>
        </div>
      </section>
    </div>
    {exportOpen&&<ExportDialog layoutLocked={editLocked} score={state.score} layout={state.settings.print} page={page} currentSpeedAvailable={practiceRatio!==null} busy={exports.busy||state.busy||exportLaunching} progress={exports.progress} failure={exportError} gpBackingIssue={gpBackingIssue} onExport={runExport} onCancel={cancelExport}/>}
    {harmonyOpen&&location.beat&&<HarmonyChordDialog score={state.score} target={target} selection={musicSelection} value={location.beat.chord?getHarmonyChord(location.beat.chord):null} busy={state.busy||libraryLoading} library={library} onEdit={edit} onClose={closeModal} onLibraryPut={async entry=>{const revision=++libraryRevision.current,value=await putHarmonyLibraryEntry(entry);if(revision===libraryRevision.current)setLibrary(value);}} onLibraryRemove={async id=>{const revision=++libraryRevision.current,value=await removeHarmonyLibraryEntry(id);if(revision===libraryRevision.current)setLibrary(value);}}/>}
    {helpTopic!==null&&<HelpDialog initial={helpTopic} onClose={closeHelp}/>}
    {asciiOpen&&onImportConverted&&<AsciiTabImportDialog busy={controlsBusy} onImport={(name,bytes)=>{const job=onImportConverted(name,bytes);documentAction(job);return job;}} onClose={closeAscii}/>}
    {midiOpen&&onImportConverted&&<MidiImportDialog busy={controlsBusy} onImport={(name,bytes)=>{const job=onImportConverted(name,bytes);documentAction(job);return job;}} onClose={closeMidi}/>}
    {paletteOpen&&<CommandPalette context={{score:state.score,target,string,canUndo:state.snapshot.canUndo,canRedo:state.snapshot.canRedo,locked:editLocked}} busy={controlsBusy} onRun={runPalette} onClose={closePalette}/>}
    {scaleOpen&&<ScaleToolPanel score={state.score} staff={location.staff} selection={musicSelection} busy={state.busy} target={target} beat={location.beat} onEdit={editLocked?undefined:edit} onClose={closeModal}/>}
    <footer className="statusbar">{state.busy?'Working…':state.snapshot.dirty?'Unsaved changes':state.snapshot.path?'Saved':state.snapshot.project.base.kind==='file'?'Not saved':'New score'}<span>{state.snapshot.path ?? 'Save a .tabplayer project to keep the original score and edits.'}</span>{recoveryStatus}</footer>
  </div>;
}
