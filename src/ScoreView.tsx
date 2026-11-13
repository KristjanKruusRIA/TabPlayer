import {applyEffectBandSpacing} from './engraving/effect-bands';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { AlphaTabApi, EngravingSettings, LayoutMode, SystemsLayoutMode, type model, StaveProfile, type PlaybackHighlightChangeEventArgs } from '@coderline/alphatab';
import './tremolo-guard';
import type { BeatTarget } from './project';
import type { NativePlaybackController } from './audio/NativePlaybackController';
import type { MusicSelection, VoiceAddress } from './editor/range-types';
import { rangeFromBeats, resolveSelectionBeats, resolveSelectionNotes, selectionForBars, selectionForTrack } from './editor/range-selection';
import { configureEngraving, type EngravingProjection } from './engraving/projection';
import type { EngravingOverrides,PageLayout } from './engraving/types';
import {engravingRenderKey,withoutStackingOffsets,type SystemSpan} from './engraving/system-gaps';
import {headerScaleOf,pageGeometry,pageTextFontFamily,pageTextItems,screenPageBaselines} from './engraving/page';
import {fontStack} from './engraving/font-catalog';
import {pageRoleFont,withoutMusicFont,withoutPageFonts,type EngravingFonts} from './engraving/fonts';
import {loadedMusicFont,loadMusicFont,loadRoleFaces,roleFacesPending,type MusicFontData} from './engraving/font-loading';
import {musicFonts,type MusicFontId} from './engraving/font-catalog';
import {headerFieldsOf} from './engraving/header-footer';
import {tabDigitFloorPercent,typographyOf} from './engraving/typography';
import {loadExportFonts} from './export/pdf';
import {wantsAutoFit} from './engraving/auto-fit';
import {isPhysicalPageLayout,type ScoreDisplayPreferences} from './engraving/screen-view';
import {passageBands,type PassageBar} from './engraving/passage-bands';
import type {LoopBar,LoopPassage} from './audio/loop-passage';
import {arrangeScreenPages,beatSpanOf,hitTestScreenPages,mapScreenRect,paginateScreenScore,resolveScreenZoom,unmapScreenPoint,type ScreenBounds,type ScreenPagination,type ScreenRenderChunk,type ScreenRect,type ScreenSystem} from './engraving/screen-pages';
import {installScreenPlayback,type ScreenPlaybackContext} from './engraving/screen-playback';
import {accoladeMetrics,accoladeSvg,configureAccolades,planAccolades,systemAccoladeMarks,type AccoladeMetrics,type AccoladePlan} from './engraving/accolades';
import {composeScreenChunks,shiftTotal,staffLeftOf,systemTrackBands} from './engraving/staff-layout';
import {resolveStaffGaps} from './engraving/staff-groups';
import { describeScoreError,type ScoreError } from './editor/score-errors';
import { BAR_SCALE_BIG_STEP,BAR_SCALE_RANGE,BAR_SCALE_STEP,clampBarScale,scaleAfterDrag } from './engraving/bar-widths';
import { busyGuard } from './ui/useBusyGuard';
import { listScaleDiagrams,type ScaleDiagram } from './harmony/scale-diagram';
import { ScaleDiagramView,scaleDiagramSize } from './harmony/ScaleDiagramView';
import type { EditCommand } from './edit-types';
import { targetSymbols,type SymbolRef } from './editor/symbol-edit';
import { resolveSymbol,systemAt } from './editor/symbol-hit';
import { SymbolPopover,type SymbolView } from './SymbolPopover';
import { entryLayoutOf,scoreEntryHit,type MasterBarBox } from './engraving/score-entry-hit';
import { useI18n } from './i18n';
import './ScoreView.css';
/** A scale diagram is a compact chip above the staff at its beat; hovering or focusing it opens the diagram at this fraction of its natural size. */
const diagramScale=.45,chipHeight=16,chipGap=2;
const chipWidth=(diagram:ScaleDiagram)=>18+6*Math.min(14,(diagram.name||'Scale').length);
const chipLabel=(diagram:ScaleDiagram)=>(diagram.name||'Scale').slice(0,14);

const address=(beat:model.Beat):BeatTarget=>({track:beat.voice.bar.staff.track.index,staff:beat.voice.bar.staff.index,bar:beat.voice.bar.index,voice:beat.voice.index,beat:beat.index});
const sameLane=(a:VoiceAddress,b:VoiceAddress)=>a.track===b.track&&a.staff===b.staff&&a.voice===b.voice;
const sameBeat=(a:BeatTarget,b:BeatTarget)=>sameLane(a,b)&&a.bar===b.bar&&a.beat===b.beat;
type Marker={x:number;y:number;w:number;h:number};
/** A band over a passage; `before` and `after` mark a side where the passage goes on across a line break, which is left open. */
type Band=Marker&{before?:boolean;after?:boolean};
const noErrors:readonly ScoreError[]=[];
type Handles={start:Marker&{target:BeatTarget};end:Marker&{target:BeatTarget}};
type Drag={anchor:BeatTarget;last:BeatTarget;lanes:VoiceAddress[];bars?:Extract<MusicSelection,{kind:'bars'}>};

/** Design mode for bar widths: `scaleOf` is a bar's saved weight (1 is the default) and `onScale` records one edit. */
export interface BarDesign {busy:boolean;/** The bar's weight now, and the weight it has with no width set here (1, or what an imported file gave it). */scaleOf:(bar:number)=>number;defaultOf:(bar:number)=>number;onScale:(bar:number,scale:number)=>void}
/** Direct editing of the title, tempo marks, chord names and clefs on the rendered score: double-click edits in place, right-click (or Shift+F10 / the Menu key, counted in `request`) opens the actions that fit. */
export interface SymbolEditing {
  /** An operation is running: editors open but refuse to record. */
  busy:boolean;
  /** Why editing is unavailable (a locked document), or null. */
  locked:string|null;
  /** Records the edit; a promise settles to whether it landed. */
  onEdit:(command:EditCommand)=>Promise<boolean>|void;
  /** Selects the chord's beat and opens the chord editor. */
  onChordEditor:(target:BeatTarget)=>void;
  /** Rises each time the keyboard asks for the symbol menu of the edit target. */
  request?:number;
}
type BarHandle={bar:number;x:number;y:number;h:number;width:number};
/** Note entry on the rendered score. Present means entry mode is on: a click on a line or space of a notation staff
 * reports the beat and staff position instead of selecting, and the pointer previews the note it would write. */
export interface ScoreNoteEntry {
  /** Writes at a staff position: 0 is the bottom line, each line or space adds one. `chord` asks to keep the cursor on the beat. */
  onHit:(target:BeatTarget,step:number,options:{chord:boolean})=>void;
  /** What a click there would do, for the preview label (a pitch name, or a removal); null shows no preview. */
  describe:(target:BeatTarget,step:number)=>string|null;
}
/** The accolade marks of every system in a continuous layout, in the coordinates of alphaTab's surface. */
const accoladeOverlay=(plan:AccoladePlan,metrics:AccoladeMetrics,systems:readonly ScreenSystem[])=>systems.map(system=>accoladeSvg(systemAccoladeMarks(plan,systemTrackBands(system),metrics,staffLeftOf(system)),{left:0,top:0})).join('');
const defaultDisplay:ScoreDisplayPreferences={layout:'parchment',zoomMode:'manual'};
const defaultPage:PageLayout={widthMm:210,heightMm:297,marginsMm:{top:15,right:15,bottom:15,left:15},scale:1,profile:'document'};

export function ScoreView({score,track,zoom,profile,onSelect,playback,editorSelection=null,onEditorSelection,loop=null,projection,trackIds,visibleTracks,engraving:engravingProp,editTarget,editString,editNoteIndex,editPendingFret=null,display=defaultDisplay,page:pageInput=defaultPage,onDisplayStatus,autoFit=false,onAutoFit,errors=noErrors,barDesign=null,symbols,noteEntry=null,onSystems,onFontStatus}: {
  score:model.Score;track:number;zoom:number;profile:string;onSelect:(target:BeatTarget,string?:number,noteIndex?:number)=>void;
  playback:NativePlaybackController|null;
  editorSelection?:MusicSelection|null;onEditorSelection?:(selection:MusicSelection|null)=>void;
  /** The bars a running loop plays, drawn as a bracket over them; none, none drawn. Redrawn when the loop or the layout changes, never per playback tick. */
  loop?:LoopPassage|null;
  projection?:EngravingProjection;visibleTracks?:number[];engraving?:EngravingOverrides;
  /** The document's track identities, in track order. With `projection` they let staff groups and staff gaps be drawn; without either, neither is. */
  trackIds?:readonly string[];
  display?:ScoreDisplayPreferences;page?:PageLayout;onDisplayStatus?:(status:{zoomPercent:number;fitLimited:boolean;pageError:string|null})=>void;
  /** Nothing chose a zoom for this score (no saved default, no choice of its own): a page layout wider than the score area then fits its width, and `onAutoFit` says whether it does. Not part of the display preferences, so it is never saved. */
  autoFit?:boolean;onAutoFit?:(active:boolean)=>void;
  editTarget?:BeatTarget;editString?:number;editNoteIndex?:number|null;editPendingFret?:string|null;
  /** Measures to mark as score errors; empty when the viewer turned marking off. */
  errors?:readonly ScoreError[];
  /** Shows a handle on every bar's right edge for changing its width. Layouts that ignore widths show none. */
  barDesign?:BarDesign|null;
  /** Double-click and context-menu editing of score symbols; absent, the score only selects. */
  symbols?:SymbolEditing;
  /** Note entry on the score; absent, clicks select. */
  noteEntry?:ScoreNoteEntry|null;
  /** The rendered systems' bar intervals after each completed render in a physical page layout; null in other layouts or while no completed render exists. Not repeated for an equal value. */
  onSystems?:(systems:SystemSpan[]|null)=>void;
  /** The role fonts that could not be loaded (by file name) and the music symbols drawn from Bravura, after each render that waited for fonts. Not repeated for an equal value. */
  onFontStatus?:(status:{failed:string[];substituted:string[]})=>void;
}) {
  // System gaps and staff gaps only move the stacked blocks, so editing them must not render the notation again (as with headers): the render path sees an engraving without them.
  const renderKey=engravingRenderKey(engravingProp),gapKey=JSON.stringify(engravingProp?.systemGaps??null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const engraving=useMemo(()=>engravingProp&&withoutPageFonts(withoutStackingOffsets(engravingProp)),[renderKey]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const gaps=useMemo(()=>engravingProp?.systemGaps,[gapKey]);
  // Staff gaps recompose the held chunks in the paged memo below, so editing them does not render the notation again either.
  const staffGapKey=JSON.stringify(engravingProp?.staffGaps??null),idsKey=JSON.stringify(trackIds??null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const staffGaps=useMemo(()=>projection?resolveStaffGaps(engravingProp?.staffGaps,trackIds??[]):new Map<number,number>(),[staffGapKey,idsKey,!!projection]);
  const {t}=useI18n();
  const wrapper=useRef<HTMLDivElement>(null),container=useRef<HTMLDivElement>(null),api=useRef<AlphaTabApi|null>(null);
  const tracks=visibleTracks??[track],renderedScore=projection?.score??score,trackKey=tracks.join(',');
  // Headers and footers only print, so editing them keeps the on-screen pages as they are.
  const pageKey=JSON.stringify({...pageInput,headerFooter:undefined}),page=useMemo(()=>pageInput,[pageKey]);
  const geometry=useMemo(()=>pageGeometry(page),[page]),physicalRequested=isPhysicalPageLayout(display.layout);
  const scrollHost=useRef<HTMLElement|null>(null),[available,setAvailable]=useState({width:0,height:0});
  const [completed,setCompleted]=useState<{score:model.Score;tracks:string;page:PageLayout;engraving:EngravingOverrides|undefined;chunks:readonly ScreenRenderChunk[];bounds:ScreenBounds;plan:AccoladePlan|null;metrics:AccoladeMetrics}|null>(null);
  // A completion whose arrangement failed stays through the next render start, so the continuous fallback does not flicker.
  const failedCompletion=useRef<unknown>(null);
  const [natural,setNatural]=useState<{score:model.Score;tracks:string;layout:string;width:number;engraving:EngravingOverrides|undefined;profile:string;value:number}|null>(null);
  const validCompletion=completed?.score===renderedScore&&completed.tracks===trackKey&&completed.page===page&&completed.engraving===engraving?completed:null;
  // Paginated once, here: a completed render and a gap-only edit both come through this memo, so the notation is not rendered again for gaps.
  const paged=useMemo(()=>{
    if(!physicalRequested||!validCompletion)return null;
    try{
      // Staff gaps and group marks are composed into the held chunks first, so pagination stacks the composed heights.
      const chunks=composeScreenChunks(validCompletion.chunks,validCompletion.bounds,{plan:validCompletion.plan,gaps:staffGaps,metrics:validCompletion.metrics});
      return {pagination:paginateScreenScore(chunks,validCompletion.bounds,validCompletion.page,{gaps,systemSpacing:engraving?.systemSpacing??null,scale:validCompletion.page.scale}),error:null};
    }
    catch(error){return {pagination:null,error:error instanceof Error?error.message:'Unable to arrange this score on paper.'};}
  },[physicalRequested,validCompletion,gaps,staffGaps,engraving?.systemSpacing]);
  failedCompletion.current=paged?.error?validCompletion:null;
  const pageError=paged?.error??null,pagination=paged?.pagination??null;
  const reportSystems=useRef(onSystems),reported=useRef<string|undefined>(undefined);reportSystems.current=onSystems;
  const systems=useMemo(()=>physicalRequested&&validCompletion&&pagination?validCompletion.chunks.filter(c=>c.firstMasterBarIndex>=0).map(c=>({first:c.firstMasterBarIndex,last:c.lastMasterBarIndex})).sort((a,b)=>a.first-b.first):null,[physicalRequested,validCompletion,!!pagination]);
  // A newly attached handler gets the current value; an equal value is not reported again; unmounting reports null.
  useEffect(()=>{reported.current=undefined;},[onSystems]);
  useEffect(()=>{const key=JSON.stringify(systems);if(reported.current===key)return;reported.current=key;reportSystems.current?.(systems);},[systems,onSystems]);
  useEffect(()=>()=>{if(reported.current!==undefined&&reported.current!=='null')reportSystems.current?.(null);},[]);
  const screenLayout=display.layout==='verticalScreen'||display.layout==='horizontalScreen';
  const baseWidth=natural?.score===renderedScore&&natural.tracks===trackKey&&natural.layout===display.layout&&natural.width===available.width&&natural.engraving===engraving&&natural.profile===profile?natural.value:null;
  // Auto fit is the same fit width as the button, at the same legible floor (THE-201), but only for a page layout that is wider than its area; the screen layouts already reflow or scroll by design.
  const autoFitWas=useRef(false);
  const autoFitting=autoFit&&display.zoomMode==='manual'&&!screenLayout&&!pageError&&available.width>0&&wantsAutoFit({pageWidth:geometry.width,zoom,available:available.width,fitted:autoFitWas.current});
  autoFitWas.current=autoFitting;
  const fitMode=pageError?'manual':autoFitting?'fitWidth':display.zoomMode;
  const fitRaw=fitMode==='manual'||!available.width||(fitMode==='fitPage'&&!available.height)?{percent:zoom,limited:false}:screenLayout?
    baseWidth===null?{percent:100,limited:false}:resolveScreenZoom({zoomMode:'fitWidth',manualPercent:zoom,available:{...available,width:display.layout==='verticalScreen'?Math.min(available.width,baseWidth):available.width},natural:{width:baseWidth},minPercent:display.layout==='horizontalScreen'?tabDigitFloorPercent(engraving?typographyOf(engraving).tabScale:null):25}):
    resolveScreenZoom({zoomMode:fitMode,manualPercent:zoom,available,natural:{width:geometry.width,height:geometry.height},...autoFitting?{minPercent:tabDigitFloorPercent(engraving?typographyOf(engraving).tabScale:null)}:{}});
  // Inside the release margin the page already fits, so a held fit stays at the zoom it replaced rather than growing past it.
  const fit=autoFitting&&fitRaw.percent>zoom?{...fitRaw,percent:zoom}:fitRaw;
  const measureBase=screenLayout&&fitMode!=='manual'&&baseWidth===null;
  const factor=fit.percent/100,sourcePhysical=physicalRequested&&!pageError;
  const sourceWidth=sourcePhysical?geometry.usableWidth:display.layout==='horizontalScreen'?(baseWidth!==null?Math.max(available.width,baseWidth*factor):available.width):screenLayout?available.width:geometry.width*factor;
  const sourceScale=sourcePhysical?page.scale:screenLayout?factor:page.scale*factor;
  const arrangement=useMemo(()=>pagination?arrangeScreenPages(pagination,display.layout as 'verticalPage'|'horizontalPage'|'grid',factor,available.width):null,[pagination,display.layout,factor,available.width]);
  const [fontsReady,setFontsReady]=useState(0);
  useEffect(()=>{if(!physicalRequested)return;let live=true;loadExportFonts().then(()=>{if(live)setFontsReady(count=>count+1);},()=>{ /* The fallback face stays; the screen does not report it. */ });return()=>{live=false;};},[physicalRequested]);
  // Read from the unmemoized prop: header edits must not re-render the notation, but must redraw this text.
  const bandSet=pageInput.headerFooter,fields=useMemo(()=>headerFieldsOf(score),[score,score.title,score.subTitle,score.artist,score.album,score.words,score.music,score.copyright,score.tab,score.instructions,score.notices]),title=score.title;
  const titleScale=engraving?typographyOf(engraving).titleScale??1:1,pageCount=pagination?.pageCount??0;
  // The Page header and footer roles only draw the overlay, so they come from the prop (the render path never sees them) and
  // load their own faces; the key keeps the memos from changing on every render of an equal choice.
  const pageRoles=engravingProp?.fonts?.roles,pageFontsKey=JSON.stringify([pageRoles?.pageHeader??null,pageRoles?.pageFooter??null]);
  const pageFonts=useMemo<EngravingFonts|undefined>(()=>{
    const roles={...pageRoles?.pageHeader?{pageHeader:pageRoles.pageHeader}:{},...pageRoles?.pageFooter?{pageFooter:pageRoles.pageFooter}:{}};
    return Object.keys(roles).length?{roles}:undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[pageFontsKey]);
  const headerFont=useMemo(()=>pageRoleFont(pageFonts,'pageHeader'),[pageFonts]),footerFont=useMemo(()=>pageRoleFont(pageFonts,'pageFooter'),[pageFonts]);
  // Faces that failed to load, kept per source so the notation's and the overlay's loads report independently; the status is their union.
  const fontStatusKey=useRef(JSON.stringify({failed:[],substituted:[]})),fontStatusHandler=useRef(onFontStatus);fontStatusHandler.current=onFontStatus;
  // Notation failures cover the role faces and the music font; `substituted` is what the music font in use draws from Bravura.
  const notationFailed=useRef<string[]>([]),overlayFailed=useRef<string[]>([]),musicSubstituted=useRef<string[]>([]);
  const [musicShown,setMusicShown]=useState<MusicFontId>('bravura');
  const reportFonts=useCallback(()=>{const status={failed:[...new Set([...notationFailed.current,...overlayFailed.current])],substituted:[...musicSubstituted.current]},key=JSON.stringify(status);if(key===fontStatusKey.current)return;fontStatusKey.current=key;fontStatusHandler.current?.(status);},[]);
  useEffect(()=>{
    if(!roleFacesPending(pageFonts)){overlayFailed.current=[];reportFonts();return;}
    let live=true;
    void loadRoleFaces(pageFonts).then(({failed})=>{if(!live)return;overlayFailed.current=failed;setFontsReady(count=>count+1);reportFonts();});
    return()=>{live=false;};
  },[pageFonts,reportFonts]);
  const pageTexts=useMemo(()=>{
    if(!pageCount)return [];
    const {headerY,footerY}=screenPageBaselines(geometry,headerScaleOf(titleScale,headerFont));
    return Array.from({length:pageCount},(_,index)=>{const {header,footer}=pageTextItems({geometry,bands:bandSet?(index===0?bandSet.first:bandSet.other):null,title,fields,page:index+1,pages:pageCount,titleScale,headerY,footerY,headerFont,footerFont});return [...header,...footer];});
    // fontsReady re-measures once the page font or a role face has loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[bandSet,fields,title,geometry,titleScale,headerFont,footerFont,pageCount,fontsReady]);
  const roots=useRef(new Map<string,HTMLElement>()),barElement=useRef<HTMLSpanElement>(null),beatElement=useRef<HTMLSpanElement>(null);
  const presentation=useRef<ScreenPlaybackContext>({renderedScore,wrapper:null,scrollHost:null,physical:null,barElement:null,beatElement:null});
  presentation.current={renderedScore,wrapper:wrapper.current,scrollHost:scrollHost.current,physical:pagination&&arrangement?{pagination,arrangement,roots:roots.current}:null,barElement:barElement.current,beatElement:beatElement.current};
  const playbackPresentation=useRef<ReturnType<typeof installScreenPlayback>|null>(null);
  const layoutCurrent=useRef({renderedScore,trackKey,page,engraving,profile,display,available,sourcePhysical,baseWidth});layoutCurrent.current={renderedScore,trackKey,page,engraving,profile,display,available,sourcePhysical,baseWidth};
  const pointerActions=useRef({downBeat:(_beat:model.Beat)=>{},downNote:(_note:model.Note)=>{},move:(_beat:model.Beat)=>{}});
  // What the last render pass was configured with (the accolade plan and the pixel metrics after scale and padding were set), and the marks drawn over a continuous layout.
  const accolade=useRef<{plan:AccoladePlan|null;metrics:AccoladeMetrics}|null>(null),[overlay,setOverlay]=useState<string|null>(null);
  const [rangeBlocks,setRangeBlocks]=useState<Band[]>([]),[loopBlocks,setLoopBlocks]=useState<Band[]>([]),[surfaceClass,setSurfaceClass]=useState('');
  useLayoutEffect(()=>{
    const host=wrapper.current?.closest<HTMLElement>('.paper-scroll')??wrapper.current?.parentElement??null;scrollHost.current=host;
    const measure=()=>{if(!host)return;const css=getComputedStyle(host),width=Math.max(0,host.clientWidth-(parseFloat(css.paddingLeft)||0)-(parseFloat(css.paddingRight)||0)),height=Math.max(0,host.clientHeight-(parseFloat(css.paddingTop)||0)-(parseFloat(css.paddingBottom)||0));setAvailable(old=>old.width===width&&old.height===height?old:{width,height});};
    measure();const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(measure);if(host)observer?.observe(host);window.addEventListener('resize',measure);
    return()=>{observer?.disconnect();window.removeEventListener('resize',measure);};
  },[]);
  useEffect(()=>{
    const host=scrollHost.current;
    if(!host||display.layout!=='horizontalScreen')return;
    const onWheel=(event:WheelEvent)=>{
      if(event.defaultPrevented||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey)return;
      if(event.deltaY===0||Math.abs(event.deltaY)<Math.abs(event.deltaX))return;
      const maxLeft=host.scrollWidth-host.clientWidth;
      if(host.scrollHeight>host.clientHeight)return;
      if(event.deltaY<0?host.scrollLeft<=0:host.scrollLeft>=maxLeft)return;
      for(let node=event.target instanceof Element?event.target:null;node&&node!==host;node=node.parentElement){
        if(node.matches('textarea,select,[data-wheel-native]'))return;
        const overflowY=getComputedStyle(node).overflowY;
        if((overflowY==='auto'||overflowY==='scroll')&&node.scrollHeight>node.clientHeight)return;
      }
      const unit=event.deltaMode===1?16:event.deltaMode===2?host.clientWidth:1;
      event.preventDefault();
      host.scrollLeft+=event.deltaY*unit;
    };
    host.addEventListener('wheel',onWheel,{passive:false});
    return()=>host.removeEventListener('wheel',onWheel);
  },[display.layout]);
  useEffect(()=>{onDisplayStatus?.({zoomPercent:fit.percent,fitLimited:fit.limited,pageError});},[onDisplayStatus,fit.percent,fit.limited,pageError]);
  useEffect(()=>{onAutoFit?.(autoFitting);},[onAutoFit,autoFitting]);
  // Horizontal screen only: entering fit mode (or arriving in it from another layout) starts the strip at bar 1, so a scroll offset left over from manual zoom cannot keep a phantom range.
  const prevFit=useRef({mode:fitMode,layout:display.layout});
  useLayoutEffect(()=>{
    const host=scrollHost.current,prev=prevFit.current;
    if(display.layout==='horizontalScreen'&&fitMode!=='manual'&&host&&(prev.mode==='manual'||prev.layout!==display.layout))host.scrollLeft=0;
    prevFit.current={mode:fitMode,layout:display.layout};
  },[fitMode,display.layout]);
  const current=useRef({score,track,onSelect,editorSelection,onEditorSelection,projection,tracks,editTarget,editString,editNoteIndex,errors,loop});current.current={score,track,onSelect,editorSelection,onEditorSelection,projection,tracks,editTarget,editString,editNoteIndex,errors,loop};
  const modifiers=useRef({shift:false,toggle:false,detail:0}),anchor=useRef<BeatTarget|null>(null),drag=useRef<Drag|null>(null);
  const [markers,setMarkers]=useState<Marker[]>([]),[handles,setHandles]=useState<Handles|null>(null);
  const [caret,setCaret]=useState<(Marker&{entry:boolean})|null>(null),caretElement=useRef<HTMLSpanElement>(null),revealCaret=useRef(false),rendering=useRef(false);
  const refresh=useRef(()=>{}),refreshCaret=useRef(()=>{}),refreshErrors=useRef(()=>{}),refreshLoop=useRef(()=>{});
  const [errorBlocks,setErrorBlocks]=useState<(Marker&{label:string})[]>([]);
  const refreshDesign=useRef(()=>{}),[barHandles,setBarHandles]=useState<BarHandle[]>([]),[barDrag,setBarDrag]=useState<{bar:number;delta:number}|null>(null),designing=useRef<BarDesign|null>(null);
  const handleRefs=useRef(new Map<number,HTMLElement>()),[activeBar,setActiveBar]=useState<number|null>(null),restoreBar=useRef<number|null>(null),heldBar=useRef<number|null>(null),dragging=useRef<{bar:number;pointer:number;startX:number;start:number;width:number;delta:number;element:HTMLElement}|null>(null);
  const refreshDiagrams=useRef(()=>{}),[diagramBlocks,setDiagramBlocks]=useState<Array<{x:number;y:number;w:number;diagram:ScaleDiagram}>>([]),[openDiagram,setOpenDiagram]=useState<number|null>(null);
  const editBeat=editTarget?score.tracks[editTarget.track]?.staves[editTarget.staff]?.bars[editTarget.bar]?.voices[editTarget.voice]?.beats[editTarget.beat]:undefined;
  const editLocation=editBeat&&editTarget?`Editing ${score.tracks[editTarget.track].name || `track ${editTarget.track+1}`}, measure ${editTarget.bar+1}, beat ${editTarget.beat+1}, voice ${editTarget.voice+1}${editBeat.isEmpty?', empty':editBeat.isRest?', rest':''}${editNoteIndex!=null?`, note ${editNoteIndex+1}`:editString?`, string ${editString}`:''}`:'';
  const canonicalBeat=(beat:model.Beat)=>{
    const value=current.current,pair=value.projection?.beats.get(beat.id),source=value.projection?(pair?.rendered===beat?pair.source:null):beat;
    return source?.voice.bar.staff.track.score===value.score&&value.tracks.includes(source.voice.bar.staff.track.index)?source:null;
  };
  const canonicalNote=(note:model.Note)=>{
    const value=current.current,pair=value.projection?.notes.get(note.id),source=value.projection?(pair?.rendered===note?pair.source:null):note;
    return source&&canonicalBeat(note.beat)&&source.beat.voice.bar.staff.track.score===value.score?source:null;
  };
  const renderedBeat=(beat:model.Beat)=>{
    const value=current.current,pair=value.projection?.beats.get(beat.id);
    return value.projection?(pair?.source===beat?pair.rendered:null):beat;
  };
  const renderedNote=(note:model.Note)=>{
    const value=current.current,pair=value.projection?.notes.get(note.id);
    return value.projection?(pair?.source===note?pair.rendered:null):note;
  };
  const clearHighlight=(view:AlphaTabApi)=>{
    const value=current.current,source=value.score.tracks[value.tracks.includes(value.track)?value.track:value.tracks[0]]?.staves[0]?.bars[0]?.voices[0]?.beats[0],first=source?renderedBeat(source):null;
    // Clearing drawing alone retains alphaTab's endpoints across renders. An
    // equal-beat range safely resets them without changing the playback loop.
    if(first)view.highlightPlaybackRange(first,first);
    view.clearPlaybackRangeHighlight();
  };
  const offset=()=>{
    const view=api.current,root=wrapper.current;if(!view||!root)return {x:0,y:0};
    const canvas=view.uiFacade.getOffset(null,view.canvasElement),bounds=root.getBoundingClientRect();
    return {x:canvas.x-bounds.left-window.scrollX,y:canvas.y-bounds.top-window.scrollY};
  };
  const mapped=(box:ScreenRect,system?:ScreenSystem|null):Marker|null=>{
    const physical=presentation.current.physical;
    if(physical)return system?mapScreenRect(physical.pagination,physical.arrangement,system,box):null;
    if(layoutCurrent.current.sourcePhysical)return null;
    const delta=offset();return {...box,x:delta.x+box.x,y:delta.y+box.y};
  };
  const beatSystem=(beat:model.Beat)=>api.current?.boundsLookup?.findBeats(beat)?.find(bound=>bound.beat===beat)?.barBounds?.masterBarBounds?.staffSystemBounds;
  /** The notation-staff position under a client point: the source beat, the step, and the preview box in overlay space. */
  const entryHitAt=(clientX:number,clientY:number):{target:BeatTarget;step:number;ghost:Marker}|null=>{
    const view=api.current,root=wrapper.current,layout=view?entryLayoutOf(view.renderer):null;if(!view||!root||!layout||rendering.current)return null;
    const physical=presentation.current.physical;let masters:readonly MasterBarBox[],point:{x:number;y:number},system:ScreenSystem|null=null;
    if(physical){const rect=root.getBoundingClientRect(),source=unmapScreenPoint(physical.pagination,physical.arrangement,{x:clientX-rect.left,y:clientY-rect.top});if(!source)return null;system=source.system;masters=source.system.bars as unknown as MasterBarBox[];point=source.point;}
    else{if(layoutCurrent.current.sourcePhysical||!view.boundsLookup)return null;const canvas=view.uiFacade.getOffset(null,view.canvasElement);masters=view.boundsLookup.staffSystems.flatMap(item=>item.bars) as unknown as MasterBarBox[];point={x:clientX+window.scrollX-canvas.x,y:clientY+window.scrollY-canvas.y};}
    const hit=scoreEntryHit(layout,masters,point,{scale:view.settings.display.scale,voice:current.current.editTarget?.voice??0}),source=hit?canonicalBeat(hit.beat):null;
    if(!hit||!source)return null;
    const ghost=mapped({x:hit.at.x-hit.half*1.3,y:hit.at.y-hit.half,w:hit.half*2.6,h:hit.half*2},system);
    return ghost?{target:address(source),step:hit.step,ghost}:null;
  };
  const entering=useRef<ScoreNoteEntry|null>(null);entering.current=noteEntry;
  const [ghost,setGhost]=useState<(Marker&{label:string})|null>(null);
  useEffect(()=>{if(!noteEntry)setGhost(null);},[!!noteEntry]);
  const previewEntry=(event:ReactMouseEvent)=>{
    const entry=entering.current;if(!entry||event.buttons!==0){setGhost(old=>old&&null);return;}
    const hit=entryHitAt(event.clientX,event.clientY),label=hit?entry.describe(hit.target,hit.step):null;
    const next=hit&&label?{...hit.ghost,label}:null;
    // Most moves stay on the same line or space: keep the ghost, and the render, as they are.
    setGhost(old=>old===next||old&&next&&old.label===next.label&&old.x===next.x&&old.y===next.y&&old.w===next.w&&old.h===next.h?old:next);
  };
  refreshCaret.current=()=>{
    const value=current.current,point=value.editTarget,view=api.current;
    const source=point&&value.tracks.includes(point.track)?value.score.tracks[point.track]?.staves[point.staff]?.bars[point.bar]?.voices[point.voice]?.beats[point.beat]:null;
    const beat=source?renderedBeat(source):null;
    if(!view||!source||!beat||rendering.current){setCaret(null);return;}
    const bounds=(view.boundsLookup?.findBeats(beat)??[]).filter(bound=>bound.beat===beat);
    const sourceNote=value.editNoteIndex!=null?source.notes[value.editNoteIndex]:source.notes.find(note=>note.string===value.editString),note=sourceNote?renderedNote(sourceNote):null;
    const noteBounds=note?bounds.flatMap(bound=>bound.notes??[]).find(bound=>bound.note===note)?.noteHeadBounds:null;
    const box=noteBounds??bounds[0]?.realBounds;
    if(!box||![box.x,box.y,box.w,box.h].every(Number.isFinite)||box.w<=0||box.h<=0){setCaret(null);return;}
    const rect=mapped(box,beatSystem(beat));setCaret(rect?{x:rect.x-3,y:rect.y-3,w:rect.w+6,h:rect.h+6,entry:!noteBounds}:null);
  };
  /** Shades each error measure of every shown track once, across its notation and tab lines, wherever the renderer placed it. */
  refreshErrors.current=()=>{
    const value=current.current,view=api.current;
    if(!view||rendering.current||!value.errors.length){setErrorBlocks([]);return;}
    const measures=new Map<string,ScoreError[]>();
    for(const error of value.errors)if(value.tracks.includes(error.track)){const key=`${error.track}/${error.staff}/${error.bar}`;measures.set(key,[...measures.get(key)??[],error]);}
    setErrorBlocks([...measures.values()].flatMap(group=>{
      const {track,staff,bar:index,voice}=group[0],source=value.score.tracks[track]?.staves[staff]?.bars[index]?.voices[voice]?.beats[0],beat=source?renderedBeat(source):null;
      const bounds=beat?(view.boundsLookup?.findBeats(beat)??[]).filter(bound=>bound.beat===beat&&bound.barBounds):[];
      const system=bounds[0]?.barBounds.masterBarBounds?.staffSystemBounds,boxes=bounds.filter(bound=>bound.barBounds.masterBarBounds?.staffSystemBounds===system).map(bound=>bound.barBounds.realBounds);
      if(!boxes.length)return [];
      const left=Math.min(...boxes.map(box=>box.x)),top=Math.min(...boxes.map(box=>box.y));
      const rect=mapped({x:left,y:top,w:Math.max(...boxes.map(box=>box.x+box.w))-left,h:Math.max(...boxes.map(box=>box.y+box.h))-top},system);
      return rect&&[rect.x,rect.y,rect.w,rect.h].every(Number.isFinite)?[{...rect,label:`Score error: ${group.map(describeScoreError).join('; ')}`}]:[];
    }));
  };
  /** Puts a width handle on the right edge of each master bar the renderer placed, in the layouts that size bars by weight. */
  refreshDesign.current=()=>{
    const view=api.current,layout=layoutCurrent.current.display.layout;
    if(!designing.current||layout==='verticalScreen'||layout==='horizontalScreen'){setBarHandles([]);return;}
    // A render in progress keeps the handles where they were: removing them would drop the keyboard focus of the one just used.
    if(!view||rendering.current)return;
    // Between a page edit and its new pagination there is nothing to place the handles on; they stay where they were rather than being rebuilt (and losing focus).
    if(layoutCurrent.current.sourcePhysical&&!presentation.current.physical)return;
    setBarHandles((view.boundsLookup?.staffSystems??[]).flatMap(system=>system.bars.flatMap(bar=>{
      const rect=mapped(bar.realBounds,system);
      return rect&&[rect.x,rect.y,rect.w,rect.h].every(Number.isFinite)&&rect.w>0&&rect.h>0?[{bar:bar.index,x:rect.x+rect.w,y:rect.y,h:rect.h,width:rect.w}]:[];
    })));
  };
  /** Anchors each shown track's scale diagrams above the staff at their beat, wherever the renderer placed it. */
  refreshDiagrams.current=()=>{
    const value=current.current,view=api.current;
    if(!view||rendering.current){setDiagramBlocks([]);return;}
    const found=listScaleDiagrams(value.score).flatMap(({target,diagram})=>{
      if(!value.tracks.includes(target.track))return [];
      const source=value.score.tracks[target.track]?.staves[target.staff]?.bars[target.bar]?.voices[target.voice]?.beats[target.beat],beat=source?renderedBeat(source):null;
      const bound=beat?(view.boundsLookup?.findBeats(beat)??[]).find(item=>item.beat===beat):null;
      if(!beat||!bound)return [];
      const box=bound.realBounds,rect=mapped(beatSpanOf(bound),beatSystem(beat));
      if(!rect||![rect.x,rect.y].every(Number.isFinite))return [];
      return [{x:Math.max(0,rect.x),y:Math.max(0,rect.y-chipHeight-chipGap),w:chipWidth(diagram),diagram}];
    });
    // Chips on one row are packed left to right, so a later one never covers an earlier one.
    const ends=new Map<number,number>();
    setDiagramBlocks(found.sort((p,q)=>p.y-q.y||p.x-q.x).map(block=>{
      const x=Math.max(block.x,(ends.get(block.y)??-Infinity)+chipGap);ends.set(block.y,x+block.w);return {...block,x};
    }));
  };
  /** Bands over passage bars (one per system and run of bars) in the renderer's own bounds, mapped like every other overlay in this view: live layouts by the canvas offset, page layouts by the page arrangement. */
  const bandsOf=(bars:readonly PassageBar[]):Band[]=>{
    const lookup=api.current?.boundsLookup;if(!lookup||rendering.current)return [];
    return passageBands(lookup,bars).flatMap(band=>{const rect=mapped({x:band.x,y:band.y,w:band.w,h:band.h},band.system);return rect&&[rect.x,rect.y,rect.w,rect.h].every(Number.isFinite)&&rect.w>0&&rect.h>0?[{...rect,before:band.continuesBefore||undefined,after:band.continuesAfter||undefined}]:[];});
  };
  /** The selected passage, rendered beats `first` to `last`: whole bars between, the edge beats at its ends. */
  const selectionBands=(first:model.Beat,last:model.Beat):Band[]=>{
    const a=first.voice.bar.index,b=last.voice.bar.index;
    return bandsOf(Array.from({length:Math.max(0,b-a+1)},(_,i)=>({bar:a+i,...(i===0?{from:first}:{}),...(i===b-a?{to:last}:{})})));
  };
  const placeHandles=(event:PlaybackHighlightChangeEventArgs)=>{
    setRangeBlocks([]);
    if(rendering.current||!event.startBeat||!event.endBeat||!event.startBeatBounds||!event.endBeatBounds){setHandles(null);return;}
    const first=canonicalBeat(event.startBeat),last=canonicalBeat(event.endBeat);
    if(!first||!last||event.startBeatBounds.beat!==event.startBeat||event.endBeatBounds.beat!==event.endBeat){setHandles(null);return;}
    if(presentation.current.physical&&(!(api.current?.boundsLookup?.findBeats(event.startBeat)??[]).includes(event.startBeatBounds)||!(api.current?.boundsLookup?.findBeats(event.endBeat)??[]).includes(event.endBeatBounds))){setHandles(null);return;}
    const start=mapped(event.startBeatBounds.realBounds,beatSystem(event.startBeat)),end=mapped(event.endBeatBounds.realBounds,beatSystem(event.endBeat));
    setHandles(start&&end?{start:{...start,target:address(first)},end:{...end,x:end.x+end.w,target:address(last)}}:null);
    setRangeBlocks(selectionBands(event.startBeat,event.endBeat));
  };
  /** The bracket over the bars a running loop plays. Where the loop begins or ends inside a bar its edge falls on the beat the plan reaches there; without a plan row to say, it takes the whole bar. */
  refreshLoop.current=()=>{
    const value=current.current,view=api.current,passage=value.loop;
    if(!view||rendering.current||!passage){setLoopBlocks(old=>old.length?[]:old);return;}
    const rows=playback?.scheduledNotes('').beats??[],occurrences=playback?.playbackOccurrences()??[];
    const edge=(bar:LoopBar,tick:number,ending:boolean):model.Beat|null=>{
      if(ending?tick>=bar.length:tick<=0)return null;
      const found=rows.filter(row=>row.target.bar===bar.bar&&row.target.track===value.track),lane=found[0]?.target;
      const timed=found.filter(row=>row.target.staff===lane!.staff&&row.target.voice===lane!.voice).flatMap(row=>{
        const o=occurrences.find(candidate=>candidate.bar===bar.bar&&candidate.occurrence===row.occurrence);return o?[{row,from:row.startTick-o.startTick,to:row.endTick-o.startTick}]:[];
      }).sort((a,b)=>a.from-b.from);
      // The loop starts at the first beat still sounding at its start tick, and ends with the last beat that began before its end tick.
      const hit=ending?[...timed].reverse().find(item=>item.from<tick):timed.find(item=>item.to>tick);
      const target=hit?.row.target,source=target?value.score.tracks[target.track]?.staves[target.staff]?.bars[target.bar]?.voices[target.voice]?.beats[target.beat]:undefined;
      return source?renderedBeat(source):null;
    };
    setLoopBlocks(bandsOf(passage.bars.map(bar=>({bar:bar.bar,from:edge(bar,bar.from,false),to:edge(bar,bar.to,true)}))));
  };
  refresh.current=()=>{
    const view=api.current;if(!view)return;const selected=current.current.editorSelection;
    setMarkers([]);setHandles(null);setRangeBlocks([]);
    if(!selected){clearHighlight(view);return;}
    try {
      if(selected.kind==='notes'){
        clearHighlight(view);
        setMarkers(resolveSelectionNotes(current.current.score,selected).filter(note=>current.current.tracks.includes(note.beat.voice.bar.staff.track.index)).flatMap(source=>{const note=renderedNote(source);return note?(view.boundsLookup?.findBeats(note.beat)??[]).filter(bounds=>bounds.beat===note.beat).flatMap(bounds=>(bounds.notes??[]).filter(bound=>bound.note===note).flatMap(bound=>{const rect=mapped(bound.noteHeadBounds,bounds.barBounds?.masterBarBounds?.staffSystemBounds);return rect?[rect]:[];})):[];}));return;
      }
      const beats=resolveSelectionBeats(current.current.score,selected).filter(beat=>current.current.tracks.includes(beat.voice.bar.staff.track.index)).sort((a,b)=>a.voice.bar.index-b.voice.bar.index||a.displayStart-b.displayStart||a.voice.bar.staff.track.index-b.voice.bar.staff.track.index||a.voice.bar.staff.index-b.voice.bar.staff.index||a.voice.index-b.voice.index||a.index-b.index);
      if(!beats.length){clearHighlight(view);return;}
      const source=beats.find(beat=>beat.voice.bar.staff.track.index===current.current.track)??beats[0],lane=address(source),laneBeats=beats.filter(beat=>sameLane(address(beat),lane)),first=renderedBeat(laneBeats[0]),last=renderedBeat(laneBeats[laneBeats.length-1]);
      if(!first||!last){clearHighlight(view);return;}
      const startBeatBounds=view.boundsLookup?.findBeat(first),endBeatBounds=view.boundsLookup?.findBeat(last);
      if(startBeatBounds?.beat!==first||endBeatBounds?.beat!==last){clearHighlight(view);return;}
      view.highlightPlaybackRange(first,last);
      if(first===last){const rect=mapped(beatSpanOf(startBeatBounds),beatSystem(first));setMarkers(rect?[rect]:[]);if(selected.kind==='bars')setRangeBlocks(selectionBands(first,last));}else if(!presentation.current.physical)placeHandles({startBeat:first,endBeat:last,startBeatBounds,endBeatBounds});
    } catch {clearHighlight(view);}
  };
  useEffect(()=>{
    const view=new AlphaTabApi(container.current!,{core:{fontDirectory:'/font/',scriptFile:'/alphatab/alphaTab.mjs',includeNoteBounds:true,useWorkers:false,engine:'svg',enableLazyLoading:false},player:{playerMode:'EnabledExternalMedia',enableCursor:false,enableUserInteraction:false,scrollElement:'.paper-scroll'}});api.current=view;
    const adapter=installScreenPlayback(view,()=>({...presentation.current,wrapper:wrapper.current,scrollHost:scrollHost.current,barElement:barElement.current,beatElement:beatElement.current}));playbackPresentation.current=adapter;
    view.settings.player.enableCursor=true;
    // Reuse the facade's public DOM surface classes so its instance-specific font CSS also applies to copied SVGs.
    setSurfaceClass(container.current?.querySelector('.at-surface')?.className??'');
    let chunks:ScreenRenderChunk[]=[],collecting=false,generation:typeof layoutCurrent.current|null=null,planned:{plan:AccoladePlan|null;metrics:AccoladeMetrics}|null=null;
    const publish=(next:MusicSelection|null)=>{current.current.editorSelection=next;current.current.onEditorSelection?.(next);};
    const chooseRange=(from:BeatTarget,to:BeatTarget,lanes:VoiceAddress[])=>{try{publish({kind:'range',range:rangeFromBeats(current.current.score,from,to,lanes)});}catch{return false;}return true;};
    const move=(beat:model.Beat)=>{
      const active=drag.current,source=canonicalBeat(beat);if(!active||!source)return;const to=address(source);if(!sameLane(active.anchor,to)||sameBeat(active.last,to))return;
      if(active.bars){publish(selectionForBars(current.current.score,active.bars.tracks,Math.min(active.anchor.bar,to.bar),Math.max(active.anchor.bar,to.bar)));active.last=to;}
      else if(chooseRange(active.anchor,to,active.lanes))active.last=to;
    };
    const downBeat=(beat:model.Beat)=>{
      const source=canonicalBeat(beat);if(!source)return;
      const point=address(source);current.current.onSelect(point,undefined,undefined);if(!current.current.onEditorSelection)return;
      if(modifiers.current.detail===3){anchor.current=point;drag.current=null;publish(selectionForTrack(current.current.score,point.track));return;}
      if(modifiers.current.toggle)return;
      if(modifiers.current.shift&&!anchor.current&&current.current.editorSelection){try{const first=resolveSelectionBeats(current.current.score,current.current.editorSelection).find(item=>sameLane(address(item),point));if(first)anchor.current=address(first);}catch{ /* A replaced document can invalidate an old indexed selection. */ }}
      const from=modifiers.current.shift&&anchor.current&&sameLane(anchor.current,point)?anchor.current:point;
      anchor.current=from;const lanes=[{track:point.track,staff:point.staff,voice:point.voice}];
      drag.current={anchor:from,last:point,lanes};
      if(!chooseRange(from,point,lanes))publish(selectionForBars(current.current.score,[point.track],point.bar,point.bar));
    };
    const downNote=(note:model.Note)=>{
      const source=canonicalNote(note);if(!source)return;
      const point=address(source.beat);current.current.onSelect(point,source.string,source.index);
      if(!current.current.onEditorSelection||!modifiers.current.toggle||modifiers.current.detail===3)return;
      let notes:model.Note[]=[];try{if(current.current.editorSelection)notes=resolveSelectionNotes(current.current.score,current.current.editorSelection);}catch{ /* A replaced document can invalidate an old indexed selection. */ }
      const selected=notes.map(item=>({target:address(item.beat),noteIndex:item.index})),index=selected.findIndex(item=>sameBeat(item.target,point)&&item.noteIndex===source.index);
      if(index>=0)selected.splice(index,1);else selected.push({target:point,noteIndex:source.index});anchor.current=point;drag.current=null;publish(selected.length?{kind:'notes',notes:selected}:null);
    };
    pointerActions.current={downBeat,downNote,move};
    const subscriptions=[view.beatMouseDown.on(downBeat),view.noteMouseDown.on(downNote),view.beatMouseMove.on(move),view.beatMouseUp.on(()=>{drag.current=null;}),view.renderStarted.on(()=>{
      collecting=true;chunks=[];generation=layoutCurrent.current;planned=accolade.current??{plan:null,metrics:accoladeMetrics(view.settings)};rendering.current=true;setOverlay(null);setCompleted(previous=>previous&&previous===failedCompletion.current?previous:null);setCaret(null);setMarkers([]);setHandles(null);setRangeBlocks([]);setLoopBlocks([]);setErrorBlocks([]);setDiagramBlocks([]);setOpenDiagram(null);adapter.renderStarted();
    }),view.renderer.partialRenderFinished.on(event=>{
      if(collecting&&typeof event.renderResult==='string')chunks.push({id:event.id,x:event.x,y:event.y,width:event.width,height:event.height,firstMasterBarIndex:event.firstMasterBarIndex,lastMasterBarIndex:event.lastMasterBarIndex,svg:event.renderResult});
    }),view.postRenderFinished.on(()=>{
      collecting=false;const c=generation,latest=layoutCurrent.current;rendering.current=false;adapter.renderCompleted();
      if(c&&c.renderedScore===latest.renderedScore&&c.trackKey===latest.trackKey&&c.page===latest.page&&c.engraving===latest.engraving&&c.sourcePhysical===latest.sourcePhysical&&view.score===c.renderedScore&&view.boundsLookup){
        if(c.sourcePhysical){if(planned)setCompleted({score:c.renderedScore,tracks:c.trackKey,page:c.page,engraving:c.engraving,chunks:[...chunks],bounds:view.boundsLookup,plan:planned.plan,metrics:planned.metrics});}
        else if(planned?.plan){try{setOverlay(accoladeOverlay(planned.plan,planned.metrics,view.boundsLookup.staffSystems));}catch{setOverlay(null);}}
        if((c.display.layout==='verticalScreen'||c.display.layout==='horizontalScreen')&&c.display.zoomMode!=='manual'&&c.baseWidth===null){
          const width=Math.max(1,...chunks.map(chunk=>chunk.x+chunk.width),...view.boundsLookup.staffSystems.map(system=>system.realBounds.x+system.realBounds.w));
          setNatural({score:c.renderedScore,tracks:c.trackKey,layout:c.display.layout,width:c.available.width,engraving:c.engraving,profile:c.profile,value:width});
        }
      }
      refresh.current();refreshCaret.current();refreshErrors.current();refreshLoop.current();refreshDiagrams.current();refreshDesign.current();
    }),view.playbackRangeHighlightChanged.on(event=>{if(current.current.editorSelection&&current.current.editorSelection.kind!=='notes')placeHandles(event);})];
    const mouseMove=(event:MouseEvent)=>{
      if(!drag.current)return;const physical=presentation.current.physical;if(physical&&wrapper.current){const rect=wrapper.current.getBoundingClientRect(),hit=hitTestScreenPages(physical.pagination,physical.arrangement,{x:event.clientX-rect.left,y:event.clientY-rect.top},current.current.editTarget);if(hit)move(hit.beat);return;}if(layoutCurrent.current.sourcePhysical)return;const bounds=view.uiFacade.getOffset(null,view.canvasElement),beat=view.boundsLookup?.getBeatAtPos(event.clientX+window.scrollX-bounds.x,event.clientY+window.scrollY-bounds.y);if(beat)move(beat);
    };
    const mouseUp=()=>{drag.current=null;};document.addEventListener('mousemove',mouseMove);document.addEventListener('mouseup',mouseUp);
    return ()=>{for(const dispose of subscriptions)dispose();document.removeEventListener('mousemove',mouseMove);document.removeEventListener('mouseup',mouseUp);adapter.dispose();playbackPresentation.current=null;roots.current.clear();view.destroy();api.current=null;loaded.current=null;};
  },[]);
  useEffect(()=>{anchor.current=null;drag.current=null;},[score,track,projection,visibleTracks]);
  useEffect(()=>{if(!editorSelection)anchor.current=null;refresh.current();},[editorSelection,score,track,zoom,profile,projection,visibleTracks]);
  useEffect(()=>{revealCaret.current=true;},[score,editTarget?.track,editTarget?.staff,editTarget?.bar,editTarget?.voice,editTarget?.beat,editString,editNoteIndex]);
  useEffect(()=>{refreshCaret.current();},[score,track,zoom,profile,projection,visibleTracks,editTarget?.track,editTarget?.staff,editTarget?.bar,editTarget?.voice,editTarget?.beat,editString,editNoteIndex]);
  useEffect(()=>{if(caret&&revealCaret.current&&caretElement.current){const host=scrollHost.current;if(host){const box=caretElement.current.getBoundingClientRect(),viewport=host.getBoundingClientRect();if(box.top<viewport.top)host.scrollTop+=box.top-viewport.top;else if(box.bottom>viewport.bottom)host.scrollTop+=box.bottom-viewport.bottom;if(box.left<viewport.left)host.scrollLeft+=box.left-viewport.left;else if(box.right>viewport.right)host.scrollLeft+=box.right-viewport.right;}revealCaret.current=false;}},[caret]);
  useEffect(()=>{if(playback&&api.current)playback.attachView(api.current);},[playback]);
  const loaded=useRef<{score:model.Score;tracks:string}|null>(null);
  // Counts render requests that were superseded or abandoned: a font load that finishes under an older count paints nothing.
  const [drawFailure,setDrawFailure]=useState<{error:unknown}|null>(null);
  const renderGeneration=useRef(0);
  useEffect(()=>{
    const view=api.current!;if(sourceWidth<=0)return;
    // `music` is the font the layout is drawn with: the chosen font's loaded data, or Bravura's (also when the chosen font failed to load).
    const draw=(music:MusicFontData,drawn=engraving)=>{
      view.settings.display.scale=sourceScale;applyEffectBandSpacing(view.settings);
      setMusicShown(music.id);musicSubstituted.current=music.substituted;
      if(drawn)configureEngraving(view.settings,drawn,music);
      // Without an engraving nothing runs configureEngraving, so a previous music font's metrics would stay: restore Bravura's.
      else{view.settings.display.resources.engravingSettings=EngravingSettings.bravuraDefaults;view.settings.display.staveProfile=StaveProfile[profile as keyof typeof StaveProfile] as StaveProfile;}
      view.settings.display.layoutMode=display.layout==='horizontalScreen'?LayoutMode.Horizontal:display.layout==='verticalScreen'?LayoutMode.Page:LayoutMode.Parchment;
      view.settings.display.systemsLayoutMode=display.layout==='verticalScreen'?SystemsLayoutMode.Automatic:SystemsLayoutMode.UseModelLayout;
      view.settings.display.padding=sourcePhysical||screenLayout?[0,0,0,0]:[geometry.left*factor,geometry.top*factor,geometry.right*factor,geometry.bottom*factor];
      // Groups switch alphaTab's brackets off and reserve room beside the staves; written as absolute values after padding, scale and the music font, on every pass.
      let plan:AccoladePlan|null=null;
      if(projection&&trackIds){
        // A failure while planning or configuring falls back to alphaTab's own brackets and no overlay, rather than crashing the subtree.
        try{
          if(drawn)plan=planAccolades({engraving:drawn,trackIds,rendered:tracks,score:projection.score,nativeMode:projection.bracketMode,settings:view.settings});
          configureAccolades(view.settings,projection.score,plan,projection.bracketMode);
        }catch{
          plan=null;
          try{configureAccolades(view.settings,projection.score,null,projection.bracketMode);}catch{/* nothing more can be undone */}
        }
      }
      view.renderer.width=sourceWidth;view.updateSettings();
      accolade.current={plan,metrics:accoladeMetrics(view.settings)};
      const old=loaded.current;
      if(!old||old.score!==renderedScore||old.tracks!==trackKey){loaded.current={score:renderedScore,tracks:trackKey};if(playback)playback.setRenderedScore(renderedScore,tracks);else view.renderScore(renderedScore,tracks);}
      else view.render();
    };
    // alphaTab caches a text width table per font family, so a role face has to be in before the first render that uses it, and the music font's
    // metadata before the layout that uses it. One gate covers both. Nothing to load (every Bravura document without role fonts, and a music font
    // that is already loaded) keeps the render synchronous.
    const fonts=engraving?.fonts,musicId=fonts?.music??'bravura',loadedMusic=loadedMusicFont(musicId);
    if(!roleFacesPending(fonts)&&loadedMusic){draw(loadedMusic);notationFailed.current=[];reportFonts();return;}
    const generation=renderGeneration.current;
    const roles=roleFacesPending(fonts)?loadRoleFaces(fonts):Promise.resolve({failed:[] as string[]});
    // A music font that cannot be loaded is not fatal: the score is drawn with Bravura and the failure is reported; the next change tries again.
    const music=loadedMusic?Promise.resolve({data:loadedMusic}):loadMusicFont(musicId).then(data=>({data}),()=>({data:null}));
    void Promise.all([roles,music]).then(([{failed},{data}])=>{
      if(generation!==renderGeneration.current)return;
      notationFailed.current=data?failed:[...failed,musicFonts[musicId].file];
      setFontsReady(count=>count+1);
      // A synchronous draw that throws reaches the error boundary from the effect; here it is kept and thrown while rendering instead of becoming an unhandled rejection.
      try{if(data)draw(data);else draw(loadedMusicFont('bravura')!,engraving&&withoutMusicFont(engraving));}catch(error){setDrawFailure({error});}
      reportFonts();
    });
    return()=>{renderGeneration.current++;};
  },[renderedScore,trackKey,playback,sourceWidth,sourceScale,sourcePhysical,measureBase,screenLayout,display.layout==='verticalScreen',display.layout==='horizontalScreen',engraving,profile,page,idsKey]);
  useLayoutEffect(()=>{playbackPresentation.current?.presentationChanged();refresh.current();refreshCaret.current();refreshErrors.current();refreshLoop.current();refreshDiagrams.current();refreshDesign.current();},[pagination,arrangement,pageError]);
  designing.current=barDesign;
  const tabBar=barHandles.some(handle=>handle.bar===activeBar)?activeBar:barHandles[0]?.bar;
  useEffect(()=>{refreshDesign.current();},[!!barDesign,display.layout,zoom,renderedScore,available.width,available.height]);
  // A drag belongs to the document and the free state it started in: a busy score or a changed score or width ends it unrecorded.
  useEffect(()=>{if(dragging.current)cancelBarDrag();},[barDesign?.busy,renderedScore,engraving,!!barDesign,display.layout]);
  useEffect(()=>{if(dragging.current&&!barHandles.some(handle=>handle.bar===dragging.current!.bar))cancelBarDrag();},[barHandles]);
  useEffect(()=>{
    const abandon=()=>cancelBarDrag(),key=(event:KeyboardEvent)=>{if(event.key==='Escape'&&dragging.current){event.preventDefault();event.stopPropagation();cancelBarDrag();}};
    window.addEventListener('blur',abandon);document.addEventListener('keydown',key,true);
    return()=>{window.removeEventListener('blur',abandon);document.removeEventListener('keydown',key,true);dragging.current=null;};
  },[]);
  // After an accepted width the handle may be rebuilt (page layouts re-paginate): put focus back on that bar once it exists, unless the user went elsewhere.
  useLayoutEffect(()=>{
    const bar=restoreBar.current;if(bar===null)return;const element=handleRefs.current.get(bar);if(!element)return;
    if(document.activeElement!==element)element.focus({preventScroll:true});restoreBar.current=null;
  },[barHandles,barDesign]);
  // The focused bar is gone (measures were removed): focus its nearest neighbour rather than dropping to the page.
  useLayoutEffect(()=>{
    const held=heldBar.current;
    if(held===null||!barHandles.length||handleRefs.current.has(held)||(document.activeElement&&document.activeElement!==document.body))return;
    const near=barHandles.reduce((a,b)=>Math.abs(b.bar-held)<Math.abs(a.bar-held)?b:a);restoreBar.current=null;handleRefs.current.get(near.bar)?.focus({preventScroll:true});
  },[barHandles]);
  useEffect(()=>{
    const away=(event:FocusEvent)=>{if(restoreBar.current!==null&&event.target instanceof Element&&!event.target.closest('.score-bar-handle'))restoreBar.current=null;};
    document.addEventListener('focusin',away);return()=>document.removeEventListener('focusin',away);
  },[]);
  useEffect(()=>{refreshErrors.current();},[errors,score,track,zoom,profile,projection,visibleTracks]);
  // Drawn when the loop or the layout changes, not per playback tick: the key is the bars and ticks the loop covers.
  const loopKey=loop?JSON.stringify(loop.bars):'';
  useEffect(()=>{refreshLoop.current();},[loopKey,score,track,zoom,profile,projection,visibleTracks,playback]);
  useEffect(()=>{refreshDiagrams.current();},[score,track,zoom,profile,projection,visibleTracks]);
  const capture=(event:ReactMouseEvent<HTMLDivElement>)=>{if(event.button!==0||(event.target instanceof Element&&event.target.closest('.score-bar-handle,.score-symbol-popover,.score-scale-diagram')))return;
    // In entry mode a click on a notation staff writes there; anywhere else it selects as usual.
    const entry=entering.current,hit=entry&&!event.ctrlKey&&!event.metaKey&&!event.altKey?entryHitAt(event.clientX,event.clientY):null;
    if(entry&&hit){event.preventDefault();event.stopPropagation();event.currentTarget.focus({preventScroll:true});drag.current=null;setGhost(null);entry.onHit(hit.target,hit.step,{chord:event.shiftKey});return;}event.preventDefault();event.currentTarget.focus({preventScroll:true});modifiers.current={shift:event.shiftKey,toggle:event.ctrlKey||event.metaKey,detail:event.detail};drag.current=null;};
  const resize=(edge:'start'|'end',event:ReactMouseEvent)=>{
    event.preventDefault();event.stopPropagation();if(event.button!==0||!handles||!editorSelection||editorSelection.kind==='notes')return;
    const fixed=handles[edge==='start'?'end':'start'].target;
    drag.current={anchor:fixed,last:handles[edge].target,lanes:editorSelection.kind==='range'?editorSelection.range.lanes:[{track:fixed.track,staff:fixed.staff,voice:fixed.voice}],...(editorSelection.kind==='bars'?{bars:editorSelection}:{})};
  };
  const physicalDown=(event:ReactMouseEvent)=>{
    if(event.button!==0||!pagination||!arrangement||!wrapper.current)return;
    const rect=wrapper.current.getBoundingClientRect(),hit=hitTestScreenPages(pagination,arrangement,{x:event.clientX-rect.left,y:event.clientY-rect.top},editTarget);
    if(hit){pointerActions.current.downBeat(hit.beat);if(hit.note)pointerActions.current.downNote(hit.note);}
  };
  /** One drag is one edit: the guide follows the pointer, and only a release that still has the pointer, the document and a free score records a width. Anything else abandons it. */
  const cancelBarDrag=()=>{
    const active=dragging.current;if(!active)return;dragging.current=null;
    try{active.element.releasePointerCapture?.(active.pointer);}catch{ /* The pointer may already be gone. */ }
    setBarDrag(null);
  };
  const startBarDrag=(handle:BarHandle,event:ReactPointerEvent<HTMLDivElement>)=>{
    const design=designing.current;if(event.button!==0||!design)return;event.preventDefault();event.stopPropagation();if(design.busy)return;
    event.currentTarget.focus({preventScroll:true});
    try{event.currentTarget.setPointerCapture?.(event.pointerId);}catch{ /* Capture is a refinement; blur and a missing button still end the drag. */ }
    dragging.current={bar:handle.bar,pointer:event.pointerId,startX:event.clientX,start:design.scaleOf(handle.bar),width:handle.width,delta:0,element:event.currentTarget};setBarDrag({bar:handle.bar,delta:0});
  };
  const moveBarDrag=(event:ReactPointerEvent<HTMLDivElement>)=>{
    const active=dragging.current;if(!active||event.pointerId!==active.pointer)return;
    // A move with no button down means the release was missed (another window had it).
    if(event.buttons===0){cancelBarDrag();return;}
    active.delta=Math.max(-active.width*.75,event.clientX-active.startX);setBarDrag({bar:active.bar,delta:active.delta});
  };
  const endBarDrag=(event:ReactPointerEvent<HTMLDivElement>)=>{
    const active=dragging.current;if(!active||event.pointerId!==active.pointer)return;
    const latest=designing.current;cancelBarDrag();
    // The latest score decides: a busy score or a changed width since the press drops the drag.
    if(!latest||latest.busy||active.delta===0||latest.scaleOf(active.bar)!==active.start)return;
    const next=scaleAfterDrag(active.start,active.width,active.delta);if(next===active.start)return;
    restoreBar.current=active.bar;latest.onScale(active.bar,next);
  };
  const keyBar=(handle:BarHandle,event:ReactKeyboardEvent<HTMLDivElement>)=>{
    // Tab and Escape keep their usual jobs; a modified key stays with the app (Ctrl+Z). Every other key stays out of the score.
    if(event.key==='Enter')event.stopPropagation();
    if(event.ctrlKey||event.metaKey||event.altKey||event.key==='Tab'||event.key==='Escape')return;
    event.stopPropagation();
    const order=barHandles.map(item=>item.bar),at=order.indexOf(handle.bar),key=event.key;
    const go=key==='Home'?0:key==='End'?order.length-1:!event.shiftKey&&key==='ArrowRight'?at+1:!event.shiftKey&&key==='ArrowLeft'?at-1:null;
    if(go!==null){
      event.preventDefault();const to=order[go];
      if(to!==undefined&&to!==handle.bar){setActiveBar(to);handleRefs.current.get(to)?.focus();}
      return;
    }
    const design=designing.current,step=key==='PageUp'||key==='PageDown'?BAR_SCALE_BIG_STEP:BAR_SCALE_STEP;
    const direction=key==='ArrowRight'||key==='PageUp'?1:key==='ArrowLeft'||key==='PageDown'?-1:0,reset=key==='Delete'||key==='Backspace';
    if(!direction&&!reset)return;
    event.preventDefault();if(!design||design.busy)return;
    const now=design.scaleOf(handle.bar),target=reset?design.defaultOf(handle.bar):clampBarScale(now+direction*step);
    if(target!==now){restoreBar.current=handle.bar;design.onScale(handle.bar,target);}
  };
  const [symbolUi,setSymbolUi]=useState<SymbolView|null>(null),symbolReturn=useRef<HTMLElement|null>(null),symbolSeen=useRef(symbols?.request??0),symbolOpen=useRef(false),symbolGeneration=useRef(0),symbolArea=useRef<{width:number;height:number}|null>(null);
  /** Closing puts focus back where it was before the popover opened, unless focus already went somewhere else. */
  const closeSymbol=useCallback((restore:boolean,id?:number)=>{
    // A second close (the edit landing after the score changed) must not move focus again, and one for a popover that has been replaced must not close its successor.
    if(!symbolOpen.current||(id!==undefined&&id!==symbolGeneration.current))return;symbolOpen.current=false;
    setSymbolUi(null);const back=symbolReturn.current;symbolReturn.current=null;
    if(restore)(back?.isConnected?back:wrapper.current)?.focus({preventScroll:true});
  },[]);
  const openSymbol=(next:SymbolView)=>{
    if(!symbolReturn.current){const active=document.activeElement;symbolReturn.current=active instanceof HTMLElement&&active!==document.body&&!active.closest('.score-symbol-popover')?active:wrapper.current;}
    symbolArea.current={width:available.width,height:available.height};symbolOpen.current=true;symbolGeneration.current+=1;setSymbolUi({...next,id:symbolGeneration.current});
  };
  // The popover is placed in the score's own coordinates, so anything that moves or removes the symbol being edited closes it unrecorded:
  // a new score or set of shown tracks, a change of layout, zoom or page, or a resize of the score area. Focus goes back to where it was
  // when it had been inside the popover.
  useEffect(()=>{closeSymbol(!!wrapper.current?.querySelector('.score-symbol-popover')?.contains(document.activeElement));},[score,projection,trackKey,symbols===undefined,closeSymbol,fit.percent,display.layout,display.zoomMode,page]);
  // A resize of the score area (the window, or a panel beside it) moves the symbol too. The popover itself can add a scrollbar and so change the
  // area by a few pixels, which is not a resize: only a change past that, measured from when it opened, closes it.
  useEffect(()=>{
    const base=symbolArea.current;if(!symbolOpen.current||!base)return;
    if(Math.abs(available.width-base.width)>24||Math.abs(available.height-base.height)>24)closeSymbol(!!wrapper.current?.querySelector('.score-symbol-popover')?.contains(document.activeElement));
  },[available.width,available.height,closeSymbol]);
  // Scrolling (by hand, or by playback following the cursor) carries the popover with the score; once it is out of sight it closes.
  useEffect(()=>{
    const host=scrollHost.current;if(!symbolUi||!host)return;
    const away=()=>{
      const popover=wrapper.current?.querySelector('.score-symbol-popover');if(!popover)return;
      const box=popover.getBoundingClientRect(),area=host.getBoundingClientRect();
      if(box.bottom<=area.top||box.top>=area.bottom||box.right<=area.left||box.left>=area.right)closeSymbol(popover.contains(document.activeElement));
    };
    host.addEventListener('scroll',away,{passive:true});return()=>host.removeEventListener('scroll',away);
  },[!!symbolUi,closeSymbol]);
  const symbolAnchor=(event:ReactMouseEvent)=>{const rect=wrapper.current?.getBoundingClientRect();return {x:Math.max(0,event.clientX-(rect?.left??0))+4,y:Math.max(0,event.clientY-(rect?.top??0))+4};};
  /** Which score symbol a click landed on: the clicked <text> says what it is, the bounds of the system under it say where. */
  const symbolAt=(event:ReactMouseEvent):SymbolRef|null=>{
    const view=api.current,text=event.target instanceof Element?event.target.closest('text'):null;
    if(!view||!text||text.closest('.score-symbol-popover'))return null;
    let system:ScreenSystem|null=null,point:{x:number;y:number}|null=null;
    const physical=presentation.current.physical;
    if(physical&&wrapper.current){const rect=wrapper.current.getBoundingClientRect(),hit=unmapScreenPoint(physical.pagination,physical.arrangement,{x:event.clientX-rect.left,y:event.clientY-rect.top});if(hit){system=hit.system;point=hit.point;}}
    else if(!layoutCurrent.current.sourcePhysical&&view.boundsLookup){
      const bounds=view.uiFacade.getOffset(null,view.canvasElement),x=event.clientX+window.scrollX-bounds.x,y=event.clientY+window.scrollY-bounds.y;
      system=systemAt(view.boundsLookup.staffSystems,y);if(system)point={x,y};
    }
    return resolveSymbol({score:current.current.score,tracks:current.current.tracks,text:text.textContent??'',centered:text.getAttribute('text-anchor')==='middle',system,point,sourceBeat:canonicalBeat});
  };
  const symbolDoubleClick=(event:ReactMouseEvent)=>{
    if(!symbols||event.button!==0)return;const ref=symbolAt(event);if(!ref)return;
    event.preventDefault();event.stopPropagation();
    openSymbol({anchor:symbolAnchor(event),ref,view:symbols.locked?'menu':ref.kind==='clef'?'clef':'text'});
  };
  const symbolContextMenu=(event:ReactMouseEvent)=>{
    if(!symbols)return;const ref=symbolAt(event);if(!ref)return;
    event.preventDefault();event.stopPropagation();openSymbol({anchor:symbolAnchor(event),ref,view:'menu'});
  };
  /** The keyboard has no pointer: the menu lists the symbols at the edit target and opens beside its marker. */
  const openTargetMenu=()=>{
    const rect=wrapper.current?.getBoundingClientRect(),host=scrollHost.current?.getBoundingClientRect();
    openSymbol({anchor:caret?{x:caret.x,y:caret.y+caret.h+4}:{x:Math.max(0,(host?.left??0)-(rect?.left??0))+16,y:Math.max(0,(host?.top??0)-(rect?.top??0))+16},ref:null,view:'menu'});
  };
  useEffect(()=>{
    const request=symbols?.request??0;if(request===symbolSeen.current)return;symbolSeen.current=request;
    if(symbols&&editTarget)openTargetMenu();
    // Only a new request opens the menu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[symbols?.request]);
  const symbolKey=(event:ReactKeyboardEvent<HTMLDivElement>)=>{
    if(!symbols||event.target!==event.currentTarget||!(event.key==='ContextMenu'||(event.key==='F10'&&event.shiftKey)))return;
    event.preventDefault();event.stopPropagation();if(editTarget)openTargetMenu();
  };
  if(drawFailure)throw drawFailure.error;
  return <div ref={wrapper} tabIndex={-1} className="score-presentation" data-layout={display.layout} data-music-font={musicShown==='bravura'?undefined:musicShown} data-note-entry={noteEntry?'on':undefined} onMouseDownCapture={capture} onMouseMove={noteEntry?previewEntry:undefined} onMouseLeave={()=>setGhost(null)} onDoubleClick={symbolDoubleClick} onContextMenu={symbolContextMenu} onKeyDown={symbolKey}>
    {pageError&&<p className="score-page-error" role="alert">{pageError} Continuous view is shown at {zoom}%.</p>}
    <div className={sourcePhysical?'score-source-staging':'score-live-paper'} style={{width:sourceWidth||undefined,...(overlay&&!sourcePhysical?{position:'relative' as const}:{})}} aria-hidden={sourcePhysical||undefined} inert={sourcePhysical||undefined}>
      <div ref={container} data-testid="score-source" aria-hidden={sourcePhysical||undefined} aria-label="Music notation"/>
      {overlay&&!sourcePhysical&&<svg data-tp-accolades className={`score-accolades ${surfaceClass}`} aria-hidden="true" width={1} height={1} style={{position:'absolute',left:0,top:0,overflow:'visible',pointerEvents:'none'}} dangerouslySetInnerHTML={{__html:overlay}}/>}
    </div>
    {pagination&&arrangement&&<div data-testid="score-pages" className={`score-pages ${surfaceClass}`} style={{width:arrangement.width,height:arrangement.height}} onMouseDown={physicalDown}>
      {arrangement.pages.map(sheet=><div key={sheet.index} className="score-sheet" aria-label={`Score page ${sheet.index+1}`} style={{left:sheet.x,top:sheet.y,width:sheet.width,height:sheet.height}}>
        {pagination.blocks.filter(block=>block.page===sheet.index).map(block=><div key={block.chunk.id} ref={element=>{if(element)roots.current.set(block.chunk.id,element);else roots.current.delete(block.chunk.id);}} className="score-svg-chunk at-surface-svg" style={{left:(block.x+block.chunk.x-block.sourceBounds.x)*factor,top:(block.y+block.chunk.y-block.sourceBounds.y)*factor,width:block.chunk.width,height:block.chunk.height+shiftTotal(block.chunk.shift),transform:`scale(${factor})`}} dangerouslySetInnerHTML={{__html:block.chunk.svg}}/>)}
        <svg className="score-page-text" aria-hidden="true" viewBox={`0 0 ${geometry.width} ${geometry.height}`} width={sheet.width} height={sheet.height}>
          {(pageTexts[sheet.index]??[]).map((item,index)=><text key={index} x={item.x} y={item.y} fontSize={item.size} fontFamily={item.family?fontStack(item.family).join(', '):pageTextFontFamily} fontWeight={item.bold?700:undefined} fontStyle={item.italic?'italic':undefined} fill="#111" textAnchor={item.anchor}>{item.text}</text>)}
        </svg>
      </div>)}
    </div>}
    <span ref={barElement} hidden className="score-playback-bar" aria-hidden="true"/>
    <span ref={beatElement} hidden className="score-playback-beat" aria-hidden="true"/>
    {rangeBlocks.map((block,index)=><span key={index} className="score-range-block" aria-hidden="true" data-before={block.before} data-after={block.after} style={{left:block.x,top:block.y,width:block.w,height:block.h}}/>)}
    {loopBlocks.map((block,index)=><span key={index} className="score-loop-band" aria-hidden="true" data-before={block.before} data-after={block.after} style={{left:block.x,top:block.y,width:block.w,height:block.h}}/>)}
    {errorBlocks.map((block,index)=><span key={index} role="img" aria-label={block.label} className="score-error-bar" style={{left:block.x,top:block.y,width:block.w,height:block.h}}/>)}
    {diagramBlocks.map((block,index)=><div key={index} className="score-scale-diagram" style={{position:'absolute',left:block.x,top:block.y,zIndex:openDiagram===index?6:2}} onMouseEnter={()=>setOpenDiagram(index)} onMouseLeave={()=>setOpenDiagram(open=>open===index?null:open)} onFocus={()=>setOpenDiagram(index)} onBlur={()=>setOpenDiagram(open=>open===index?null:open)}>
      <button type="button" className="score-scale-diagram-chip" aria-label={`Show scale diagram ${block.diagram.name||'without a name'}`} aria-expanded={openDiagram===index} style={{height:chipHeight,width:block.w,padding:'0 4px',font:'600 10px sans-serif',border:'1px solid #97a6b6',borderRadius:4,background:'#fffdf8',color:'#161c24',overflow:'hidden',whiteSpace:'nowrap',textOverflow:'ellipsis',cursor:'pointer'}}>▦ {chipLabel(block.diagram)}</button>
      {openDiagram===index&&<div style={{position:'absolute',left:0,top:chipHeight+chipGap,width:scaleDiagramSize(block.diagram).width*diagramScale,border:'1px solid #97a6b6',borderRadius:4,overflow:'hidden',background:'#fffdf8',pointerEvents:'none'}}><ScaleDiagramView diagram={block.diagram}/></div>}
    </div>)}
    {barHandles.map(handle=>{
      const scale=barDesign?.scaleOf(handle.bar)??1,base=barDesign?.defaultOf(handle.bar)??1,moving=barDrag?.bar===handle.bar?barDrag.delta:null,percent=Math.round(scale*100);
      return <div key={handle.bar} ref={element=>{if(element)handleRefs.current.set(handle.bar,element);else handleRefs.current.delete(handle.bar);}} role="slider" tabIndex={handle.bar===tabBar?0:-1} aria-orientation="horizontal" aria-label={`Bar ${handle.bar+1} width`} aria-valuemin={BAR_SCALE_RANGE.min*100} aria-valuemax={BAR_SCALE_RANGE.max*100} aria-valuenow={percent} aria-valuetext={`${percent}% of the standard width${base!==1?`, imported ${Math.round(base*100)}%`:''}`} title="Drag, or press Shift+Left and Shift+Right. Left and Right move between bars. Delete restores the default width."
        {...busyGuard<HTMLDivElement>({busy:barDesign?.busy,className:'score-bar-handle',onKeyDown:event=>keyBar(handle,event),onPointerDown:event=>startBarDrag(handle,event)})}
        onPointerMove={moveBarDrag} onPointerUp={endBarDrag} onPointerCancel={cancelBarDrag} onLostPointerCapture={cancelBarDrag} onBlur={event=>{cancelBarDrag();if(event.relatedTarget)heldBar.current=null;}} onFocus={()=>{setActiveBar(handle.bar);heldBar.current=handle.bar;}}
        style={{left:handle.x-5,top:handle.y,height:handle.h}}>{moving!==null&&<span className="score-bar-guide" aria-hidden="true" style={{left:5+moving}}/>}</div>;
    })}
    {symbolUi&&symbols&&<SymbolPopover state={symbolUi} score={score} targets={symbolUi.ref||!editTarget?[]:targetSymbols(score,editTarget,tracks)} busy={symbols.busy} locked={symbols.locked} onEdit={symbols.onEdit} onChordEditor={ref=>symbols.onChordEditor(ref.target)} onView={next=>setSymbolUi(old=>({...next,id:old?.id}))} onClose={closeSymbol}/>}
    <span className="score-edit-announcement" role="status" aria-live="polite" aria-atomic="true">{editLocation}</span>
    {caret&&<span ref={caretElement} role="img" aria-label="Edit target" className="score-edit-target" style={{left:caret.x,top:caret.y,width:caret.w,height:caret.h}}>{(caret.entry||editPendingFret)&&<span className="score-edit-entry" aria-hidden="true">{editPendingFret?t('score.pending_fret_label',{fret:editPendingFret}):(editString?t('score.edit_string',{string:editString}):t('score.edit_entry'))}</span>}</span>}
    {ghost&&<span className="score-entry-ghost" aria-hidden="true" style={{left:ghost.x,top:ghost.y,width:ghost.w,height:ghost.h}}><span className="score-entry-ghost-label">{ghost.label}</span></span>}
    {markers.map((marker,index)=><span key={index} role="img" aria-label={`Selected note ${index+1}`} style={{position:'absolute',left:marker.x,top:marker.y,width:marker.w,height:marker.h,boxSizing:'border-box',border:'2px solid #9aaf38',background:'rgba(185,205,105,.3)',borderRadius:3,pointerEvents:'none'}}/>)}
    {handles&&(['start','end'] as const).map(edge=><button key={edge} type="button" aria-label={`Resize selection ${edge}`} onMouseDown={event=>resize(edge,event)} style={{position:'absolute',left:handles[edge].x-6,top:handles[edge].y+handles[edge].h/2-12,width:12,height:24,padding:0,border:'2px solid #60712b',borderRadius:3,background:'#bccf6e',cursor:'ew-resize',zIndex:4}}/>)}
  </div>;
}
