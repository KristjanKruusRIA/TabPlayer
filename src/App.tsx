import { useCallback,useEffect,useLayoutEffect, useMemo,useRef, useState, useSyncExternalStore, type KeyboardEvent,type ReactNode } from 'react';
import {model,Settings} from '@coderline/alphatab';
import { DocumentController } from './controller';
import { describeSelection, effectiveAudioSettings, previewEdit } from './engine';
import type { BeatTarget, EditCommand } from './project';
import type { SequenceStep } from './edit-types';
import { isEditPasswordLocked, isFinalized, projectCommands } from './project';
import { ProtectionDialog,UnlockEditingDialog } from './protection/PasswordDialogs';
import { busyGuard } from './ui/useBusyGuard';
import { followSelectedTrack,movedTrackIndex,repairMeasureSelection,repairSelection, validSelectionIndices } from './selection';
import { ScoreView } from './ScoreView';
import { EditorPanel, type InspectorContextScope } from './EditorPanel';
import { MasterPanel } from './audio/MasterPanel';
type InspectorTab='song'|'track'|'selection';
import { TrackPanel } from './TrackPanel';
import { trackColorHex } from './track-color';
import './styles.css';
import { NativePlaybackController } from './audio/NativePlaybackController';
import { useLoopPassage } from './audio/useLoopPassage';
import { SoundPanel } from './audio/SoundPanel';
import { MixerView } from './mixer/MixerView';
import { SoundRig } from './rig/SoundRig';
import { CabinetResponse } from './audio/CabinetResponse';
import { Segmented } from './ui';
import { AmpGlyph,ExportGlyph,FretboardGlyph,MarkGlyph,MixerGlyph,NoteEntryGlyph,PaletteGlyph,PanelBottomGlyph,PanelRightGlyph,PracticeGlyph,RedoGlyph,ScoreGlyph,UndoGlyph } from './shell/glyphs';
import { InterpretationPanel } from './audio/InterpretationPanel';
import { MidiOutPanel } from './audio/MidiOutPanel';
import { nativeMidiOut } from './audio/midi-out';
import { readMidiOutDelay } from './audio/midi-out-preferences';
import { CabinetNotices } from './audio/CabinetNotices';
import { CaptureNotices } from './audio/CaptureNotices';
import { PluginNotices } from './audio/PluginNotices';
import { usePluginMoves, usePluginNotices, usePluginStatus } from './audio/usePluginStatus';
import { onPluginStatus, onPluginEditorClosed, pluginConsentGrant, pluginNotices, pluginRetry, handlePluginEditorClosed } from './audio/plugin-host';
import { AmpCapture } from './audio/AmpCapture';
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
import { Transport, type TransportDisplay } from './Transport';
import { barCompletion } from './editor/bar-completion';
import { DockResizeHandle,InspectorResizeHandle } from './workstation/DockResizeHandle';
import { readPanelSizes,writePanelSizes } from './workstation/panel-sizes';
import { LiveInstrumentView } from './instruments/LiveInstrumentView';
import { followEntry, type EntryFollow } from './instruments/entry';
import type { MusicSelection } from './editor/range-types';
import { rangeFromBeats,resolveSelectionBeats,resolveSelectionNotes,selectionForTrack,singleBeatSelection } from './editor/range-selection';
import { beatAddress,gp8CursorTarget,gp8Key,planTechniqueToggle } from './editor/gp8-keys';
import { planMeasureMap } from './editor/measures';
import { ClipboardStore } from './editor/ClipboardStore';
import { useI18n, type LanguagePreference, type MessageKey } from './i18n';
import { durationKeyEdit,letterPitch,movedPitch,planNoteMove,planScoreEntry,respellNote,scoreEntryKey,selectedNote,stepEntryPitch,type AccidentalChord,type EntryPlan,type EntryRefusal,type ScoreEntryKey } from './editor/score-entry';
import { accidentalLabelKeys,enterPitch } from './editor/notation-entry';
import { AUTO_DURATION_UNFIT,InputPreferencesPanel,applyInOrder,autoDurationEdit,autoDurationSkip,entryAfterWrite,numpadDurationEdit,numpadKey,useInputPreferences,type EntryDuration } from './editor/input-preferences';
import { ClipboardPanel } from './editor/ClipboardPanel';
import { NotationEntryPanel } from './editor/NotationEntryPanel';
import { ScoreErrorsPanel } from './editor/ScoreErrorsPanel';
import { SectionsPanel } from './editor/SectionsPanel';
import { listSections } from './editor/sections';
import { CommandPalette } from './editor/CommandPalette';
import { AsciiTabImportDialog } from './workspace/AsciiTabImportDialog';
import { MidiImportDialog } from './workspace/MidiImportDialog';
import { BatchConvertDialog } from './batch/BatchConvertDialog';
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
import { TunerPanel } from './audio/TunerPanel';
import { LineInPanel,useLineInRunning } from './audio/LineInPanel';
import { EngravingPanel } from './engraving/EngravingPanel';
import { PageLayoutPanel } from './engraving/PageLayoutPanel';
import { BarWidthsPanel } from './engraving/BarWidthsPanel';
import { SystemGapsPanel } from './engraving/SystemGapsPanel';
import { StaffGroupsPanel } from './engraving/StaffGroupsPanel';
import { selectedGapBar } from './engraving/selected-gap-bar';
import type { SystemSpan } from './engraving/system-gaps';
import { barScaleOf,sourceWeight,withBarScale } from './engraving/bar-widths';
import { TrackDisplayControls } from './engraving/TrackDisplayControls';
import { projectEngraving } from './engraving/projection';
import { engravingRenderKey } from './engraving/system-gaps';
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
import './workstation/gp-shell.css';
const noPlaybackSubscribe=()=>()=>{};
/** A keyboard entry key that waits for the edit before it. Which key it is (the Plus/Minus swap, the keypad durations) is settled when it is pressed; the cursor, the pending accidental and the fret are read when its turn comes. */
type EntryItem=
  |{kind:'keypad';keypad:NonNullable<ReturnType<typeof numpadKey>>}
  |{kind:'entry';key:ScoreEntryKey;shift:boolean}
  |{kind:'digit';digit:string}
  |{kind:'enter'};
interface QueuedEntryKey{item:EntryItem;at:number;documentId:string}
const ENTRY_QUEUE_MAX=8,ENTRY_QUEUE_STALE_MS=2000;
const textEntry=(target:EventTarget)=>target instanceof HTMLElement&&(['INPUT','SELECT','TEXTAREA'].includes(target.tagName)&&!(target instanceof HTMLInputElement&&target.type==='range')||target.isContentEditable);

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
  const { t, preference, setPreference } = useI18n();
  const state=useSyncExternalStore(controller.subscribe,controller.getState);
  const controlsBusy=state.busy||workspaceBusy;
  // A finalized document refuses every change to its music and layout. This is kept apart from controlsBusy so
  // playback, practice, selection, the mixer, export and save stay usable.
  // A password to edit that has not been given in this session refuses changes the same way, but is lifted by the password, not by unfinalizing.
  const finalized=isFinalized(state.snapshot.project),passwordLocked=isEditPasswordLocked(state.snapshot),editLocked=finalized||passwordLocked,editBusy=controlsBusy||editLocked;
  const lockedMessage=finalized?t('project.finalized'):t('project.edit_locked');
  const [player,setPlayer]=useState<NativePlaybackController|null>(null);
  const playbackState=useSyncExternalStore(player?.subscribe??noPlaybackSubscribe,()=>player?.getState()??null);
  const loopPassage=useLoopPassage(player,playbackState);
  useEffect(()=>{const playback=new NativePlaybackController({bridge:audioBridge,latestMix:id=>controller.getState().settings.mixes[id],latestMaster:()=>controller.getState().settings.master,onEdit:command=>controller.edit(command).then(()=>setSelection(old=>repairSelection(controller.getState().score,old)))});setPlayer(playback);return()=>playback.destroy();},[controller,audioBridge]);
  useEffect(()=>{controller.setBeforeChange(bars=>player?.beforeScoreChange(true,bars));return()=>controller.setBeforeChange(()=>{});},[controller,player]);
  const referenceLifetime=useMemo(()=>({active:true}),[controller,waveformBridge]);
  useEffect(()=>{referenceLifetime.active=true;const unbind=controller.setReferenceWaveformBridge(waveformBridge);return()=>{referenceLifetime.active=false;unbind();};},[controller,waveformBridge,referenceLifetime]);
  const pluginStatuses = usePluginStatus(state.documentId);
  const pluginMoves = usePluginMoves(pluginStatuses);
  const pluginNoticeList = usePluginNotices(state.documentId);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onPluginStatus(payload => {
      if (payload.documentId === state.documentId) {
        if (player && typeof player.refreshSounds === 'function') {
          void player.refreshSounds().catch(() => {});
        }
      }
    }).then(fn => { unlisten = fn; }, () => {});
    return () => { unlisten?.(); };
  }, [state.documentId, player]);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onPluginEditorClosed(payload => {
      handlePluginEditorClosed(payload, state.documentId, controller);
    }).then(fn => { unlisten = fn; }, () => {});
    return () => { unlisten?.(); };
  }, [state.documentId, controller]);
  const [selection,setSelection]=useState<BeatTarget>(documentView.target);
  const [musicSelection,setMusicSelection]=useState<MusicSelection|null>(null),rangeAnchor=useRef<BeatTarget|null>(null);
  const [clipboardVersion,setClipboardVersion]=useState(0),[clipboardError,setClipboardError]=useState<string|null>(null),[contextScope,setContextScope]=useState<InspectorContextScope>('all'),[measureRequest,setMeasureRequest]=useState(0),[lyricsRequest,setLyricsRequest]=useState(0);
  const [inputPrefs,setInputPrefs]=useInputPreferences(),entryDuration=useRef<EntryDuration|null>(null),[inputNotice,setInputNotice]=useState<{text:string;at:string}|null>(null);
  // Note entry on the score: a viewer mode, off at start. `entryNear` is the written pitch letters are entered near.
  const [noteEntryOn,setNoteEntryOn]=useState(false),entryNear=useRef(64);
  // The accidental a Ctrl+7/8/9 chord set for the next note typed or clicked; cleared by use, Escape, entry off, a selection change, a note move (Ctrl+Alt/Alt+Shift/Ctrl+Shift+Up/Down) and a document switch.
  const [pendingAccidental,setPendingAccidental]=useState<AccidentalChord|null>(null);
  // Keys typed while this app's own edit is still being recorded wait here, in order, and run one at a time (see `drainEntry`).
  // `ownEdits` counts the edits `edit` has started and not yet finished following up (selection moved); `settled` is bumped right after each one,
  // so the drain never plans a key against a cursor the previous edit has not moved yet. `entryFailure` records that the previous key was refused or did not land.
  const entryQueue=useRef<QueuedEntryKey[]>([]),ownEdits=useRef(0),draining=useRef(false),entryFailure=useRef<{text:string|null}|null>(null),[settled,setSettled]=useState(0);
  // `unseenSettles` are edits whose follow-up has run but whose render has not committed yet; they stay in `ownEdits` until the drain effect (which runs after that commit) takes them off.
  const unseenSettles=useRef(0),refusing=useRef(false);
  // Clearing the queue also lifts the refusal latch (see `refusing` in `keys`).
  const clearEntryQueue=()=>{entryQueue.current=[];refusing.current=false;};
  const [auditionEdits,setAuditionEdits]=useState(readAuditionWhileEditing),auditionEditsNow=useRef(auditionEdits);auditionEditsNow.current=auditionEdits;
  const [markErrors,setMarkErrors]=useState(readScoreErrorDisplay),scoreErrors=useMemo(()=>findScoreErrors(state.score),[state.score]),sections=useMemo(()=>listSections(state.score),[state.score]);
  const clip=useMemo(()=>clipboard.get(),[clipboard,clipboardVersion]),clipboardSection=useRef<HTMLDivElement>(null);
  useEffect(()=>{setMusicSelection(null);rangeAnchor.current=null;},[state.documentEpoch]);
  const editorSelection=(value:MusicSelection|null)=>{rangeAnchor.current=null;setMusicSelection(value);};
  const [selectedString,setString]=useState(documentView.selectedString); const [fret,setFret]=useState(0);
  const [selectedNoteIndex,setNoteIndex]=useState<number|null>(documentView.selectedNoteIndex);
  const [zoom,setZoom]=useState(documentView.zoom),[trackView,setTrackView]=useState<TrackView>(documentView.trackView);
  const [scoreDisplay,setScoreDisplay]=useState<ScoreDisplayPreferences|undefined>(documentView.scoreDisplay);
  const display=useMemo(()=>resolveScoreDisplay(scoreDisplay),[scoreDisplay]);
  const [barDesign,setBarDesign]=useState(false),barWidthsHonoured=display.layout!=='verticalScreen'&&display.layout!=='horizontalScreen';
  const [renderedSystems,setRenderedSystems]=useState<SystemSpan[]|null>(null),systemGapsLayout=display.layout==='verticalPage'||display.layout==='horizontalPage'||display.layout==='grid';
  const [displayStatus,setDisplayStatus]=useState<{zoomPercent:number;fitLimited:boolean;pageError:string|null}|null>(null);
  const [fontStatus,setFontStatus]=useState<{failed:string[];substituted:string[]}|null>(null);
  const onDisplayStatus=useCallback((status:{zoomPercent:number;fitLimited:boolean;pageError:string|null})=>{
    setDisplayStatus(old=>old&&old.zoomPercent===status.zoomPercent&&old.fitLimited===status.fitLimited&&old.pageError===status.pageError?old:status);
  },[]);
  const manualZoom=(value:number)=>{setZoom(value);setScoreDisplay(old=>old&&old.zoomMode!=='manual'?{...old,zoomMode:'manual'}:old);};
  const [instrumentVisible,setInstrumentVisible]=useState(documentView.instrumentVisible);
  /** The keyboard's own dock panel. Neither the document nor the user's settings keep it: it is a choice for this open document only. */
  const [keyboardVisible,setKeyboardVisible]=useState(false);
  const dockPanelVisible=instrumentVisible||keyboardVisible;
  const [paletteVisible,setPaletteVisible]=useState(true),[paletteHost,setPaletteHost]=useState<HTMLElement|null>(null);
  const [songHost,setSongHost]=useState<HTMLElement|null>(null),[practiceHost,setPracticeHost]=useState<HTMLElement|null>(null);
  const [inspectorVisible,setInspectorVisible]=useState(true),[dockVisible,setDockVisible]=useState(true);
  /** The inspector shows the whole song, the current track, or the editors for the selection, as GP's Song and Track tabs do. */
  const [inspectorTab,setInspectorTab]=useState<InspectorTab>('selection');
  /** The centre region shows the score or the Sound rig; the transport and the rest of the shell stay as they are. */
  const [view,setView]=useState<'score'|'sound'|'mixer'>('score');
  const [viewport,setViewport]=useState(()=>({width:window.innerWidth,height:window.innerHeight}));
  const [dockMode,setDockMode]=useState<'overview'|'mixer'|'backing'>('overview'),[dockForced,setDockForced]=useState(false),[waveformOpened,setWaveformOpened]=useState(false);
  const shell=useRef<HTMLDivElement>(null),workspace=useRef<HTMLDivElement>(null),scorePane=useRef<HTMLElement>(null),commandBar=useRef<HTMLElement>(null);
  const inspectorPane=useRef<HTMLDivElement>(null),viewMenu=useRef<HTMLDetailsElement>(null),practiceMenu=useRef<HTMLDetailsElement>(null);
  const lineInOn=useLineInRunning();
  // The MIDI output delay is kept with the app; the native side starts at none until it is told.
  useEffect(()=>{void nativeMidiOut.setDelay(readMidiOutDelay()).catch(()=>{});},[]);
  const paneFocusIntent=useRef<InspectorTab|null>(null),[paneFocusTick,setPaneFocusTick]=useState(0);
  const [workspaceHeight,setWorkspaceHeight]=useState(Infinity),[workspaceWidth,setWorkspaceWidth]=useState(Infinity),[clipboardFocus,setClipboardFocus]=useState(0);
  const narrow=viewport.width<1180,inspectorShown=inspectorVisible;
  const autoDockHeight=dockPanelVisible?(viewport.height<800?160:184):(viewport.height<800?dockMode==='backing'?176:144:viewport.width>=1440?192:176);
  // A height the user dragged to stays within reach of the score: it never grows into the collapse threshold below.
  // Dragged sizes are kept for the user between runs; a kept size is clamped to the current window, never rewritten by it.
  const [panelSizes,setPanelSizes]=useState(readPanelSizes),dockSize=panelSizes.dock;
  const setDockSize=(dock:number|null)=>setPanelSizes(old=>old.dock===dock?old:{...old,dock});
  const setInspectorSize=(inspector:number|null)=>setPanelSizes(old=>old.inspector===inspector?old:{...old,inspector});
  useEffect(()=>{writePanelSizes(panelSizes);},[panelSizes]);
  // The inspector never squeezes the score below 480px; at the 960px minimum window it can still reach 480px itself.
  const autoInspectorWidth=narrow?264:304,inspectorMin=240,inspectorMax=Math.max(inspectorMin,Math.min(560,Number.isFinite(workspaceWidth)?workspaceWidth-480:560));
  const inspectorWidth=panelSizes.inspector===null?autoInspectorWidth:Math.min(inspectorMax,Math.max(inspectorMin,panelSizes.inspector));
  const dockMin=96,dockMax=Math.max(dockMin,Math.min(460,Number.isFinite(workspaceHeight)?workspaceHeight-200:460));
  const dockHeight=dockSize===null?autoDockHeight:Math.min(dockMax,Math.max(dockMin,dockSize));
  const dockCollapsed=dockVisible&&!dockForced&&workspaceHeight-dockHeight<200;
  const instrumentShown=dockPanelVisible&&dockVisible&&!dockCollapsed;
  const requestPaneFocus=(tab:InspectorTab)=>{paneFocusIntent.current=tab;setPaneFocusTick(value=>value+1);};
  useEffect(()=>{const resize=()=>setViewport({width:window.innerWidth,height:window.innerHeight});window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize);},[]);
  useLayoutEffect(()=>{if(!workspace.current||typeof ResizeObserver==='undefined')return;const observer=new ResizeObserver(entries=>{const rect=entries[0]?.contentRect;if(rect?.height>0)setWorkspaceHeight(rect.height);if(rect?.width>0)setWorkspaceWidth(rect.width);});observer.observe(workspace.current);return()=>observer.disconnect();},[]);
  const closeCommands=(focus=false)=>{commandBar.current?.querySelectorAll<HTMLDetailsElement>('details[open]').forEach(details=>{details.open=false;if(focus)details.querySelector('summary')?.focus();});};
  const commandToggle=(current:HTMLDetailsElement)=>{if(current.open)commandBar.current?.querySelectorAll<HTMLDetailsElement>('details[open]').forEach(other=>{if(other!==current)other.open=false;});};
  useEffect(()=>{const outside=(event:PointerEvent)=>{if(event.target instanceof Node&&!commandBar.current?.contains(event.target))closeCommands(true);};document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside);},[]);
  useLayoutEffect(()=>{const tab=paneFocusIntent.current;if(!tab)return;paneFocusIntent.current=null;if(document.activeElement instanceof Element&&document.activeElement.closest('[role="dialog"]'))return;inspectorPane.current?.querySelector<HTMLElement>(`[data-inspector-tab="${tab}"]`)?.focus();},[paneFocusTick,inspectorShown,inspectorTab]);
  useLayoutEffect(()=>{if(!clipboardFocus)return;const section=clipboardSection.current?.querySelector('details');if(section){for(let parent=section.parentElement;parent;parent=parent.parentElement)if(parent instanceof HTMLDetailsElement)parent.open=true;section.open=true;section.querySelector('summary')?.focus();section.scrollIntoView?.({block:'nearest'});}},[clipboardFocus]);
  /** Shows the inspector on a tab and moves focus to that tab, as a menu command or toolbar button does. */
  const openInspector=(tab:InspectorTab=inspectorTab,scope?:InspectorContextScope)=>{closeCommands();setInspectorVisible(true);setInspectorTab(tab);if(scope)setContextScope(scope);requestPaneFocus(tab);};
  // The dock's + opens the Track tab with Add instrument unfolded and its name field focused.
  const startAddTrack=()=>{openInspector('track');setTimeout(()=>{const details=document.querySelector<HTMLDetailsElement>('.workstation-inspector details.track-add');if(!details)return;details.open=true;details.scrollIntoView?.({block:'nearest'});details.querySelector<HTMLInputElement>('input')?.focus();},0);};
  const showInspector=()=>openInspector();
  const chooseDock=(mode:'overview'|'mixer'|'instrument'|'keyboard'|'backing')=>{setDockVisible(true);setDockForced(true);setInstrumentVisible(mode==='instrument');setKeyboardVisible(mode==='keyboard');if(mode!=='instrument'&&mode!=='keyboard')setDockMode(mode);if(mode==='backing')setWaveformOpened(true);};
  const hideDock=()=>{setDockVisible(false);viewMenu.current?.querySelector('summary')?.focus();};
  const [harmonyOpen,setHarmonyOpen]=useState(false),[scaleOpen,setScaleOpen]=useState(false),[libraryLoading,setLibraryLoading]=useState(false),[libraryError,setLibraryError]=useState<string|null>(null);
  const [library,setLibrary]=useState<HarmonyLibrary>({format:'TabPlayerHarmonyLibrary',version:1,entries:[]});
  const libraryRevision=useRef(0);
  useEffect(()=>{setHarmonyOpen(false);setScaleOpen(false);},[state.documentEpoch]);
  useEffect(()=>{
    if(!harmonyOpen)return;let active=true;const revision=++libraryRevision.current;setLibraryLoading(true);setLibraryError(null);
    void readHarmonyLibrary().then(value=>{if(active&&revision===libraryRevision.current)setLibrary(value);}).catch(error=>{if(active&&revision===libraryRevision.current)setLibraryError(t('app.chord_library_error',{error:error instanceof Error?error.message:String(error)}));}).finally(()=>{if(active&&revision===libraryRevision.current)setLibraryLoading(false);});
    return()=>{active=false;};
  },[harmonyOpen]);
  const digits=useRef({text:'',time:0});
  const [pendingFret,setPendingFret]=useState<string|null>(null);
  /** The fret in place before the first pending digit (the note's, or one seeded from the instrument view): Escape and Backspace put it back. */
  const fretBase=useRef<number|null>(null),pendingTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  /** Ends the pending state. The digit window lasts a second, so the hint goes with it. */
  const endPending=()=>{if(pendingTimer.current!==null){clearTimeout(pendingTimer.current);pendingTimer.current=null;}fretBase.current=null;digits.current.text='';setPendingFret(null);};
  useEffect(()=>()=>{if(pendingTimer.current!==null)clearTimeout(pendingTimer.current);},[]);
  const target=repairSelection(state.score,selection);
  const gapBar=selectedGapBar(musicSelection,target.bar);
  const tunerStaff=state.score.tracks[target.track]?.staves[target.staff],tunerTuning=useMemo(()=>tunerStaff&&!tunerStaff.isPercussion?[...tunerStaff.tuning]:[],[tunerStaff]);
  useEffect(()=>{onViewChange({target,selectedString,selectedNoteIndex,zoom,trackView,instrumentVisible,...(scoreDisplay?{scoreDisplay}:{})});},[target.track,target.staff,target.bar,target.voice,target.beat,selectedString,selectedNoteIndex,zoom,trackView,instrumentVisible,scoreDisplay,onViewChange]);
  const trackIds=useMemo(()=>state.score.tracks.map(trackIdentity),[state.score]);
  const trackNames=useMemo(()=>Object.fromEntries(state.score.tracks.map(track=>[trackIdentity(track),track.name||t('track_display.track_fallback',{index:track.index+1})])),[state.score,t]);
  const visibleTracks=useMemo(()=>resolveVisibleTracks(trackIds,target.track,trackView),[trackIds,target.track,trackView]);
  // A dock eye shows or hides one track in the score, as Displayed tracks does; the score always keeps one track.
  const shownTracks=useRef({visible:visibleTracks,ids:trackIds});shownTracks.current={visible:visibleTracks,ids:trackIds};
  const toggleShownTrack=useCallback((index:number)=>{
    const {visible,ids}=shownTracks.current,next=new Set(visible);
    if(next.has(index)){if(next.size<=1)return;next.delete(index);}else next.add(index);
    const list=[...next].sort((a,b)=>a-b);
    setTrackView(list.length===ids.length?{kind:'all'}:{kind:'custom',trackIds:list.map(track=>ids[track])});
  },[]);
  // projectEngraving ignores system gaps, so a gap-only edit keeps the projected score (and so the notation render and the audio load).
  const engravingKey=engravingRenderKey(state.settings.engraving);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const projection=useMemo(()=>projectEngraving(state.score,trackIds,state.settings.engraving),[state.score,trackIds,engravingKey]);
  const pageState=useMemo(()=>{
    try{return {page:effectivePageLayout(state.settings),error:null};}
    catch(error){return {page:effectivePageLayout({page:null,print:defaultPrintLayout()}),error:t('app.print_layout_error',{error:error instanceof Error?error.message:String(error)})};}
  },[state.settings.page,state.settings.print,t]),page=pageState.page;
  useEffect(()=>{if(player)void player.loadDocument(state.snapshot.project,state,target.track,state.documentEpoch,playbackResumeEpoch);},[player,state.snapshot.project,state.score,state.settings,state.embeddedBacking,target.track,state.documentEpoch,playbackResumeEpoch]);
  const location=describeSelection(state.score,target);
  const indexed=location.staff.isPercussion||!location.staff.tuning.length;
  const noteIndex=selectedNoteIndex!==null&&location.beat?.notes[selectedNoteIndex]?selectedNoteIndex:null;
  const string=Math.max(1,Math.min(selectedString,location.staff.tuning.length));
  // A click in the instrument view leaves its clicked fret as the entry fret, even when that note was just removed.
  const entryFret=useRef<{string:number;fret:number;score:model.Score}|null>(null);
  useEffect(()=>{
    const kept=entryFret.current;entryFret.current=null;
    setFret(kept&&kept.score===state.score&&kept.string===string?kept.fret:location.beat?.notes.find(n=>n.string===string)?.fret ?? 0);endPending();
  },[state.score,target.track,target.staff,target.bar,target.voice,target.beat,string]);
  const act=(job: Promise<unknown>)=>{void job.catch(()=>{});};
  const change=(job:Promise<unknown>)=>{const before=state.score;setClipboardError(null);clearEntryQueue();act(job.then(()=>{const score=controller.getState().score;setSelection(old=>repairSelection(score,followSelectedTrack(before,score,old)));editorSelection(null);}));};
  const edit=(command:EditCommand,after?:(score:model.Score)=>void)=>{
    setClipboardError(null);
    const oldCount=state.score.masterBars.length;
    const wasPlaying=player?.getState().playing??false;
    let recorded=false;
    const landed=controller.edit(command);ownEdits.current++;
    const done=landed.then(()=>{
      recorded=true;
      const score=controller.getState().score,map=command.type==='insertMeasures'||command.type==='removeMeasures'?planMeasureMap(oldCount,command):null;
      setSelection(old=>map?repairMeasureSelection(score,old,map):repairSelection(score,command.type==='moveTrack'?{...old,track:movedTrackIndex(old.track,command)}:command.type==='duplicateTrack'?{...old,track:command.track+1}:old));
      if(command.type==='pasteMusic')setNoteIndex(null);
      after?.(score);
      if(!('selection'in command)||command.type==='eraseSelection')editorSelection(null);
      // Hearing an entered note is a courtesy: only note-setting edits, and only while nothing is playing.
      if(auditionEditsNow.current&&player&&!wasPlaying&&!player.getState().playing){const heard=editAudition(score,command);if(heard){const current=controller.getState();player.audition({trackId:trackIdentity(score.tracks[heard.track])},heard.notes,heard.durationMs,{project:current.snapshot.project,built:current});}}
    });
    // The edit is finished only once its follow-up has moved the selection: that, not the controller going idle, is when the next queued key may run.
    const settle=()=>{unseenSettles.current++;if(!recorded)entryFailure.current={text:null};setSettled(count=>count+1);};
    done.then(settle,settle);
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
      const source=options?null:scoreFromMusicClip(clip),multi=clip.mode==='multiTrack',creates=multi&&clip.kind==='bars';let appended=state.score.tracks.length;
      // A multitrack bar clip with more tracks than remain from the cursor appends the rest as new tracks.
      edit({type:'pasteMusic',clip,options:options??{target:{...target},destinations:source!.tracks.map((track,index)=>{const created=creates&&!state.score.tracks[target.track+index];return {sourceTrack:index,track:created?appended++:target.track+index,staffMap:track.staves.map((_,staff)=>clip.kind==='phrase'?target.staff:staff)};}),count:1,placement:clip.kind==='phrase'?'currentBar':'beforeBar',filters:{diagrams:inputPrefs.pasteDiagrams,texts:true,timers:true,trackAutomations:true,masterAutomations:multi,sections:multi}}});
    }catch(reason){setClipboardError(reason instanceof Error?reason.message:String(reason));}
  };
  const showClipboard=()=>{setContextScope('all');setInspectorVisible(true);setInspectorTab('selection');setClipboardFocus(value=>value+1);};
  const documentAction=(job:Promise<unknown>)=>change(job);
  const [paletteOpen,setPaletteOpen]=useState(false),paletteReturn=useRef<HTMLElement|null>(null);
  const [protectionDialog,setProtectionDialog]=useState<'manage'|'unlock'|null>(null),protectionReturn=useRef<HTMLElement|null>(null);
  const openProtection=(kind:'manage'|'unlock')=>{protectionReturn.current=document.activeElement instanceof HTMLElement?document.activeElement:null;closeCommands(false);setProtectionDialog(kind);};
  const closeProtection=()=>{setProtectionDialog(null);const back=protectionReturn.current;protectionReturn.current=null;if(back?.isConnected)back.focus();if(document.activeElement!==back)scorePane.current?.focus();};
  const [asciiOpen,setAsciiOpen]=useState(false),asciiReturn=useRef<HTMLElement|null>(null),[midiOpen,setMidiOpen]=useState(false),[batchOpen,setBatchOpen]=useState(false);
  const [helpTopic,setHelpTopic]=useState<HelpTopicId|null>(null),helpReturn=useRef<HTMLElement|null>(null);
  /** Opens help on the topic for what had focus; help only reads, so open scores and edits are untouched. */
  const openHelp=(topic?:HelpTopicId)=>{const focused=document.activeElement instanceof HTMLElement?document.activeElement:null;helpReturn.current=focused;closeCommands(false);setHelpTopic(topic??topicFor(focused));};
  // F1 is heard on the window so it works with nothing focused; it never opens help over another dialog.
  const helpKey=useRef<(event:globalThis.KeyboardEvent)=>void>(()=>{});
  helpKey.current=event=>{
    if(event.key!=='F1'||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey)return;
    event.preventDefault();
    if(event.repeat||helpTopic!==null||exportOpen||harmonyOpen||scaleOpen||paletteOpen||asciiOpen||batchOpen||document.querySelector('[role="dialog"]'))return;
    openHelp();
  };
  useEffect(()=>{const listener=(event:globalThis.KeyboardEvent)=>helpKey.current(event);window.addEventListener('keydown',listener);return ()=>window.removeEventListener('keydown',listener);},[]);
  const closeHelp=()=>{setHelpTopic(null);const back=helpReturn.current;helpReturn.current=null;if(back?.isConnected)back.focus();if(document.activeElement!==back)scorePane.current?.focus();};
  const openAscii=()=>{asciiReturn.current=document.activeElement instanceof HTMLElement?document.activeElement:null;closeCommands(false);setAsciiOpen(true);};
  const openMidi=()=>{asciiReturn.current=document.activeElement instanceof HTMLElement?document.activeElement:null;closeCommands(false);setMidiOpen(true);};
  const openBatch=()=>{asciiReturn.current=document.activeElement instanceof HTMLElement?document.activeElement:null;closeCommands(false);setBatchOpen(true);};
  const closeBatch=()=>{setBatchOpen(false);closeAscii();};
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
    if(action.kind==='edit'){if(view==='sound')return;if(editLocked)setClipboardError(lockedMessage);else edit(action.command);}
    else if(action.kind==='select'){editorSelection(null);select(action.target);}
    else if(action.name==='undo'){if(state.snapshot.canUndo&&!editLocked)change(controller.undo());}
    else if(action.name==='redo'){if(state.snapshot.canRedo&&!editLocked)change(controller.redo());}
    else if(action.name==='play')shell.current?.querySelector<HTMLButtonElement>('[aria-keyshortcuts="Space"]')?.click();
    else if(action.name==='loop'||action.name==='slower'||action.name==='faster')shell.current?.querySelector<HTMLButtonElement>(`[data-action="${action.name}"]`)?.click();
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
  const exports=useExportCoordinator({score:state.score,settings:audioSettings,currentSpeed:practiceRatio,metronomeSound:player?player.getState().practice.settings.metronome.sound??'beep':'beep',bridge:documentBridge,native:exportBridge,embeddedBacking:state.embeddedBacking,revision:state.revision});
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
  const transportScore=state.score,transportTrack=`${target.track+1}. ${selectedTrack.name||`Track ${target.track+1}`}`;
  const transportColor=trackColorHex(selectedTrack.color);
  const transportTracks=useMemo(()=>transportScore.tracks.map((track,index)=>`${index+1}. ${track.name||t('track_display.track_fallback',{index:index+1})}`),[transportScore]);
  // The display's links reuse the command palette's selection path, so moving there is the same gesture as Go to measure.
  const displayActions=useRef({select:(_:BeatTarget)=>{},measure:(_:number)=>{}});
  displayActions.current={
    select:next=>runPalette({kind:'select',target:next}),
    measure:bar=>{runPalette({kind:'select',target:{...target,bar,beat:0}});setContextScope('measure');setInspectorVisible(true);setInspectorTab('selection');setMeasureRequest(tick=>tick+1);},
  };
  const displayTarget=target;
  const transportDisplay=useMemo<TransportDisplay>(()=>({track:transportTrack,color:transportColor,tracks:transportTracks,trackIndex:displayTarget.track,
    signatureAt:(bar:number)=>{const master=transportScore.masterBars[bar];return master?`${master.timeSignatureNumerator}/${master.timeSignatureDenominator}`:'';},
    onTrack:index=>displayActions.current.select({...displayTarget,track:index,staff:0,voice:0,beat:0}),
    onGoTo:bar=>displayActions.current.select({...displayTarget,bar,beat:0}),
    onMeasure:bar=>displayActions.current.measure(bar),
    completionAt:bar=>barCompletion(transportScore,displayTarget.track,displayTarget.staff,bar),
  }),[transportScore,transportTrack,transportColor,transportTracks,displayTarget]);
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
  const waveformEnabled=dockVisible&&!dockCollapsed&&!dockPanelVisible&&dockMode==='backing';
  const backingTimeline=player?.backingTimeline()??null;
  const referenceVisible=waveformEnabled,metadataVisible=referenceVisible||waveformEnabled;
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
      if(owner.documentId!==document.documentId||receipt.owner.documentId!==owner.documentId||receipt.owner.activationId!==owner.activationId||receipt.document.documentId!==document.documentId||receipt.document.revision!==document.revision||receipt.source.kind!=='asset'||receipt.source.assetId!==assetId||!Number.isFinite(receipt.durationMs)||receipt.durationMs<=0)throw new Error(t('backing.timing_source_changed'));
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
    if(!state.settings.backing||!waveformCurrent(document,state.settings.backing)||backing.assetId!==sourceAssetId)throw new Error(t('backing.reference_source_changed'));
    await controller.editAtRevision({type:'setBacking',backing},document);
  }});
  const referenceTiming=useMemo(()=>{
    if(!referenceReady||!state.settings.backing)return null;
    try{return referenceSyncTiming(referenceEdit.preview??state.settings.backing,backingTimeline!.occurrences,sourceDurationMs!);}catch{return null;}
  },[referenceReady,state.settings.backing,referenceEdit.preview,backingTimeline?.occurrences,sourceDurationMs]);
  const referenceAction=async(action:'score'|'reference'|'replace'|'add'|'write')=>{
    const captured=controller.getState(),document={documentId:captured.documentId,revision:captured.revision},backing=captured.settings.backing;
    if(controlsBusy||captured.busy||!referenceReady||!backing||captured.documentId!==state.documentId||captured.revision!==state.revision||backing.assetId!==sourceAssetId||!waveformCurrent(document,backing))throw new Error(t('backing.timing_wait'));
    const release=beginEditorOperation();
    try{
      const settings=structuredClone(backing),json=model.JsonConverter.scoreToJson(captured.score);let command:EditCommand;
      if(action==='write'){
        const score=scoreFromJson(json,new Settings());restoreNoteLinks(score,captureNoteLinks(captured.score));
        const locations=backingLocationsForScore(score),timing=referenceSyncTiming(settings,locations,sourceDurationMs!);
        if(!timing)throw new Error(t('backing.follow_audio_required'));
        command={type:'replaceTempoAutomations',points:scoreTemposFromSync(score,timing,locations)};
      }else if(action==='score')command={type:'setBacking',backing:disableReferenceSync(settings)};
      else{
        const authored=buildPlaybackPlanFromJson(json,captured.score.tracks.map(trackIdentity),backingTimeline!.generation);
        command={type:'setBacking',backing:action==='reference'?initializeReferenceSync(settings,authored,sourceDurationMs!):syncPointsFromScore(authored,settings,action,sourceDurationMs!)};
      }
      if(!waveformCurrent(document,backing))throw new Error(t('backing.reference_source_changed'));
      await controller.editAtRevision(command,document);
    }finally{release();}
  };
  const reference:ReferenceSyncControls={ready:referenceReady,timing:referenceTiming,edit:referenceEdit,onModeChange:referenceAction,onFromScore:referenceAction,onWriteScore:()=>referenceAction('write')};
  const sourceMetadataStatus=sourceAssetId&&sourceDurationMs===null?<div className="backing-waveform-state">{currentMetadata?.error?<><p role="alert">{currentMetadata.error}</p><button onClick={()=>setSourceRetry(value=>value+1)}>{t('action.retry')}</button></>:<p role="status">{t('dock.loading_timing')}</p>}</div>:null;
  const [symbolRequest,setSymbolRequest]=useState(0);
  // The cursor as last rendered: an entry edit that lands moves it on only when the user has not moved it meanwhile.
  const cursorNow=useRef(selection);cursorNow.current=selection;
  // How many times the user has chosen a place; a cursor that left a beat and came back is not one that stayed.
  const userMoves=useRef(0);
  const sameBeat=(a:BeatTarget,b:BeatTarget)=>a.track===b.track&&a.staff===b.staff&&a.bar===b.bar&&a.voice===b.voice&&a.beat===b.beat;
  const moveTo=(next:BeatTarget,s=string,index?:number)=>{
    if (!validSelectionIndices(next) || !Number.isInteger(s)) return;
    entryFret.current=null;setPendingAccidental(null);const fixed=repairSelection(state.score,next);setSelection(fixed);
    setNoteIndex(index!==undefined&&Number.isInteger(index)&&index>=0?index:null);
    const beat=describeSelection(state.score,fixed).beat;
    const count=state.score.tracks[fixed.track].staves[fixed.staff].tuning.length;
    const chosen=Math.max(1,Math.min(s,count));setString(chosen);
    setFret(beat?.notes.find(n=>n.string===chosen)?.fret ?? 0);endPending();
  };
  /** A selection the user made: it also drops any keys still waiting, which were typed for the old cursor. Entry itself moves the cursor with `moveTo`. */
  const select=(next:BeatTarget,s=string,index?:number)=>{userMoves.current++;clearEntryQueue();moveTo(next,s,index);};
  /** A mark clicked in the instrument view selects its beat, string and note like a click on the score does. */
  const selectFromInstrument=(next:BeatTarget,s:number|undefined,index:number|undefined,by:'pointer'|'keyboard')=>{
    select(next,s,index);
    // Like a click on the score it replaces any earlier range with that one beat, so a cut or copy takes what was picked.
    editorSelection(singleBeatSelection(state.score,repairSelection(state.score,next)));
    // A pointer pick hands the keys back to the score, as the track overview does; a key press stays on the instrument.
    if(by==='pointer')scorePane.current?.focus({preventScroll:true});
  };
  /** Shows why a key did nothing; for a queued key it also records that the rest of the queue was typed for a result that did not happen. */
  const refuse=(text:string,at:string)=>{setInputNotice({text,at});if(draining.current)entryFailure.current={text};};
  /** Records a planned entry as one edit, then moves the cursor where the plan says; a refusal keeps the cursor on the beat and says why. */
  const runEntryPlan=(point:BeatTarget,plan:EntryPlan|EntryRefusal,pitch?:number)=>{
    const placed=repairSelection(state.score,point),moves=userMoves.current;
    moveTo(point);
    if('refused' in plan){refuse(t(`score_entry.${plan.refused}` as MessageKey,{name:plan.name}),JSON.stringify(point));return;}
    setInputNotice(plan.notice?{text:plan.notice,at:JSON.stringify(plan.next)}:null);
    void edit(plan.command,score=>{if(sameBeat(cursorNow.current,placed)&&userMoves.current===moves){setSelection(repairSelection(score,plan.next));setNoteIndex(null);}if(plan.entry)entryDuration.current=plan.entry;if(pitch!==undefined&&!plan.removes)entryNear.current=pitch;})
      .then(landed=>{if(!landed){const text=t('score_entry.refused',{name:plan.name});setInputNotice({text,at:JSON.stringify(point)});if(entryFailure.current)entryFailure.current.text=text;}});
  };
  const entryBlocked=(point:BeatTarget)=>{
    if(editLocked){refuse(lockedMessage,JSON.stringify(point));return true;}
    if(editBusy){refuse(t('editor.entry_busy'),JSON.stringify(point));return true;}
    return false;
  };
  const writeEntry=(point:BeatTarget,entered:ReturnType<typeof stepEntryPitch>,chord:boolean)=>{
    if(entryBlocked(point))return;
    setPendingAccidental(null);
    if(!entered){moveTo(point);refuse(t('editor.entry_out_of_range'),JSON.stringify(point));return;}
    const current=controller.getState();
    runEntryPlan(point,planScoreEntry({project:current.snapshot.project,score:current.score,target:point,entered,preferences:inputPrefs,entry:entryDuration.current,chord}),entered.pitch);
  };
  const scoreNoteEntry=noteEntryOn&&view==='score'?{
    onHit:(point:BeatTarget,step:number,{chord}:{chord:boolean})=>writeEntry(point,stepEntryPitch(controller.getState().score,point,step,pendingAccidental??'key'),chord),
    describe:(point:BeatTarget,step:number)=>{
      const entered=stepEntryPitch(state.score,point,step,pendingAccidental??'key');if(!entered)return null;
      const {staff,bar,beat}=describeSelection(state.score,point),result=enterPitch({staff,bar,beat:beat??null,target:point,keySignature:bar.keySignature as number},entered);
      return result.action?result.removes?t('score_entry.remove',{name:entered.name}):entered.name:null;
    },
  }:null;
  useEffect(()=>{if(!noteEntryOn||view!=='score')setPendingAccidental(null);},[noteEntryOn,view]);
  useEffect(()=>{setPendingAccidental(null);},[state.documentEpoch]);
  /** The note the cursor is on: the chosen note on an indexed staff, otherwise the one on the cursor string. */
  const noteAtCursor=(beat:model.Beat)=>indexed?selectedNote(beat,null,noteIndex):beat.notes.find(item=>item.string===string);
  /**
   * Ctrl+7/8/9 (flat, natural, sharp; Alt for the doubles; Ctrl+Alt+8 changes the accidental). With note entry on and nothing
   * at the cursor's string or line they set the accidental of the next note; otherwise they re-spell the selected note
   * (spelling only, one edit, nothing recorded for the spelling it already has).
   */
  const accidentalKeys=(key:Extract<ScoreEntryKey,{kind:'accidental'|'respell'}>)=>{
    const beat=location.beat,at=JSON.stringify(target);
    const slot=beat?noteAtCursor(beat):null;
    if(noteEntryOn&&key.kind==='accidental'&&!slot){setInputNotice(null);setPendingAccidental(old=>old===key.value?null:key.value);return;}
    if(entryBlocked(target))return;
    if(!beat){refuse(t('score_entry.no_beat'),at);return;}
    if(location.staff.isPercussion){refuse(t('score_entry.percussion_respell'),at);return;}
    const note=selectedNote(beat,indexed?null:string,noteIndex);
    if(!note){refuse(t('score_entry.select_note_respell'),at);return;}
    const result=respellNote(location.staff,location.bar,beat,note,key.kind==='respell'?'cycle':key.value);
    if(!result){refuse(t('editor.entry_no_spelling',{name:String(note.realValue)}),at);return;}
    if('same' in result){setInputNotice(null);return;}
    if('refused' in result){refuse(t('editor.entry_no_spelling',{name:result.name}),at);return;}
    setInputNotice(null);void edit({type:'setNoteSpelling',target,noteIndex:note.index,accidentalMode:result.mode});
  };
  /** What one note-entry key does at the cursor. */
  const entryKey=(key:ScoreEntryKey,shift:boolean)=>{
    const beat=location.beat;
    if(key.kind==='letter'){writeEntry(target,letterPitch(key.letter,entryNear.current,location.bar.keySignature as number,pendingAccidental??'key'),shift);return;}
    if(entryBlocked(target))return;
    if(!beat){refuse(t('score_entry.no_beat'),JSON.stringify(target));return;}
    if(key.kind==='rest'){
      if(!beat.isRest){const placed=target,moves=userMoves.current;void edit({type:'setRest',target},score=>{const voice=score.tracks[target.track].staves[target.staff].bars[target.bar].voices[target.voice];if(inputPrefs.advance&&sameBeat(cursorNow.current,placed)&&userMoves.current===moves&&target.beat<voice.beats.length-1)setSelection(repairSelection(score,{...target,beat:target.beat+1}));});}
      return;
    }
    if(key.kind==='step'||key.kind==='semitone'||key.kind==='octave'){
      const note=selectedNote(beat,indexed?null:string,noteIndex);
      if(!note){refuse(t('score_entry.select_note'),JSON.stringify(target));return;}
      const entered=movedPitch(location.staff,location.bar,beat,note,key);
      if(!entered){refuse(t('editor.entry_out_of_range'),JSON.stringify(target));return;}
      const current=controller.getState();runEntryPlan(target,planNoteMove(current.snapshot.project,current.score,target,note,entered),entered.pitch);return;
    }
    const change=durationKeyEdit(key,target,beat);
    if(change)void edit(change.command).then(accepted=>{if(accepted)entryDuration.current=change.entry;});
  };
  /** Digits then Enter: writes the typed fret on the cursor string, with the automatic duration when that is on. */
  const enterFret=()=>{
    if(!location.beat||indexed)return;
    if(editBusy){entryBlocked(target);return;}
    const beat=location.beat,lead=autoDurationEdit(inputPrefs,target,beat,entryDuration.current),note:EditCommand={type:'setNote',target,string,fret},project=state.snapshot.project;
    // The pair is checked before either edit, so a refused note never leaves a changed rhythm behind; an unfit duration falls back to a plain write.
    const pair=lead!==null&&applyInOrder(project,[lead,note]),why=pair?null:lead&&applyInOrder(project,[note])?AUTO_DURATION_UNFIT:autoDurationSkip(inputPrefs,beat,entryDuration.current);
    setInputNotice(why?{text:why,at:JSON.stringify(target)}:null);
    // The rhythm and the note are one edit, so one undo takes back the whole entry.
    if(pair)void edit({type:'sequence',commands:[lead as SequenceStep,note as SequenceStep]});
    else void edit(note).then(accepted=>{if(accepted)entryDuration.current=entryAfterWrite(beat,entryDuration.current);});
  };
  /** One keyboard entry key, live or from the queue: both run this, so a queued key reads the preferences and the pending accidental when its turn comes. */
  const performItem=(item:EntryItem,at:number)=>{
    if(item.kind==='keypad'){
      if(!location.beat||entryBlocked(target))return;
      const change=numpadDurationEdit(item.keypad,target,location.beat);
      if(change)void edit(change.command).then(accepted=>{if(accepted)entryDuration.current=change.entry;});
    }else if(item.kind==='entry'){
      if(item.key.kind==='accidental'||item.key.kind==='respell')accidentalKeys(item.key);else entryKey(item.key,item.shift);
    }else if(item.kind==='digit'){
      const fresh=at-digits.current.time>=1000||!digits.current.text,text=((fresh?'':digits.current.text)+item.digit).slice(-2);
      if(fresh||fretBase.current===null)fretBase.current=fret;
      digits.current.text=text;digits.current.time=at;setPendingFret(text);setFret(Number(text));
      if(pendingTimer.current!==null)clearTimeout(pendingTimer.current);
      // Once the window closes the digits stand as the field's value, and Backspace deletes the note again, so the hint and the way back both end.
      pendingTimer.current=setTimeout(()=>{pendingTimer.current=null;fretBase.current=null;setPendingFret(null);},1000);
    }else {endPending();enterFret();}
  };
  /** The key as an entry key, or null when it is anything else (navigation, the N toggle, other shortcuts). */
  const entryItem=(event:KeyboardEvent):EntryItem|null=>{
    const keypad=numpadKey(event,inputPrefs);if(keypad)return {kind:'keypad',keypad};
    if(view==='score'){
      const chord=scoreEntryKey(event);if(chord&&(chord.kind==='accidental'||chord.kind==='respell'))return {kind:'entry',key:chord,shift:false};
      if((event.key==='n'||event.key==='N')&&!event.ctrlKey&&!event.metaKey&&!event.altKey)return null;
      if(noteEntryOn){const key=scoreEntryKey(event,inputPrefs.swapPlusMinus);if(key)return {kind:'entry',key,shift:event.shiftKey};}
    }
    if(/^\d$/.test(event.key)&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!indexed)return {kind:'digit',digit:event.key};
    if(event.key==='Enter'&&!indexed)return {kind:'enter'};
    return null;
  };
  /** A key waits only behind this app's own edit (or behind keys already waiting). A lock, a workspace transition or any other busy work still refuses it. */
  const entryQueueing=()=>!workspaceBusy&&!editLocked&&(ownEdits.current>0||entryQueue.current.length>0&&!controlsBusy);
  const enqueueEntry=(item:EntryItem)=>{
    const queue=entryQueue.current;
    if(!queue.length)entryFailure.current=null;
    // A refused key must not be followed by keys that assume it landed: once one is refused, the rest are too until the queue is empty and its last key has finished (the drain lifts it).
    if(queue.length>=ENTRY_QUEUE_MAX){refusing.current=true;setInputNotice({text:t('editor.entry_busy'),at:JSON.stringify(target)});return;}
    queue.push({item,at:Date.now(),documentId:state.documentId});
  };
  const discardEntryQueue=(reason:string|null,why:'discarded'|'stale'|'dropped',extra=0)=>{
    const count=entryQueue.current.length+extra;clearEntryQueue();
    const message=t(`editor.entry_queue_${why}_${count===1?'one':'other'}` as MessageKey,{count});
    setInputNotice({text:reason?`${reason} ${message}`:message,at:JSON.stringify(target)});
  };
  /**
   * Runs the first waiting key once the previous one is finished: none of our edits in flight (`ownEdits` drops only after its follow-up moved the
   * selection, so the cursor is where the key before left it), nothing else busy, and this render shows that cursor. A key that makes no edit bumps
   * `settled`, so the next one runs on the following render. A refused or unlanded key, a stale one, or one for another document discards the rest.
   */
  const drainEntry=()=>{
    if(ownEdits.current>0||controlsBusy)return;
    const queue=entryQueue.current,failure=entryFailure.current;entryFailure.current=null;
    if(!queue.length){refusing.current=false;return;}
    if(editLocked||workspaceBusy||queue[0].documentId!==state.documentId){discardEntryQueue(null,'dropped');return;}
    if(failure){discardEntryQueue(failure.text,'discarded');return;}
    if(Date.now()-queue[0].at>ENTRY_QUEUE_STALE_MS){discardEntryQueue(null,'stale');return;}
    const next=queue.shift()!,before=ownEdits.current;
    draining.current=true;
    try{performItem(next.item,next.at);}
    catch(error){console.error('A queued entry key failed.',error);discardEntryQueue(null,'discarded',1);return;}
    finally{draining.current=false;}
    if(ownEdits.current===before)setSettled(count=>count+1);
  };
  const drainNow=useRef(drainEntry);drainNow.current=drainEntry;
  useEffect(()=>{clearEntryQueue();},[noteEntryOn,view]);
  useEffect(()=>{if(entryQueue.current.length)discardEntryQueue(null,'dropped');},[editLocked,state.documentEpoch,state.documentId]);
  useEffect(()=>{ownEdits.current-=unseenSettles.current;unseenSettles.current=0;drainNow.current();},[settled,controlsBusy,workspaceBusy,editLocked,state.documentEpoch,state.documentId]);
  /** Backspace, Shift+Delete, Ctrl+Insert and Ctrl+Shift+Delete: edits that already exist, on the cursor or the selection. They never wait in the entry queue; behind waiting keys or an edit in flight they are refused. */
  const gp8Edit=(kind:'removeNote'|'deleteBeats'|'insertBeat'|'eraseNotes')=>{
    const at=JSON.stringify(target);
    if(editLocked){refuse(lockedMessage,at);return;}
    if(refusing.current||entryQueue.current.length||ownEdits.current>0||controlsBusy){
      // Like a refused entry key: keys typed after this one assumed it landed, so they are refused too until the queue has emptied.
      if(entryQueue.current.length||ownEdits.current>0)refusing.current=true;
      setInputNotice({text:t('editor.entry_busy'),at});return;}
    setInputNotice(null);
    if(kind==='insertBeat'){const beat=location.beat;void edit({type:'insertBeat',target,duration:beat?.duration??4,dots:beat?.dots??0});return;}
    if(kind==='removeNote'){
      const beat=location.beat,note=beat?noteAtCursor(beat):null;
      // Fret digits typed but not yet entered: Backspace takes them back, as it would in a text field, and leaves the note alone.
      if(!indexed&&digits.current.text&&Date.now()-digits.current.time<1000){setFret(fretBase.current??note?.fret??0);endPending();return;}
      if(!note){setInputNotice({text:t('editor.gp8_no_note'),at});return;}
      void edit(indexed?{type:'removeNoteByIndex',target,noteIndex:note.index}:{type:'removeNote',target,string:note.string});return;
    }
    if(kind==='deleteBeats'){
      let beats:model.Beat[];
      try{beats=musicSelection&&!(musicSelection.kind==='notes'&&!musicSelection.notes.length)?resolveSelectionBeats(state.score,musicSelection):[];}catch{setInputNotice({text:t('editor.gp8_bad_selection'),at});return;}
      // Any selection that resolves to no beats (or no selection at all) falls back to the cursor beat; one that throws when resolved was refused above.
      if(!beats.length&&location.beat)beats=[location.beat];
      // `deleteBeat` is not a step a `sequence` may hold, so several beats cannot be one edit: refuse rather than split the gesture.
      if(beats.length>1){setInputNotice({text:t('editor.gp8_delete_many',{count:beats.length}),at});return;}
      if(!beats.length){setInputNotice({text:t('editor.gp8_no_beat'),at});return;}
      void edit({type:'deleteBeat',target:beatAddress(beats[0])});return;
    }
    let notes:model.Note[];
    try{notes=musicSelection?resolveSelectionNotes(state.score,musicSelection):[];}catch{notes=[];}
    if(!musicSelection||!notes.length){setInputNotice({text:t(musicSelection?'editor.gp8_no_notes':'editor.gp8_no_selection'),at});return;}
    void edit({type:'eraseSelection',selection:musicSelection});
  };
  function keys(event:KeyboardEvent) {
    if (textEntry(event.target)||(event.target as HTMLElement).tagName==='BUTTON') return;
    // The Menu key and Shift+F10 open the score-symbol menu at the edit target, as a right-click does on the score.
    if ((event.key==='ContextMenu'||(event.key==='F10'&&event.shiftKey))&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&view==='score') {event.preventDefault();setSymbolRequest(count=>count+1);return;}
    const item=entryItem(event);
    if(item){
      event.preventDefault();
      // Held letters and chords never repeat, and a key that has to wait is queued once, never from key repeat.
      if(event.repeat&&(item.kind==='entry'||entryQueueing()))return;
      if(refusing.current||entryQueue.current.length&&!entryQueueing()){
        // Keys are waiting and this one cannot join them: refuse it, and every later one until the queue is empty, so the music has no hole.
        refusing.current=true;if(!entryBlocked(target))setInputNotice({text:t('editor.entry_busy'),at:JSON.stringify(target)});return;
      }
      if(entryQueueing())enqueueEntry(item);else performItem(item,Date.now());
      return;
    }
    if(view==='score'&&(event.key==='n'||event.key==='N')&&!event.ctrlKey&&!event.metaKey&&!event.altKey){event.preventDefault();if(!event.repeat)setNoteEntryOn(on=>!on);return;}
    const gp8=view==='score'?gp8Key(event):null;
    if(gp8?.kind==='edit'){event.preventDefault();if(!event.repeat)gp8Edit(gp8.edit);return;}
    let next={...target};
    if(gp8?.kind==='cursor') {
      next=gp8CursorTarget(gp8.edge,target,location.voice.beats.length,state.score.masterBars.length);
      if(gp8.extend){
        const anchor=rangeAnchor.current??target;
        try{setMusicSelection({kind:'range',range:rangeFromBeats(state.score,anchor,next,[{track:target.track,staff:target.staff,voice:target.voice}])});rangeAnchor.current=anchor;}catch{ /* An empty voice has no attack endpoint. */ }
        select(next);event.preventDefault();return;
      }
      editorSelection(null);select(next);event.preventDefault();return;
    }
    if(gp8?.kind==='voice'){
      event.preventDefault();if(event.repeat)return;
      const voiceIndex=gp8.voiceIndex,bar=state.score.tracks[target.track]?.staves[target.staff]?.bars[target.bar];
      if(!bar)return;
      if(voiceIndex<bar.voices.length){
        const beats=bar.voices[voiceIndex].beats,nextBeat=Math.min(target.beat,Math.max(0,beats.length-1));
        editorSelection(null);select({...target,voice:voiceIndex,beat:nextBeat});
      }else if(!editLocked&&bar.voices.length<4&&voiceIndex===bar.voices.length){
        editorSelection(null);
        void edit({type:'addVoice',track:target.track,staff:target.staff},newScore=>{
          setSelection(repairSelection(newScore,{...target,voice:voiceIndex,beat:0}));
          setNoteIndex(null);
        });
      }
      return;
    }
    if(gp8?.kind==='track'){
      event.preventDefault();if(event.repeat)return;
      const nextTrackIndex=Math.max(0,Math.min(state.score.tracks.length-1,target.track+gp8.direction));
      if(nextTrackIndex!==target.track){
        const newTrack=state.score.tracks[nextTrackIndex],newStaff=Math.min(target.staff,newTrack.staves.length-1);
        const newBar=newTrack.staves[newStaff].bars[target.bar],newVoice=Math.min(target.voice,newBar.voices.length-1);
        const newBeat=Math.min(target.beat,Math.max(0,newBar.voices[newVoice].beats.length-1));
        editorSelection(null);select({track:nextTrackIndex,staff:newStaff,bar:target.bar,voice:newVoice,beat:newBeat},newTrack.staves[newStaff].tuning.length);
      }
      return;
    }
    if(gp8?.kind==='bar'){
      event.preventDefault();
      const nextBarIndex=Math.max(0,Math.min(state.score.masterBars.length-1,target.bar+gp8.direction));
      const bar=state.score.tracks[target.track]?.staves[target.staff]?.bars[nextBarIndex];
      const voice=bar?Math.min(target.voice,bar.voices.length-1):0;
      const barNext:BeatTarget={...target,bar:nextBarIndex,voice,beat:0};
      if(gp8.extend){
        const anchor=rangeAnchor.current??target;
        try{setMusicSelection({kind:'range',range:rangeFromBeats(state.score,anchor,barNext,[{track:target.track,staff:target.staff,voice:target.voice}])});rangeAnchor.current=anchor;}catch{ /* An empty voice has no attack endpoint. */ }
        select(barNext);return;
      }
      editorSelection(null);select(barNext);return;
    }
    if(gp8?.kind==='playBar'){
      event.preventDefault();event.stopPropagation();if(event.repeat)return;
      if(player){try{player.seekToMeasure(target.bar);if(!player.getState().playing)player.play();}catch{}}
      return;
    }
    if(gp8?.kind==='goToBar'){
      event.preventDefault();event.stopPropagation();if(event.repeat)return;
      const btn=(shell.current??document).querySelector<HTMLButtonElement>('[data-action="go-to-bar"], .transport-lcd-bar button');
      btn?.click();
      return;
    }
    if(gp8?.kind==='technique'){
      event.preventDefault();if(event.repeat)return;
      const at=JSON.stringify(target);
      if(editLocked){refuse(lockedMessage,at);return;}
      if(refusing.current||entryQueue.current.length||ownEdits.current>0||controlsBusy){
        if(entryQueue.current.length||ownEdits.current>0)refusing.current=true;
        setInputNotice({text:t('editor.entry_busy'),at});return;
      }
      const command=planTechniqueToggle(state.score,target,indexed?null:string,noteIndex,gp8.technique);
      if(command){setInputNotice(null);void edit(command);}
      return;
    }
    if(event.key==='ArrowRight') {
      if(next.beat<location.voice.beats.length-1) next.beat++;
      else if(next.bar<state.score.masterBars.length-1) {next.bar++;next.beat=0;}
    } else if(event.key==='ArrowLeft') {
      if(next.beat>0) next.beat--;
      else if(next.bar>0) {next.bar--;next.beat=state.score.tracks[next.track].staves[next.staff].bars[next.bar].voices[next.voice].beats.length-1;}
    } else if(event.key==='ArrowDown'||event.key==='ArrowUp') {
      setPendingAccidental(null);clearEntryQueue();
      if(indexed)setNoteIndex(Math.max(0,Math.min((location.beat?.notes.length??1)-1,(noteIndex??0)+(event.key==='ArrowUp'?1:-1))));
      else select(next,string+(event.key==='ArrowUp'?1:-1));event.preventDefault();return;
    }
    else return;
    if(event.shiftKey&&(event.key==='ArrowLeft'||event.key==='ArrowRight')){
      const anchor=rangeAnchor.current??target;
      try{setMusicSelection({kind:'range',range:rangeFromBeats(state.score,anchor,next,[{track:target.track,staff:target.staff,voice:target.voice}])});rangeAnchor.current=anchor;}catch{ /* An empty voice has no attack endpoint. */ }
    }else editorSelection(null);
    select(next);event.preventDefault();
  }
  function selectionKeys(event:KeyboardEvent){
    if((event.ctrlKey||event.metaKey)&&event.shiftKey&&!event.altKey&&event.key.toLowerCase()==='p'&&!exportOpen&&!harmonyOpen&&!scaleOpen&&!paletteOpen&&!asciiOpen&&!midiOpen&&!batchOpen&&helpTopic===null&&!(event.target instanceof Element&&event.target.closest('[role="dialog"]'))){event.preventDefault();if(!event.repeat)openPalette();return;}
    if(textEntry(event.target)||exportOpen||harmonyOpen||scaleOpen||paletteOpen||asciiOpen||midiOpen||batchOpen||helpTopic!==null||(event.target instanceof Element&&event.target.closest('[role="dialog"]')))return;
    const key=event.key.toLowerCase();
    if((event.ctrlKey||event.metaKey)&&!event.altKey&&['n','o','s','z','y'].includes(key)){
      event.preventDefault();if(key==='z'||key==='y')clearEntryQueue();
      if(controlsBusy||event.repeat)return;
      if(key==='n')documentAction(onNew());
      else if(key==='o')documentAction(onOpen());
      else if(key==='s')act(controller.save(event.shiftKey));
      else if(key==='y'||key==='z'&&event.shiftKey){if(state.snapshot.canRedo&&!editLocked)change(controller.redo());}
      else if(state.snapshot.canUndo&&!editLocked)change(controller.undo());
      return;
    }
    // The Sound view covers the score, which stays laid out underneath: keys that edit or select in it wait for the Score view.
    // Document commands (new, open, save, undo, redo) and Space for play stay.
    if(view==='sound'&&(((event.ctrlKey||event.metaKey)&&['c','x','v','a','t'].includes(key))||event.key==='Escape')){event.preventDefault();return;}
    if((event.ctrlKey||event.metaKey)&&!event.altKey&&key==='t'){
      event.preventDefault();if(controlsBusy||event.repeat||!musicSelection)return;
      if(editLocked){setClipboardError(t('project.finalized'));return;}
      edit(event.shiftKey?{type:'setSelectionTies',selection:musicSelection,tied:false}:{type:'tieSelectionToEarlierPitch',selection:musicSelection});return;
    }
    if(key===' '&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.repeat&&!(event.target instanceof Element&&event.target.closest('button,summary,a,[role="button"]'))){
      event.preventDefault();event.currentTarget.querySelector<HTMLButtonElement>('[aria-keyshortcuts="Space"]')?.click();return;
    }
    if(!event.defaultPrevented&&(event.ctrlKey||event.metaKey)&&!event.altKey&&!event.shiftKey&&key===' '&&!event.repeat&&!(event.target instanceof Element&&event.target.closest('button,summary,a,[role="button"]'))){
      event.preventDefault();
      if(player){try{player.seekToMeasure(target.bar);if(!player.getState().playing)player.play();}catch{}}
      return;
    }
    if(!event.defaultPrevented&&(event.ctrlKey||event.metaKey)&&!event.altKey&&!event.shiftKey&&key==='g'&&!event.repeat){
      event.preventDefault();
      const btn=(shell.current??document).querySelector<HTMLButtonElement>('[data-action="go-to-bar"], .transport-lcd-bar button');
      btn?.click();
      return;
    }
    // Transport keys: Shift+L loops (the passage when one is selected and the loop is off), [ and ] step the speed. Brackets match the physical key when it types a bracket or a letter (German and Estonian put u-umlaut, and Estonian o-tilde, there), never a symbol such as the + that German types in the ] position, which note entry takes.
    if(!event.defaultPrevented&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.repeat){
      const transport=(action:string)=>event.currentTarget.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
      if(event.shiftKey&&key==='l'){
        event.preventDefault();
        const loopBtn=transport('loop'),loopActive=loopBtn?.getAttribute('aria-pressed')==='true',passageBtn=transport('loop-selection');
        (!loopActive&&passageBtn&&passageBtn.getAttribute('aria-disabled')!=='true'?passageBtn:loopBtn)?.click();return;
      }
      if(!event.shiftKey&&(event.code==='BracketLeft'||event.code==='BracketRight')&&/^(\[|\]|\p{L})$/u.test(event.key)){
        event.preventDefault();transport(event.code==='BracketLeft'?'slower':'faster')?.click();return;
      }
    }
    if((event.ctrlKey||event.metaKey)&&['c','x','v'].includes(key)){
      event.preventDefault();if(controlsBusy)return;
      if(editLocked&&(key==='x'||key==='v'))return;
      if(key==='v'){if(event.shiftKey)showClipboard();else pasteMusic();}
      else copyMusic(event.shiftKey?'multiTrack':'singleTrack',key==='x');
    }
    else if((event.ctrlKey||event.metaKey)&&key==='a'){editorSelection(selectionForTrack(state.score,target.track));event.preventDefault();}
    else if(event.key==='Escape'){
      // The Practice popover's body is a portal, so its keys reach here rather than the popover's own handler.
      const menu=practiceMenu.current;
      if(menu?.open&&event.target instanceof Node&&menu.querySelector('.gp-practice-body')?.contains(event.target)){menu.open=false;menu.querySelector('summary')?.focus();event.preventDefault();return;}
      if(pendingFret!==null){
        const beat=location.beat,note=beat?noteAtCursor(beat):null;
        setFret(fretBase.current??note?.fret??0);endPending();event.preventDefault();return;
      }
      editorSelection(null);setPendingAccidental(null);clearEntryQueue();event.preventDefault();
    }
  }
  return <div ref={shell} className="app-shell" aria-busy={controlsBusy} data-narrow={narrow} onKeyDown={selectionKeys}>
    <header ref={commandBar} className="toolbar gp-menubar" onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeCommands(true);}}} onClickCapture={event=>{if(!(event.target instanceof Element))return;if(event.target instanceof HTMLElement)onFileCommandCapture?.(event.target);const disclosure=event.target.closest('summary')?.parentElement;if(disclosure instanceof HTMLDetailsElement)commandBar.current?.querySelectorAll<HTMLDetailsElement>('details[open]').forEach(other=>{if(other!==disclosure)other.open=false;});else if(event.target.closest('button'))closeCommands(true);}}><nav className="gp-menus" aria-label={t('menu.file_and_history')}><span className="gp-brand"><MarkGlyph/><h1 className="tp-sr">TabPlayer</h1></span>
      <details className="command-menu" onToggle={event=>commandToggle(event.currentTarget)}><summary>{t('menu.file')}</summary><section aria-label={t('menu.file_commands')}>
      <button disabled={controlsBusy} onClick={()=>documentAction(onNew())}>{t('action.new')}</button>
      <button disabled={controlsBusy} onClick={()=>documentAction(onOpen())}>{t('action.open')}</button>
      {onImportConverted&&<button disabled={controlsBusy} onClick={openAscii}>{t('action.import_ascii')}</button>}
      {onImportConverted&&<button disabled={controlsBusy} onClick={openMidi}>{t('action.import_midi')}</button>}
      <button disabled={controlsBusy} onClick={openBatch}>{t('action.batch_convert')}</button>
      <button disabled={controlsBusy} onClick={()=>act(controller.save())}>{t('action.save')}</button>
      <button disabled={controlsBusy} onClick={()=>act(controller.save(true))}>{t('action.save_as')}</button>
      <button disabled={controlsBusy} onClick={()=>documentAction(onClose())}>{t('action.close_score')}</button>
      <button disabled={controlsBusy} onClick={()=>documentAction(onCloseAll())}>{t('action.close_all_scores')}</button>
      {finalized?<button disabled={controlsBusy||passwordLocked} onClick={()=>act(controller.setLock(null))}>{t('action.unfinalize_document')}</button>:<button disabled={controlsBusy||passwordLocked} onClick={()=>act(controller.setLock({kind:'finalized'}))}>{t('action.finalize_document')}</button>}
      <button {...busyGuard({busy:controlsBusy,onClick:()=>openProtection('manage')})}>{t('menu.password_protection')}</button>
      <button disabled={controlsBusy||exports.busy} onClick={()=>openModal('export')}>{t('action.export_score')}</button><button disabled={controlsBusy||exports.busy} onClick={directExport}>{t('action.export_gp')}</button>
      {libraryMenu}{sessionMenu}</section></details>
      <details className="command-menu" onToggle={event=>commandToggle(event.currentTarget)}><summary>{t('menu.edit')}</summary><section aria-label={t('menu.edit')}>
        <button type="button" {...busyGuard({busy:editBusy,disabled:!state.snapshot.canUndo,onClick:()=>{change(controller.undo());}})}>{t('menu.undo')}</button>
        <button type="button" {...busyGuard({busy:editBusy,disabled:!state.snapshot.canRedo,onClick:()=>{change(controller.redo());}})}>{t('menu.redo')}</button>
        <button type="button" {...busyGuard({busy:controlsBusy,unavailable:editLocked||!musicSelection,onClick:()=>{copyMusic('singleTrack',true);}})}>{t('menu.cut')}</button>
        <button type="button" {...busyGuard({busy:controlsBusy,unavailable:!musicSelection,onClick:()=>{copyMusic('singleTrack');}})}>{t('menu.copy')}</button>
        <button type="button" {...busyGuard({busy:controlsBusy,unavailable:editLocked,onClick:()=>{pasteMusic();}})}>{t('menu.paste')}</button>
        <button type="button" onClick={()=>{editorSelection(selectionForTrack(state.score,target.track));}}>{t('menu.select_track')}</button>
        <button type="button" onClick={()=>{openPalette();}}>{t('menu.command_palette')}</button>
      </section></details>
      <details className="command-menu" onToggle={event=>commandToggle(event.currentTarget)}><summary>{t('menu.track')}</summary><section aria-label={t('menu.track')}>
        <button type="button" onClick={()=>{openInspector('track');}}>{t('menu.track_properties')}</button>
        <button type="button" onClick={()=>{chooseDock('mixer');}}>{t('menu.dock_mixer')}</button>
        <button type="button" onClick={()=>{chooseDock('instrument');}}>{t('menu.dock_instrument')}</button>
      </section></details>
      <details className="command-menu" onToggle={event=>commandToggle(event.currentTarget)}><summary>{t('menu.bar')}</summary><section aria-label={t('menu.bar')}>
        <button type="button" onClick={()=>{displayActions.current.measure(target.bar);}}>{t('menu.bar_properties')}</button>
      </section></details>
      <details className="command-menu" onToggle={event=>commandToggle(event.currentTarget)}><summary>{t('menu.note')}</summary><section aria-label={t('menu.note')}>
        <button type="button" onClick={()=>{openInspector('selection','note');}}>{t('menu.note_properties')}</button>
        <button type="button" onClick={()=>{openInspector('selection','beat');}}>{t('menu.beat_properties')}</button>
      </section></details>
      <details className="command-menu" onToggle={event=>commandToggle(event.currentTarget)}><summary>{t('menu.effects')}</summary><section aria-label={t('menu.effects')}>
        <button type="button" onClick={()=>{setPaletteVisible(true);setView('score');}}>{t('menu.palette_effects')}</button>
        <button type="button" {...busyGuard({busy:controlsBusy,unavailable:!location.beat,onClick:()=>{openModal('harmony');}})}>{t('menu.chord')}</button>
      </section></details>
      <details className="command-menu" onToggle={event=>commandToggle(event.currentTarget)}><summary>{t('menu.section')}</summary><section aria-label={t('menu.section')}>
        <button type="button" onClick={()=>{openInspector('selection','all');}}>{t('menu.sections')}</button>
      </section></details>
      <details className="command-menu" onToggle={event=>commandToggle(event.currentTarget)}><summary>{t('menu.tools')}</summary><section aria-label={t('menu.tools')}>
        <button type="button" onClick={()=>{closeCommands();if(practiceMenu.current){practiceMenu.current.open=true;practiceMenu.current.querySelector('summary')?.focus();}}}>{t('menu.practice')}</button>
        <button type="button" onClick={()=>{openModal('scale');}}>{t('menu.scales')}</button>
      </section></details>
      <details className="command-menu" onToggle={event=>commandToggle(event.currentTarget)}><summary>{t('menu.sound')}</summary><section aria-label={t('menu.sound')}>
        <button type="button" onClick={()=>{setView('score');}}>{t('menu.show_score')}</button>
        <button type="button" onClick={()=>{setView('sound');}}>{t('menu.show_sound')}</button>
        <button type="button" onClick={()=>{setView('mixer');}}>{t('menu.show_mixer')}</button>
        <button type="button" onClick={()=>{openInspector('track');}}>{t('menu.track_sound')}</button>
        <button type="button" onClick={()=>{openInspector('song');}}>{t('menu.sound_mastering')}</button>
      </section></details>
      <details ref={viewMenu} className="command-menu" onToggle={event=>commandToggle(event.currentTarget)}><summary>{t('menu.view')}</summary><section aria-label={t('menu.workspace_view')}>
        <label className="check"><input type="checkbox" checked={inspectorVisible} onChange={event=>event.target.checked?showInspector():setInspectorVisible(false)}/>{t('view.inspector')}</label>
        <label className="check"><input type="checkbox" checked={dockVisible} onChange={event=>setDockVisible(event.target.checked)}/>{t('view.bottom_dock')}</label>
        <label className="check"><input type="checkbox" checked={paletteVisible} onChange={event=>setPaletteVisible(event.target.checked)}/>{t('view.edition_palette')}</label>
        <InputPreferencesPanel preferences={inputPrefs} onChange={setInputPrefs} preview={auditionEdits} onPreview={play=>{setAuditionEdits(play);writeAuditionWhileEditing(play);}}/>
        <div className="language-setting-row"><label>{t('preferences.language')}: <select aria-label={t('preferences.language')} value={preference} onChange={e=>setPreference(e.target.value as LanguagePreference)}><option value="system">{t('preferences.lang_system')}</option><option value="en">{t('preferences.lang_en')}</option><option value="et">{t('preferences.lang_et')}</option><option value="de">{t('preferences.lang_de')}</option></select></label></div>
      </section></details>
      <details className="command-menu" onToggle={event=>commandToggle(event.currentTarget)}><summary>{t('menu.window')}</summary><section aria-label={t('menu.window')}>
        <button type="button" onClick={()=>{chooseDock('overview');}}>{t('menu.dock_overview')}</button>
        <button type="button" onClick={()=>{chooseDock('mixer');}}>{t('menu.dock_mixer_window')}</button>
        <button type="button" onClick={()=>{chooseDock('instrument');}}>{t('menu.dock_instrument_window')}</button>
        <button type="button" onClick={()=>{chooseDock('keyboard');}}>{t('menu.dock_keyboard')}</button>
        <button type="button" onClick={()=>{chooseDock('backing');}}>{t('menu.dock_backing')}</button>
      </section></details>
      <details className="keyboard-help" onToggle={event=>commandToggle(event.currentTarget)} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();event.currentTarget.open=false;event.currentTarget.querySelector('summary')?.focus();}}}><summary>{t('menu.help')}</summary><section role="region" aria-label={t('help.keyboard_editing_help')}>
      <div className="help-actions"><button type="button" onClick={()=>openHelp('start')}>{t('help.topics_f1')}</button><button type="button" onClick={()=>openHelp('about')}>{t('help.about_updates')}</button></div>
      <h2>{t('help.keyboard_editing_heading')}</h2><p>{t('help.keyboard_editing_intro')}</p>
      <dl><dt>{t('keys.chord_new_open')}</dt><dd>{t('help.shortcut_new_open')}</dd><dt>{t('keys.chord_save')}</dt><dd>{t('help.shortcut_save')}</dd><dt>{t('keys.chord_close')}</dt><dd>{t('help.shortcut_close')}</dd><dt>{t('keys.chord_next_score')}</dt><dd>{t('help.shortcut_next_score')}</dd><dt>{t('keys.chord_undo')}</dt><dd>{t('help.shortcut_undo_redo')}</dd><dt>{t('keys.space')}</dt><dd>{t('help.shortcut_play')}</dd><dt>{t('keys.chord_palette')}</dt><dd>{t('help.shortcut_palette')}</dd></dl>
      <button type="button" onClick={openPalette}>{t('help.open_command_palette')}</button>
      <h3>{t('help.score_focused_heading')}</h3><dl><dt>{t('keys.left_right')}</dt><dd>{t('help.shortcut_beat')}</dd><dt>{t('keys.up_down')}</dt><dd>{t('help.shortcut_string')}</dd><dt>{t('keys.digits_enter')}</dt><dd>{t('help.shortcut_fret')}</dd><dt>{t('keys.chord_selection')}</dt><dd>{t('help.shortcut_selection')}</dd><dt>{t('keys.chord_select_track')}</dt><dd>{t('help.shortcut_select_track')}</dd><dt>{t('keys.chord_tie')}</dt><dd>{t('help.shortcut_tie')}</dd><dt>{t('keys.chord_clipboard')}</dt><dd>{t('help.shortcut_clipboard')}</dd><dt>{t('keys.escape')}</dt><dd>{t('help.shortcut_clear')}</dd><dt>N</dt><dd>{t('help.shortcut_note_entry')}</dd><dt>{t('keys.note_move')}</dt><dd>{t('help.shortcut_note_move')}</dd><dt>{t('keys.accidental')}</dt><dd>{t('help.shortcut_accidental')}</dd><dt>{t('keys.chord_gp8_edit')}</dt><dd>{t('help.shortcut_gp8_edit')}</dd><dt>{t('keys.chord_gp8_cursor')}</dt><dd>{t('help.shortcut_gp8_cursor')}</dd><dt>{t('keys.chord_gp8_voice')}</dt><dd>{t('help.shortcut_gp8_voice')}</dd><dt>{t('keys.chord_gp8_track')}</dt><dd>{t('help.shortcut_gp8_track')}</dd><dt>{t('keys.chord_gp8_bar')}</dt><dd>{t('help.shortcut_gp8_bar')}</dd><dt>{t('keys.chord_gp8_play_bar')}</dt><dd>{t('help.shortcut_gp8_play_bar')}</dd><dt>{t('keys.chord_gp8_go_to')}</dt><dd>{t('help.shortcut_gp8_go_to')}</dd><dt>{t('keys.chord_gp8_techniques')}</dt><dd>{t('help.shortcut_gp8_techniques')}</dd></dl>
      <p>{t('help.workflow_description')}</p>
    </section></details>
    </nav><span className="document-title">{state.score.title || t('score.untitled')}{state.snapshot.dirty?' •':''}</span>
    </header>
    <div className="gp-toolbar">
      <div className="gp-toolbar-left" role="group" aria-label={t('toolbar.main')}>
        <button type="button" className="note-entry-toggle" aria-pressed={noteEntryOn} aria-keyshortcuts="N" title={t('score_entry.toggle_title')} onClick={()=>{const on=!noteEntryOn;setNoteEntryOn(on);setView('score');if(on)requestAnimationFrame(()=>scorePane.current?.focus());}}><NoteEntryGlyph/><span className="tp-sr">{t('score_entry.toggle')}</span></button><span className="gp-joined pane-toggles"><button type="button" data-pane-toggle="palette" aria-pressed={paletteVisible} title={t('toolbar.toggle_palette')} aria-label={t('toolbar.toggle_palette')} onClick={()=>setPaletteVisible(!paletteVisible)}><PaletteGlyph/></button><button type="button" data-pane-toggle="dock" aria-pressed={dockVisible} title={t('toolbar.toggle_dock')} aria-label={t('view.toggle_bottom_dock')} onClick={()=>setDockVisible(!dockVisible)}><PanelBottomGlyph/></button><button type="button" data-pane-toggle="inspector" aria-pressed={inspectorShown} title={t('toolbar.toggle_inspector')} aria-label={t('view.toggle_inspector')} onClick={()=>inspectorShown?setInspectorVisible(false):showInspector()}><PanelRightGlyph/></button></span>
        <span className="gp-joined"><button type="button" disabled={editBusy || !state.snapshot.canUndo} onClick={()=>change(controller.undo())} title={t('action.undo_title')}><UndoGlyph/><span className="tp-sr">{t('action.undo')}</span></button><button type="button" disabled={editBusy || !state.snapshot.canRedo} onClick={()=>change(controller.redo())} title={t('action.redo_title')}><RedoGlyph/><span className="tp-sr">{t('action.redo')}</span></button></span>
        <button type="button" title={t('toolbar.print')} aria-label={t('toolbar.print')} {...busyGuard({busy:controlsBusy||exports.busy,onClick:()=>openModal('export')})}><ExportGlyph/></button>
        <span className="tp-sr score-tools">{state.score.masterBars.length} measures · {state.score.tracks.length} tracks</span>
      </div>
      <div className="gp-toolbar-display"><TrackDisplayControls ids={trackIds} names={state.score.tracks.map(track=>track.name)} selected={target.track} view={trackView} zoom={zoom} disabled={controlsBusy} onView={setTrackView} onZoom={manualZoom} display={display} onDisplay={setScoreDisplay} actualZoom={displayStatus?.zoomPercent} fitLimited={displayStatus?.fitLimited} pageError={displayStatus?.pageError}/></div>
      {player && <Transport player={player} measures={state.score.masterBars.length} busy={controlsBusy} cursor={target} selection={musicSelection} display={transportDisplay}/>}
      <div className="gp-toolbar-right">
        <details ref={practiceMenu} className="gp-practice" onToggle={event=>{if(event.currentTarget.open)event.currentTarget.querySelectorAll<HTMLDetailsElement>('.gp-practice-body details:not([open])').forEach(inner=>{inner.open=true;});}} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();event.currentTarget.open=false;event.currentTarget.querySelector('summary')?.focus();}}}><summary title={lineInOn?t('toolbar.practice_line_in'):t('toolbar.practice')} aria-label={lineInOn?t('toolbar.practice_line_in'):t('toolbar.practice')} data-line-in={lineInOn||undefined}><PracticeGlyph/>{lineInOn&&<span className="line-in-badge" aria-hidden="true"/>}</summary><div ref={setPracticeHost} className="gp-practice-body"/></details>
        <Segmented className="view-switch" label={t('view.view_label')} value={view} onChange={setView} options={[{value:'score',label:<><ScoreGlyph/><span className="tp-sr">{t('view.score')}</span></>,title:t('view.score')},{value:'sound',label:<><AmpGlyph/><span className="tp-sr">{t('view.sound')}</span></>,title:t('view.sound')},{value:'mixer',label:<><MixerGlyph/><span className="tp-sr">{t('view.mixer')}</span></>,title:t('view.mixer')}]}/>
        <button type="button" className="gp-instrument" aria-pressed={instrumentShown} title={t('toolbar.instrument')} aria-label={instrumentShown?t('toolbar.hide_instrument'):t('toolbar.show_instrument')} onClick={()=>{if(instrumentShown){setInstrumentVisible(false);setKeyboardVisible(false);}else chooseDock('instrument');}}><FretboardGlyph/></button>
      </div>
    </div>
    {documentTabs}
    {finalized&&<div className="finalized-banner" role="status"><p>{t('status.finalized_banner')}</p><button disabled={controlsBusy||passwordLocked} onClick={()=>act(controller.setLock(null))}>{t('action.unfinalize')}</button></div>}
    {passwordLocked&&<div className="finalized-banner" role="status"><p>{t('status.password_locked_banner')}</p><button {...busyGuard({busy:controlsBusy,onClick:()=>openProtection('unlock')})}>{t('action.unlock_editing_ellipsis')}</button></div>}
    <CabinetNotices sounds={state.settings.sounds} trackNames={trackNames}/>
    <CaptureNotices sounds={state.settings.sounds} trackNames={trackNames}/>
    <PluginNotices
      statuses={pluginStatuses}
      moved={pluginMoves}
      notices={pluginNoticeList}
      onDismiss={pluginNotices.dismiss}
      trackNames={trackNames}
      onAllow={() => pluginConsentGrant(state.documentId)}
      onRetry={retryTrackId => pluginRetry(state.documentId, retryTrackId)}
    />
    {(clipboardError||workspaceError||state.error||(!exportOpen&&exportError)||pageState.error||harmonyOpen&&libraryError) && <div className="error" role="alert">{clipboardError||workspaceError||state.error||exportError||pageState.error||libraryError}</div>}
    {state.importNotice && <div className="notice" role="status">{state.importNotice}</div>}
    <div ref={workspace} className="workspace workstation-workspace" data-view={view} data-inspector={inspectorShown} data-dock={dockVisible} data-dock-collapsed={dockCollapsed} style={{'--dock-height':`${dockHeight}px`,'--inspector-width':`${inspectorWidth}px`} as React.CSSProperties}>
      <section ref={scorePane} className="score-workspace" aria-label={t('workspace.score_workspace')} tabIndex={0} onKeyDown={keys} onPointerDownCapture={clearEntryQueue} onBlur={event=>{if(!(event.relatedTarget instanceof Node&&event.currentTarget.contains(event.relatedTarget)))clearEntryQueue();}}>
        <div className="score-body">{paletteVisible&&view==='score'&&<aside ref={setPaletteHost} className="score-palette" aria-label={t('view.edition_palette')}/>}<div className="paper-scroll"><div className="paper score-paper-host"><ScoreView score={state.score} loop={loopPassage} track={target.track} trackIds={trackIds} zoom={zoom} display={display} page={page} onDisplayStatus={onDisplayStatus} onFontStatus={setFontStatus} onSystems={setRenderedSystems} profile="Default" projection={projection} engraving={state.settings.engraving} visibleTracks={visibleTracks} onSelect={select} playback={player} editorSelection={musicSelection} onEditorSelection={editorSelection} editTarget={target} editString={indexed?undefined:string} editNoteIndex={noteIndex} editPendingFret={pendingFret} errors={markErrors?scoreErrors:undefined} noteEntry={scoreNoteEntry} symbols={view==='score'?{busy:controlsBusy,locked:editLocked?lockedMessage:null,request:symbolRequest,onEdit:command=>{if(editLocked){setClipboardError(lockedMessage);return Promise.resolve(false);}return edit(command);},onChordEditor:chordTarget=>{editorSelection(null);select(chordTarget);openModal('harmony');}}:undefined} barDesign={barDesign?{busy:editBusy,scaleOf:bar=>barScaleOf(state.settings.engraving,bar,sourceWeight(state.score,visibleTracks,bar)),defaultOf:bar=>sourceWeight(state.score,visibleTracks,bar),onScale:(bar,scale)=>{const engraving=withBarScale(state.settings.engraving,bar,scale,sourceWeight(state.score,visibleTracks,bar));if(engraving!==state.settings.engraving)void edit({type:'setEngraving',engraving});}}:null}/></div></div></div>
        {pendingFret!==null?<div className="score-hint score-hint-pending-fret" role="status">{t('editor.pending_fret',{fret:pendingFret})}</div>:inputNotice&&inputNotice.at===JSON.stringify(target)?<div className="score-hint" role="status">{inputNotice.text}</div>:noteEntryOn&&view==='score'&&<div className="score-hint" role="status">{pendingAccidental?t('score_entry.pending',{accidental:t(accidentalLabelKeys[pendingAccidental])}):t(inputPrefs.swapPlusMinus?'score_entry.on_swapped':'score_entry.on')}</div>}
      </section>
      {inspectorShown&&<InspectorResizeHandle width={inspectorWidth} min={inspectorMin} max={inspectorMax} onWidth={setInspectorSize} onReset={()=>setInspectorSize(null)}/>}
      <div ref={inspectorPane} className="workstation-inspector" hidden={!inspectorShown}>
      <div className="inspector-tabs" role="tablist" aria-label={t('inspector.tabs')} onKeyDown={event=>{const order:InspectorTab[]=['song','track','selection'];const step=event.key==='ArrowRight'?1:event.key==='ArrowLeft'?-1:0;if(!step)return;event.preventDefault();const next=order[(order.indexOf(inspectorTab)+step+order.length)%order.length];setInspectorTab(next);requestPaneFocus(next);}}><button type="button" role="tab" id={`inspector-tab-song`} aria-controls={`inspector-panel-song`} data-inspector-tab="song" aria-selected={inspectorTab==='song'} tabIndex={inspectorTab==='song'?0:-1} onClick={()=>setInspectorTab('song')}>{t('inspector.song')}</button><button type="button" role="tab" id={`inspector-tab-track`} aria-controls={`inspector-panel-track`} data-inspector-tab="track" aria-selected={inspectorTab==='track'} tabIndex={inspectorTab==='track'?0:-1} onClick={()=>setInspectorTab('track')}>{t('inspector.track')}</button><button type="button" role="tab" id={`inspector-tab-selection`} aria-controls={`inspector-panel-selection`} data-inspector-tab="selection" aria-selected={inspectorTab==='selection'} tabIndex={inspectorTab==='selection'?0:-1} onClick={()=>setInspectorTab('selection')}>{t('inspector.selection')}</button></div>
      <div className="inspector-tabpanel" role="tabpanel" id="inspector-panel-song" aria-labelledby="inspector-tab-song" hidden={inspectorTab!=='song'}>
        <div ref={setSongHost} className="inspector-song-host"/>
        <section className="inspector-section" aria-labelledby="inspector-sound-mastering"><h3 id="inspector-sound-mastering">{t('inspector.sound_mastering')}</h3><MasterPanel master={player?.master?.()} disabled={controlsBusy||!player?.setMaster} onChange={next=>player!.setMaster!(next)}/></section>
      </div>
      <div className="inspector-tabpanel" role="tabpanel" id="inspector-panel-track" aria-labelledby="inspector-tab-track" hidden={inspectorTab!=='track'}>
        <section className="inspector-section" aria-labelledby="inspector-track-info"><h3 id="inspector-track-info">{t('inspector.information')}</h3><TrackSettingsPanel key={state.documentEpoch} score={state.score} selected={target.track} busy={controlsBusy} locked={editLocked} onEdit={edit} onAudition={auditionTuning}/></section>
        <section className="inspector-section" aria-labelledby="inspector-track-sounds"><h3 id="inspector-track-sounds">{t('inspector.sounds')}</h3>{view==='score'&&<SoundPanel trackId={trackId} percussion={selectedTrack.isPercussion} sound={state.settings.sounds[trackId]} onEdit={(command,asset)=>controller.edit(command,asset)} playback={player} busy={editBusy} shown={inspectorShown&&inspectorTab==='track'} documentId={state.documentId} status={pluginStatuses.find(s=>s.trackId===trackId)?.status} onAllowConsent={()=>pluginConsentGrant(state.documentId)} onRetrySlot={()=>pluginRetry(state.documentId,trackId)}/>}</section>
        <section className="inspector-section" aria-labelledby="inspector-track-interpretation"><h3 id="inspector-track-interpretation">{t('inspector.interpretation')}</h3><InterpretationPanel trackId={trackId} mix={state.settings.mixes[trackId]} stringed={selectedTrack.staves.some(staff=>staff.isStringed)} busy={controlsBusy} onEdit={command=>controller.edit(command)}/></section>
        <section className="inspector-section" aria-labelledby="inspector-track-midi-out"><h3 id="inspector-track-midi-out">{t('inspector.midi_out')}</h3><MidiOutPanel key={trackId} owner={waveformBridge.owner} trackId={trackId} mix={state.settings.mixes[trackId]} busy={controlsBusy} onEdit={command=>controller.edit(command)}/></section>
      </div>
      <div className="inspector-tabpanel" role="tabpanel" id="inspector-panel-selection" aria-labelledby="inspector-tab-selection" hidden={inspectorTab!=='selection'}>
      <EditorPanel documentEpoch={state.documentEpoch} songHost={songHost} practiceHost={practiceHost} paletteHost={paletteVisible&&view==='score'?paletteHost:null} measureRequest={measureRequest} lyricsRequest={lyricsRequest} onOpenLyrics={()=>{setContextScope('staff');setInspectorVisible(true);setInspectorTab('selection');setLyricsRequest(tick=>tick+1);}} onOpenMeasure={bar=>displayActions.current.measure(bar)} contextScope={contextScope} onContextScopeChange={setContextScope} score={state.score} target={target} string={string} fret={fret} noteIndex={noteIndex} onSelectNote={setNoteIndex} busy={controlsBusy} locked={editLocked} onSelect={next=>{editorSelection(null);select(next);}} onString={s=>select(target,s)} onFret={setFret} onEdit={edit} musicSelection={musicSelection} onMusicSelection={editorSelection} onChord={()=>openModal('harmony')} onScales={()=>openModal('scale')} onAudition={auditionTuning}
        practiceTools={player&&playbackState&&<PracticePanel key={state.documentEpoch} settings={playbackState.practice.settings} busy={controlsBusy||playbackState.practicePending||!playbackState.ready} hasBacking={!!audioSettings.backing} onChange={settings=>player.setPractice(settings)}/>} tunerTool={<><TunerPanel tuning={tunerTuning}/><LineInPanel/></>}
        presentationTools={<><EngravingPanel key={`engraving/${state.documentEpoch}`} score={state.score} trackIds={trackIds} value={state.settings.engraving} busy={controlsBusy} onEdit={edit} fontStatus={fontStatus} headerFooter={page.headerFooter}/><BarWidthsPanel value={state.settings.engraving} design={barDesign} onDesign={setBarDesign} busy={editBusy} honoured={barWidthsHonoured} onEdit={edit}/><SystemGapsPanel value={state.settings.engraving} systems={renderedSystems} pageLayout={systemGapsLayout} bar={gapBar} busy={editBusy} locked={editLocked} pageError={!!displayStatus?.pageError} onEdit={edit}/><StaffGroupsPanel key={`staff-groups/${state.documentEpoch}`} value={state.settings.engraving} score={state.score} trackIds={trackIds} rendered={visibleTracks} pageLayout={systemGapsLayout} busy={editBusy} locked={editLocked} onEdit={edit}/><PageLayoutPanel key={`page/${state.documentEpoch}`} value={page} busy={controlsBusy} onEdit={edit}/></>} presentationViewTools={<ViewDefaultsPanel current={{zoom,trackView,scoreDisplay}} load={currentViewDefaults} onSave={writeViewDefaults}/>}>
        <NotationEntryPanel score={state.score} target={target} busy={controlsBusy} locked={editLocked} onEdit={instrumentEdit} preview={command=>previewEdit(controller.getState().snapshot.project,command).score}/>
        <div ref={clipboardSection}><ClipboardPanel score={state.score} target={target} selection={musicSelection} clip={clip} busy={controlsBusy} locked={editLocked} onCopy={mode=>copyMusic(mode)} onCut={mode=>copyMusic(mode,true)} onPaste={pasteMusic} diagramsDefault={inputPrefs.pasteDiagrams}/></div>
        <SectionsPanel sections={sections} bar={target.bar} onGo={bar=>{editorSelection(null);select({...target,bar,beat:0});if(player?.getState().playing)try{player.seekToMeasure(bar);}catch{/* The transport shows its own error; the selection has moved. */}}}/>
        <ScoreErrorsPanel errors={scoreErrors} mark={markErrors} onMark={mark=>{setMarkErrors(mark);writeScoreErrorDisplay(mark);}} onSelect={next=>select(next)} onFit={editLocked?undefined:error=>edit({type:'fitVoice',track:error.track,staff:error.staff,bar:error.bar,voice:error.voice})} busy={controlsBusy} shownTracks={visibleTracks}/>
        <HarmonyTransposePanel key={`harmony/${state.documentEpoch}`} score={state.score} selection={musicSelection} busy={editBusy} onEdit={edit}/>
      </EditorPanel>
      </div>
      </div>
      {view==='sound'&&<SoundRig trackId={trackId} sound={state.settings.sounds[trackId]} onEdit={command=>controller.edit(command)} playback={player} busy={editBusy}
        tracks={state.score.tracks.map((track,index)=>({id:trackIds[index],name:track.name||t('track_display.track_fallback',{index:index+1}),program:track.playbackInfo.program,percussion:track.staves.some(staff=>staff.isPercussion)}))}
        onTrack={id=>{const index=trackIds.indexOf(id);if(index>=0)select({track:index,staff:0,bar:target.bar,voice:0,beat:0},state.score.tracks[index].staves[0].tuning.length);}}
        ampCapture={board=><AmpCapture value={board.effects.amp.capture} busy={editBusy} label={board.name} scope={`${trackId}:${board.name('Amp')}`} onLibraryChange={()=>{if(player&&typeof player.refreshSounds==='function')void player.refreshSounds().catch(()=>{});}} onChange={capture=>{if(!editBusy)board.write(effects=>{if(capture)effects.amp.capture=capture;else delete effects.amp.capture;});}}/>}
        cabinetResponse={board=><CabinetResponse ir={board.effects.cabinet.ir} model={board.effects.cabinet.model} label={board.name} scope={`${trackId}:${board.name('Cabinet')}`} onLibraryChange={()=>{if(player&&typeof player.refreshSounds==='function')void player.refreshSounds().catch(()=>{});}} onChange={ir=>{if(!editBusy)board.write(effects=>{if(ir)effects.cabinet.ir=ir;else delete effects.cabinet.ir;});}}/>}/>}
      {view==='mixer'&&<MixerView score={state.score} sounds={state.settings.sounds} selected={target.track} busy={controlsBusy} player={player} onSelect={track=>select({track,staff:0,bar:target.bar,voice:0,beat:0},state.score.tracks[track].staves[0].tuning.length)}/>}
      <section className="workstation-dock" aria-label={t('workspace.bottom_dock')} hidden={!dockVisible}>
        {!dockCollapsed&&<DockResizeHandle height={dockHeight} min={dockMin} max={dockMax} onHeight={setDockSize} onReset={()=>setDockSize(null)}/>}
        <nav aria-label={t('dock.views_group')}><button aria-pressed={!dockPanelVisible&&dockMode==='overview'} onClick={()=>chooseDock('overview')}>{t('dock.overview')}</button><button aria-pressed={!dockPanelVisible&&dockMode==='mixer'} onClick={()=>chooseDock('mixer')}>{t('dock.mixer')}</button><button aria-pressed={instrumentVisible} onClick={()=>chooseDock('instrument')}>{t('dock.instrument')}</button><button aria-pressed={keyboardVisible} onClick={()=>chooseDock('keyboard')}>{t('dock.keyboard')}</button><button aria-pressed={!dockPanelVisible&&dockMode==='backing'} onClick={()=>chooseDock('backing')}>{t('dock.backing')}</button><button className="dock-collapse" aria-label={t(dockCollapsed?'dock.expand_aria':'dock.hide_aria')} onClick={()=>dockCollapsed?setDockForced(true):hideDock()}>{t(dockCollapsed?'dock.expand':'dock.hide')}</button></nav>
        <div className="workstation-dock-content" hidden={dockCollapsed}>
          <div className="workstation-dock-tracks" hidden={dockPanelVisible||dockMode==='backing'}>{view!=='mixer'&&<TrackPanel score={state.score} loop={loopPassage} selected={target.track} busy={controlsBusy} player={player} shown={visibleTracks} onToggleShown={toggleShownTrack} onAddTrack={editLocked?undefined:startAddTrack} view={dockMode==='mixer'?'mixer':'overview'} target={target} onExitOverview={()=>scorePane.current?.focus()} onSelectPosition={(track,bar)=>select({track,staff:0,bar,voice:0,beat:0})} onSelect={track=>select({track,staff:0,bar:target.bar,voice:0,beat:0},state.score.tracks[track].staves[0].tuning.length)}/>}</div>
          {instrumentVisible&&<LiveInstrumentView score={state.score} track={target.track} staff={target.staff} target={target} noteIndex={noteIndex} player={player} onEdit={instrumentEdit} onSelect={selectFromInstrument} busy={controlsBusy} locked={editLocked} string={string}/>}
          {keyboardVisible&&<LiveInstrumentView panel="keyboard" score={state.score} track={target.track} staff={target.staff} target={target} noteIndex={noteIndex} player={player} onEdit={instrumentEdit} onSelect={selectFromInstrument} busy={controlsBusy} locked={editLocked} string={string}/>}
          <div className="workstation-dock-backing" hidden={dockPanelVisible||dockMode!=='backing'}>
            <div className="workstation-dock-backing-settings"><BackingPanel visible={referenceVisible} settings={originalBacking?undefined:state.settings.backing} originalSettings={state.embeddedBackingSettings?{assetId:'embedded',...state.embeddedBackingSettings}:null} assets={state.snapshot.project.assets} embedded={state.embeddedBacking} playback={player} onEdit={backingEdit} stageBacking={audioBridge.stageBacking} stageEmbeddedBacking={audioBridge.stageEmbeddedBacking} beginOperation={beginEditorOperation} busy={editBusy} durationMs={sourceDurationMs??undefined} reference={reference} onShowWaveform={()=>chooseDock('backing')}/>{referenceVisible&&sourceMetadataStatus}</div>

            {originalBacking&&!currentEmbedded?.source?<div className="backing-waveform-state">{currentEmbedded?.error?<><p role="alert">{currentEmbedded.error}</p><button onClick={()=>setEmbeddedRetry(value=>value+1)}>{t('action.retry')}</button></>:<p role="status">{t('dock.loading_waveform')}</p>}</div>:<BackingWaveform document={{documentId:state.documentId,revision:state.revision}} source={waveformSource} filename={state.settings.backing?state.snapshot.project.assets[state.settings.backing.assetId]?.filename??t('dock.backing_audio_default'):state.snapshot.project.base.kind==='file'?state.snapshot.project.base.filename:t('dock.backing_audio_default')} bridge={waveformBridge} timeline={backingTimeline} selection={backingSelection} settings={state.settings.backing} effectiveBacking={audioSettings.backing} reference={reference} scoreTimeMs={playbackState?.ready&&!playbackState.error&&!['countIn','ended'].includes(playbackState.practice.phase)?playbackState.time:null} enabled={waveformEnabled} busy={editBusy} beginOperation={beginEditorOperation} isCurrent={waveformCurrent} onEdit={command=>controller.edit(command)}/>}
          </div>
        </div>
      </section>
    </div>
    {exportOpen&&<ExportDialog layoutLocked={editLocked} layoutLockedNote={finalized?undefined:t('export.layout_locked_note')} plainNote={state.snapshot.protection&&(state.snapshot.protection.open||state.snapshot.protection.edit!=='none')?t('export.plain_protection_note'):undefined} sounds={state.settings.sounds} trackNames={trackNames} pluginWarnings={pluginStatuses} score={state.score} layout={state.settings.print} page={page} currentSpeedAvailable={practiceRatio!==null} busy={exports.busy||state.busy||exportLaunching} progress={exports.progress} failure={exportError} gpBackingIssue={gpBackingIssue} hasBacking={!!audioSettings.backing} onExport={runExport} onCancel={cancelExport}/>}
    {harmonyOpen&&location.beat&&<HarmonyChordDialog score={state.score} target={target} selection={musicSelection} value={location.beat.chord?getHarmonyChord(location.beat.chord):null} busy={state.busy||libraryLoading} library={library} onEdit={edit} onClose={closeModal} onLibraryPut={async entry=>{const revision=++libraryRevision.current,value=await putHarmonyLibraryEntry(entry);if(revision===libraryRevision.current)setLibrary(value);}} onLibraryRemove={async id=>{const revision=++libraryRevision.current,value=await removeHarmonyLibraryEntry(id);if(revision===libraryRevision.current)setLibrary(value);}}/>}
    {helpTopic!==null&&<HelpDialog initial={helpTopic} onClose={closeHelp}/>}
    {asciiOpen&&onImportConverted&&<AsciiTabImportDialog busy={controlsBusy} onImport={(name,bytes)=>{const job=onImportConverted(name,bytes);documentAction(job);return job;}} onClose={closeAscii}/>}
    {batchOpen&&<BatchConvertDialog busy={controlsBusy} onClose={closeBatch}/>}
    {protectionDialog==='manage'&&<ProtectionDialog protection={state.snapshot.protection??{edit:'none',open:false}} dirty={state.snapshot.dirty} onRequest={request=>controller.protect(request)} onClose={closeProtection}/>}
    {protectionDialog==='unlock'&&<UnlockEditingDialog onTry={async password=>{await controller.protect({kind:'unlockEditing',password});closeProtection();}} onClose={closeProtection}/>}
    {midiOpen&&onImportConverted&&<MidiImportDialog busy={controlsBusy} onImport={(name,bytes)=>{const job=onImportConverted(name,bytes);documentAction(job);return job;}} onClose={closeMidi}/>}
    {paletteOpen&&<CommandPalette context={{score:state.score,target,string,canUndo:state.snapshot.canUndo,canRedo:state.snapshot.canRedo,locked:editLocked,scoreHidden:view==='sound'}} busy={controlsBusy} onRun={runPalette} onClose={closePalette}/>}
    {scaleOpen&&<ScaleToolPanel score={state.score} staff={location.staff} selection={musicSelection} busy={state.busy} target={target} beat={location.beat} onEdit={editLocked?undefined:edit} onNote={editLocked?undefined:instrumentEdit} onClose={closeModal}/>}
    <footer className="statusbar">{state.busy?t('status.working'):state.snapshot.dirty?t('status.unsaved'):state.snapshot.path?t('status.saved'):state.snapshot.project.base.kind==='file'?t('status.not_saved'):t('status.new_score')}{pendingFret!==null?<span className="statusbar-pending-fret">{t('editor.pending_fret',{fret:pendingFret})}</span>:<span>{state.snapshot.path ?? t('status.save_hint')}</span>}{recoveryStatus}<span className="score-hint statusbar-position" title={indexed?t('status.hint_note'):t('status.hint_score')}>{indexed?t('status.position_note',{bar:target.bar+1,beat:target.beat+1,note:noteIndex===null?'–':noteIndex+1,voice:target.voice+1}):t('status.position',{bar:target.bar+1,beat:target.beat+1,string,voice:target.voice+1})}</span></footer>
  </div>;
}
