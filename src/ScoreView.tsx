import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { AlphaTabApi, LayoutMode, SystemsLayoutMode, type model, StaveProfile, type PlaybackHighlightChangeEventArgs } from '@coderline/alphatab';
import type { BeatTarget } from './project';
import type { NativePlaybackController } from './audio/NativePlaybackController';
import type { MusicSelection, VoiceAddress } from './editor/range-types';
import { rangeFromBeats, resolveSelectionBeats, resolveSelectionNotes, selectionForBars, selectionForTrack } from './editor/range-selection';
import { configureEngraving, type EngravingProjection } from './engraving/projection';
import type { EngravingOverrides,PageLayout } from './engraving/types';
import {pageGeometry} from './engraving/page';
import {isPhysicalPageLayout,type ScoreDisplayPreferences} from './engraving/screen-view';
import {arrangeScreenPages,hitTestScreenPages,mapScreenRect,paginateScreenScore,resolveScreenZoom,type ScreenPagination,type ScreenRenderChunk,type ScreenRect,type ScreenSystem} from './engraving/screen-pages';
import {installScreenPlayback,type ScreenPlaybackContext} from './engraving/screen-playback';
import './ScoreView.css';

const address=(beat:model.Beat):BeatTarget=>({track:beat.voice.bar.staff.track.index,staff:beat.voice.bar.staff.index,bar:beat.voice.bar.index,voice:beat.voice.index,beat:beat.index});
const sameLane=(a:VoiceAddress,b:VoiceAddress)=>a.track===b.track&&a.staff===b.staff&&a.voice===b.voice;
const sameBeat=(a:BeatTarget,b:BeatTarget)=>sameLane(a,b)&&a.bar===b.bar&&a.beat===b.beat;
type Marker={x:number;y:number;w:number;h:number};
type Handles={start:Marker&{target:BeatTarget};end:Marker&{target:BeatTarget}};
type Drag={anchor:BeatTarget;last:BeatTarget;lanes:VoiceAddress[];bars?:Extract<MusicSelection,{kind:'bars'}>};

const defaultDisplay:ScoreDisplayPreferences={layout:'parchment',zoomMode:'manual'};
const defaultPage:PageLayout={widthMm:210,heightMm:297,marginsMm:{top:15,right:15,bottom:15,left:15},scale:1,profile:'document'};

export function ScoreView({score,track,zoom,profile,onSelect,playback,editorSelection=null,onEditorSelection,projection,visibleTracks,engraving,editTarget,editString,editNoteIndex,display=defaultDisplay,page:pageInput=defaultPage,onDisplayStatus}: {
  score:model.Score;track:number;zoom:number;profile:string;onSelect:(target:BeatTarget,string?:number,noteIndex?:number)=>void;
  playback:NativePlaybackController|null;
  editorSelection?:MusicSelection|null;onEditorSelection?:(selection:MusicSelection|null)=>void;
  projection?:EngravingProjection;visibleTracks?:number[];engraving?:EngravingOverrides;
  display?:ScoreDisplayPreferences;page?:PageLayout;onDisplayStatus?:(status:{zoomPercent:number;fitLimited:boolean;pageError:string|null})=>void;
  editTarget?:BeatTarget;editString?:number;editNoteIndex?:number|null;
}) {
  const wrapper=useRef<HTMLDivElement>(null),container=useRef<HTMLDivElement>(null),api=useRef<AlphaTabApi|null>(null);
  const tracks=visibleTracks??[track],renderedScore=projection?.score??score,trackKey=tracks.join(',');
  // Headers and footers only print, so editing them keeps the on-screen pages as they are.
  const pageKey=JSON.stringify({...pageInput,headerFooter:undefined}),page=useMemo(()=>pageInput,[pageKey]);
  const geometry=useMemo(()=>pageGeometry(page),[page]),physicalRequested=isPhysicalPageLayout(display.layout);
  const scrollHost=useRef<HTMLElement|null>(null),[available,setAvailable]=useState({width:0,height:0});
  const [completed,setCompleted]=useState<{score:model.Score;tracks:string;page:PageLayout;engraving:EngravingOverrides|undefined;pagination:ScreenPagination|null;error:string|null}|null>(null);
  const [natural,setNatural]=useState<{score:model.Score;tracks:string;layout:string;width:number;engraving:EngravingOverrides|undefined;profile:string;value:number}|null>(null);
  const validCompletion=completed?.score===renderedScore&&completed.tracks===trackKey&&completed.page===page&&completed.engraving===engraving?completed:null;
  const pageError=physicalRequested?validCompletion?.error??null:null,pagination=physicalRequested?validCompletion?.pagination??null:null;
  const screenLayout=display.layout==='verticalScreen'||display.layout==='horizontalScreen';
  const baseWidth=natural?.score===renderedScore&&natural.tracks===trackKey&&natural.layout===display.layout&&natural.width===available.width&&natural.engraving===engraving&&natural.profile===profile?natural.value:null;
  const fitMode=pageError?'manual':display.zoomMode;
  const fit=fitMode==='manual'||!available.width||(fitMode==='fitPage'&&!available.height)?{percent:zoom,limited:false}:screenLayout?
    baseWidth===null?{percent:100,limited:false}:resolveScreenZoom({zoomMode:'fitWidth',manualPercent:zoom,available:{...available,width:display.layout==='verticalScreen'?Math.min(available.width,baseWidth):available.width},natural:{width:baseWidth}}):
    resolveScreenZoom({zoomMode:fitMode,manualPercent:zoom,available,natural:{width:geometry.width,height:geometry.height}});
  const measureBase=screenLayout&&fitMode!=='manual'&&baseWidth===null;
  const factor=fit.percent/100,sourcePhysical=physicalRequested&&!pageError;
  const sourceWidth=sourcePhysical?geometry.usableWidth:screenLayout?available.width:geometry.width*factor;
  const sourceScale=sourcePhysical?page.scale:screenLayout?factor:page.scale*factor;
  const arrangement=useMemo(()=>pagination?arrangeScreenPages(pagination,display.layout as 'verticalPage'|'horizontalPage'|'grid',factor,available.width):null,[pagination,display.layout,factor,available.width]);
  const roots=useRef(new Map<string,HTMLElement>()),barElement=useRef<HTMLSpanElement>(null),beatElement=useRef<HTMLSpanElement>(null);
  const presentation=useRef<ScreenPlaybackContext>({renderedScore,wrapper:null,scrollHost:null,physical:null,barElement:null,beatElement:null});
  presentation.current={renderedScore,wrapper:wrapper.current,scrollHost:scrollHost.current,physical:pagination&&arrangement?{pagination,arrangement,roots:roots.current}:null,barElement:barElement.current,beatElement:beatElement.current};
  const playbackPresentation=useRef<ReturnType<typeof installScreenPlayback>|null>(null);
  const layoutCurrent=useRef({renderedScore,trackKey,page,engraving,profile,display,available,sourcePhysical,baseWidth});layoutCurrent.current={renderedScore,trackKey,page,engraving,profile,display,available,sourcePhysical,baseWidth};
  const pointerActions=useRef({downBeat:(_beat:model.Beat)=>{},downNote:(_note:model.Note)=>{},move:(_beat:model.Beat)=>{}});
  const [rangeBlocks,setRangeBlocks]=useState<Marker[]>([]),[surfaceClass,setSurfaceClass]=useState('');
  useLayoutEffect(()=>{
    const host=wrapper.current?.closest<HTMLElement>('.paper-scroll')??wrapper.current?.parentElement??null;scrollHost.current=host;
    const measure=()=>{if(!host)return;const css=getComputedStyle(host),width=Math.max(0,host.clientWidth-(parseFloat(css.paddingLeft)||0)-(parseFloat(css.paddingRight)||0)),height=Math.max(0,host.clientHeight-(parseFloat(css.paddingTop)||0)-(parseFloat(css.paddingBottom)||0));setAvailable(old=>old.width===width&&old.height===height?old:{width,height});};
    measure();const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(measure);if(host)observer?.observe(host);window.addEventListener('resize',measure);
    return()=>{observer?.disconnect();window.removeEventListener('resize',measure);};
  },[]);
  useEffect(()=>{onDisplayStatus?.({zoomPercent:fit.percent,fitLimited:fit.limited,pageError});},[onDisplayStatus,fit.percent,fit.limited,pageError]);
  const current=useRef({score,track,onSelect,editorSelection,onEditorSelection,projection,tracks,editTarget,editString,editNoteIndex});current.current={score,track,onSelect,editorSelection,onEditorSelection,projection,tracks,editTarget,editString,editNoteIndex};
  const modifiers=useRef({shift:false,toggle:false,detail:0}),anchor=useRef<BeatTarget|null>(null),drag=useRef<Drag|null>(null);
  const [markers,setMarkers]=useState<Marker[]>([]),[handles,setHandles]=useState<Handles|null>(null);
  const [caret,setCaret]=useState<(Marker&{entry:boolean})|null>(null),caretElement=useRef<HTMLSpanElement>(null),revealCaret=useRef(false),rendering=useRef(false);
  const refresh=useRef(()=>{}),refreshCaret=useRef(()=>{});
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
  const placeHandles=(event:PlaybackHighlightChangeEventArgs)=>{
    setRangeBlocks([]);
    if(rendering.current||!event.startBeat||!event.endBeat||!event.startBeatBounds||!event.endBeatBounds){setHandles(null);return;}
    const first=canonicalBeat(event.startBeat),last=canonicalBeat(event.endBeat);
    if(!first||!last||event.startBeatBounds.beat!==event.startBeat||event.endBeatBounds.beat!==event.endBeat){setHandles(null);return;}
    if(presentation.current.physical&&(!(api.current?.boundsLookup?.findBeats(event.startBeat)??[]).includes(event.startBeatBounds)||!(api.current?.boundsLookup?.findBeats(event.endBeat)??[]).includes(event.endBeatBounds))){setHandles(null);return;}
    const start=mapped(event.startBeatBounds.realBounds,beatSystem(event.startBeat)),end=mapped(event.endBeatBounds.realBounds,beatSystem(event.endBeat));
    setHandles(start&&end?{start:{...start,target:address(first)},end:{...end,x:end.x+end.w,target:address(last)}}:null);
    if(presentation.current.physical)setRangeBlocks((event.highlightBlocks??[]).flatMap(box=>{
      const systems=api.current?.boundsLookup?.staffSystems??[];
      return systems.flatMap(system=>{const s=system.realBounds,top=Math.max(box.y,s.y),bottom=Math.min(box.y+box.h,s.y+s.h);if(bottom<=top)return [];const rect=mapped({...box,y:top,h:bottom-top},system);return rect?[rect]:[];});
    }));
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
      if(first===last){const rect=mapped(startBeatBounds.realBounds,beatSystem(first));setMarkers(rect?[rect]:[]);}else if(!presentation.current.physical)placeHandles({startBeat:first,endBeat:last,startBeatBounds,endBeatBounds});
    } catch {clearHighlight(view);}
  };
  useEffect(()=>{
    const view=new AlphaTabApi(container.current!,{core:{fontDirectory:'/font/',scriptFile:'/alphatab/alphaTab.mjs',includeNoteBounds:true,useWorkers:false,engine:'svg',enableLazyLoading:false},player:{playerMode:'EnabledExternalMedia',enableCursor:false,enableUserInteraction:false,scrollElement:'.paper-scroll'}});api.current=view;
    const adapter=installScreenPlayback(view,()=>({...presentation.current,wrapper:wrapper.current,scrollHost:scrollHost.current,barElement:barElement.current,beatElement:beatElement.current}));playbackPresentation.current=adapter;
    view.settings.player.enableCursor=true;
    // Reuse the facade's public DOM surface classes so its instance-specific font CSS also applies to copied SVGs.
    setSurfaceClass(container.current?.querySelector('.at-surface')?.className??'');
    let chunks:ScreenRenderChunk[]=[],collecting=false,generation:typeof layoutCurrent.current|null=null;
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
      collecting=true;chunks=[];generation=layoutCurrent.current;rendering.current=true;setCompleted(previous=>previous?.error?previous:null);setCaret(null);setMarkers([]);setHandles(null);setRangeBlocks([]);adapter.renderStarted();
    }),view.renderer.partialRenderFinished.on(event=>{
      if(collecting&&typeof event.renderResult==='string')chunks.push({id:event.id,x:event.x,y:event.y,width:event.width,height:event.height,firstMasterBarIndex:event.firstMasterBarIndex,lastMasterBarIndex:event.lastMasterBarIndex,svg:event.renderResult});
    }),view.postRenderFinished.on(()=>{
      collecting=false;const c=generation,latest=layoutCurrent.current;rendering.current=false;adapter.renderCompleted();
      if(c&&c.renderedScore===latest.renderedScore&&c.trackKey===latest.trackKey&&c.page===latest.page&&c.engraving===latest.engraving&&c.sourcePhysical===latest.sourcePhysical&&view.score===c.renderedScore&&view.boundsLookup){
        if(c.sourcePhysical){try{setCompleted({score:c.renderedScore,tracks:c.trackKey,page:c.page,engraving:c.engraving,pagination:paginateScreenScore(chunks,view.boundsLookup,c.page),error:null});}catch(error){setCompleted({score:c.renderedScore,tracks:c.trackKey,page:c.page,engraving:c.engraving,pagination:null,error:error instanceof Error?error.message:'Unable to arrange this score on paper.'});}}
        if((c.display.layout==='verticalScreen'||c.display.layout==='horizontalScreen')&&c.display.zoomMode!=='manual'&&c.baseWidth===null){
          const width=Math.max(1,...chunks.map(chunk=>chunk.x+chunk.width),...view.boundsLookup.staffSystems.map(system=>system.realBounds.x+system.realBounds.w));
          setNatural({score:c.renderedScore,tracks:c.trackKey,layout:c.display.layout,width:c.available.width,engraving:c.engraving,profile:c.profile,value:width});
        }
      }
      refresh.current();refreshCaret.current();
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
  useEffect(()=>{
    const view=api.current!;if(sourceWidth<=0)return;
    view.settings.display.scale=sourceScale;
    if(engraving)configureEngraving(view.settings,engraving);else view.settings.display.staveProfile=StaveProfile[profile as keyof typeof StaveProfile] as StaveProfile;
    view.settings.display.layoutMode=display.layout==='horizontalScreen'?LayoutMode.Horizontal:display.layout==='verticalScreen'?LayoutMode.Page:LayoutMode.Parchment;
    view.settings.display.systemsLayoutMode=display.layout==='verticalScreen'?SystemsLayoutMode.Automatic:SystemsLayoutMode.UseModelLayout;
    view.settings.display.padding=sourcePhysical||screenLayout?[0,0,0,0]:[geometry.left*factor,geometry.top*factor,geometry.right*factor,geometry.bottom*factor];
    view.renderer.width=sourceWidth;view.updateSettings();
    const old=loaded.current;
    if(!old||old.score!==renderedScore||old.tracks!==trackKey){loaded.current={score:renderedScore,tracks:trackKey};if(playback)playback.setRenderedScore(renderedScore,tracks);else view.renderScore(renderedScore,tracks);}
    else view.render();
  },[renderedScore,trackKey,playback,sourceWidth,sourceScale,sourcePhysical,measureBase,screenLayout,display.layout==='verticalScreen',display.layout==='horizontalScreen',engraving,profile,page]);
  useLayoutEffect(()=>{playbackPresentation.current?.presentationChanged();refresh.current();refreshCaret.current();},[pagination,arrangement,pageError]);
  const capture=(event:ReactMouseEvent<HTMLDivElement>)=>{if(event.button!==0)return;event.preventDefault();event.currentTarget.focus({preventScroll:true});modifiers.current={shift:event.shiftKey,toggle:event.ctrlKey||event.metaKey,detail:event.detail};drag.current=null;};
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
  return <div ref={wrapper} tabIndex={-1} className="score-presentation" data-layout={display.layout} onMouseDownCapture={capture}>
    {pageError&&<p className="score-page-error" role="alert">{pageError} Continuous view is shown at {zoom}%.</p>}
    <div className={sourcePhysical?'score-source-staging':'score-live-paper'} style={{width:sourceWidth||undefined}} aria-hidden={sourcePhysical||undefined} inert={sourcePhysical||undefined}>
      <div ref={container} data-testid="score-source" aria-hidden={sourcePhysical||undefined} aria-label="Music notation"/>
    </div>
    {pagination&&arrangement&&<div data-testid="score-pages" className={`score-pages ${surfaceClass}`} style={{width:arrangement.width,height:arrangement.height}} onMouseDown={physicalDown}>
      {arrangement.pages.map(sheet=><div key={sheet.index} className="score-sheet" aria-label={`Score page ${sheet.index+1}`} style={{left:sheet.x,top:sheet.y,width:sheet.width,height:sheet.height}}>
        {pagination.blocks.filter(block=>block.page===sheet.index).map(block=><div key={block.chunk.id} ref={element=>{if(element)roots.current.set(block.chunk.id,element);else roots.current.delete(block.chunk.id);}} className="score-svg-chunk at-surface-svg" style={{left:(block.x+block.chunk.x-block.sourceBounds.x)*factor,top:(block.y+block.chunk.y-block.sourceBounds.y)*factor,width:block.chunk.width,height:block.chunk.height,transform:`scale(${factor})`}} dangerouslySetInnerHTML={{__html:block.chunk.svg}}/>)}
      </div>)}
    </div>}
    <span ref={barElement} hidden className="score-playback-bar" aria-hidden="true"/>
    <span ref={beatElement} hidden className="score-playback-beat" aria-hidden="true"/>
    {rangeBlocks.map((block,index)=><span key={index} className="score-range-block" style={{left:block.x,top:block.y,width:block.w,height:block.h}}/>)}
    <span className="score-edit-announcement" role="status" aria-live="polite" aria-atomic="true">{editLocation}</span>
    {caret&&<span ref={caretElement} role="img" aria-label="Edit target" className="score-edit-target" style={{left:caret.x,top:caret.y,width:caret.w,height:caret.h}}>{caret.entry&&<span className="score-edit-entry" aria-hidden="true">{editString?`String ${editString}`:'Entry'}</span>}</span>}
    {markers.map((marker,index)=><span key={index} role="img" aria-label={`Selected note ${index+1}`} style={{position:'absolute',left:marker.x,top:marker.y,width:marker.w,height:marker.h,boxSizing:'border-box',border:'2px solid #9aaf38',background:'rgba(185,205,105,.3)',borderRadius:3,pointerEvents:'none'}}/>)}
    {handles&&(['start','end'] as const).map(edge=><button key={edge} type="button" aria-label={`Resize selection ${edge}`} onMouseDown={event=>resize(edge,event)} style={{position:'absolute',left:handles[edge].x-6,top:handles[edge].y+handles[edge].h/2-12,width:12,height:24,padding:0,border:'2px solid #60712b',borderRadius:3,background:'#bccf6e',cursor:'ew-resize',zIndex:4}}/>)}
  </div>;
}
