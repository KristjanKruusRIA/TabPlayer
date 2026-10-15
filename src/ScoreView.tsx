import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { AlphaTabApi, type model, StaveProfile, type PlaybackHighlightChangeEventArgs } from '@coderline/alphatab';
import type { BeatTarget } from './project';
import type { NativePlaybackController } from './audio/NativePlaybackController';
import type { MusicSelection, VoiceAddress } from './editor/range-types';
import { rangeFromBeats, resolveSelectionBeats, resolveSelectionNotes, selectionForBars, selectionForTrack } from './editor/range-selection';
import { configureEngraving, type EngravingProjection } from './engraving/projection';
import type { EngravingOverrides } from './engraving/types';

const address=(beat:model.Beat):BeatTarget=>({track:beat.voice.bar.staff.track.index,staff:beat.voice.bar.staff.index,bar:beat.voice.bar.index,voice:beat.voice.index,beat:beat.index});
const sameLane=(a:VoiceAddress,b:VoiceAddress)=>a.track===b.track&&a.staff===b.staff&&a.voice===b.voice;
const sameBeat=(a:BeatTarget,b:BeatTarget)=>sameLane(a,b)&&a.bar===b.bar&&a.beat===b.beat;
type Marker={x:number;y:number;w:number;h:number};
type Handles={start:Marker&{target:BeatTarget};end:Marker&{target:BeatTarget}};
type Drag={anchor:BeatTarget;last:BeatTarget;lanes:VoiceAddress[];bars?:Extract<MusicSelection,{kind:'bars'}>};

export function ScoreView({score,track,zoom,profile,onSelect,playback,editorSelection=null,onEditorSelection,projection,visibleTracks,engraving}: {
  score:model.Score;track:number;zoom:number;profile:string;onSelect:(target:BeatTarget,string?:number,noteIndex?:number)=>void;
  playback:NativePlaybackController|null;
  editorSelection?:MusicSelection|null;onEditorSelection?:(selection:MusicSelection|null)=>void;
  projection?:EngravingProjection;visibleTracks?:number[];engraving?:EngravingOverrides;
}) {
  const wrapper=useRef<HTMLDivElement>(null),container=useRef<HTMLDivElement>(null),api=useRef<AlphaTabApi|null>(null);
  const tracks=visibleTracks??[track],renderedScore=projection?.score??score;
  const current=useRef({score,track,onSelect,editorSelection,onEditorSelection,projection,tracks});current.current={score,track,onSelect,editorSelection,onEditorSelection,projection,tracks};
  const modifiers=useRef({shift:false,toggle:false,detail:0}),anchor=useRef<BeatTarget|null>(null),drag=useRef<Drag|null>(null);
  const [markers,setMarkers]=useState<Marker[]>([]),[handles,setHandles]=useState<Handles|null>(null);
  const refresh=useRef(()=>{});
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
  const placeHandles=(event:PlaybackHighlightChangeEventArgs)=>{
    if(!event.startBeat||!event.endBeat||!event.startBeatBounds||!event.endBeatBounds){setHandles(null);return;}
    const first=canonicalBeat(event.startBeat),last=canonicalBeat(event.endBeat);
    if(!first||!last||event.startBeatBounds.beat!==event.startBeat||event.endBeatBounds.beat!==event.endBeat){setHandles(null);return;}
    const delta=offset(),start=event.startBeatBounds.realBounds,end=event.endBeatBounds.realBounds;
    setHandles({start:{...start,x:delta.x+start.x,y:delta.y+start.y,target:address(first)},end:{...end,x:delta.x+end.x+end.w,y:delta.y+end.y,target:address(last)}});
  };
  refresh.current=()=>{
    const view=api.current;if(!view)return;const selected=current.current.editorSelection;
    setMarkers([]);setHandles(null);
    if(!selected){clearHighlight(view);return;}
    try {
      if(selected.kind==='notes'){
        clearHighlight(view);const delta=offset();
        setMarkers(resolveSelectionNotes(current.current.score,selected).filter(note=>current.current.tracks.includes(note.beat.voice.bar.staff.track.index)).flatMap(source=>{const note=renderedNote(source);return note?(view.boundsLookup?.findBeats(note.beat)??[]).filter(bounds=>bounds.beat===note.beat).flatMap(bounds=>(bounds.notes??[]).filter(bound=>bound.note===note).map(bound=>({...bound.noteHeadBounds,x:delta.x+bound.noteHeadBounds.x,y:delta.y+bound.noteHeadBounds.y}))):[];}));return;
      }
      const beats=resolveSelectionBeats(current.current.score,selected).filter(beat=>current.current.tracks.includes(beat.voice.bar.staff.track.index)).sort((a,b)=>a.voice.bar.index-b.voice.bar.index||a.displayStart-b.displayStart||a.voice.bar.staff.track.index-b.voice.bar.staff.track.index||a.voice.bar.staff.index-b.voice.bar.staff.index||a.voice.index-b.voice.index||a.index-b.index);
      if(!beats.length){clearHighlight(view);return;}
      const source=beats.find(beat=>beat.voice.bar.staff.track.index===current.current.track)??beats[0],lane=address(source),laneBeats=beats.filter(beat=>sameLane(address(beat),lane)),first=renderedBeat(laneBeats[0]),last=renderedBeat(laneBeats[laneBeats.length-1]);
      if(!first||!last){clearHighlight(view);return;}
      const startBeatBounds=view.boundsLookup?.findBeat(first),endBeatBounds=view.boundsLookup?.findBeat(last);
      if(startBeatBounds?.beat!==first||endBeatBounds?.beat!==last){clearHighlight(view);return;}
      view.highlightPlaybackRange(first,last);
      placeHandles({startBeat:first,endBeat:last,startBeatBounds,endBeatBounds});if(first===last){const delta=offset(),bounds=startBeatBounds.realBounds;setMarkers([{...bounds,x:delta.x+bounds.x,y:delta.y+bounds.y}]);}
    } catch {clearHighlight(view);}
  };
  useEffect(()=>{
    const view=new AlphaTabApi(container.current!,{core:{fontDirectory:'/font/',scriptFile:'/alphatab/alphaTab.mjs',includeNoteBounds:true,useWorkers:false},player:{playerMode:'EnabledExternalMedia',enableCursor:true,enableUserInteraction:false,scrollElement:'.paper-scroll'}});api.current=view;
    const publish=(next:MusicSelection|null)=>{current.current.editorSelection=next;current.current.onEditorSelection?.(next);};
    const chooseRange=(from:BeatTarget,to:BeatTarget,lanes:VoiceAddress[])=>{try{publish({kind:'range',range:rangeFromBeats(current.current.score,from,to,lanes)});}catch{return false;}return true;};
    const move=(beat:model.Beat)=>{
      const active=drag.current,source=canonicalBeat(beat);if(!active||!source)return;const to=address(source);if(!sameLane(active.anchor,to)||sameBeat(active.last,to))return;
      if(active.bars){publish(selectionForBars(current.current.score,active.bars.tracks,Math.min(active.anchor.bar,to.bar),Math.max(active.anchor.bar,to.bar)));active.last=to;}
      else if(chooseRange(active.anchor,to,active.lanes))active.last=to;
    };
    const subscriptions=[view.beatMouseDown.on(beat=>{
      const source=canonicalBeat(beat);if(!source)return;
      const point=address(source);current.current.onSelect(point,undefined,undefined);if(!current.current.onEditorSelection)return;
      if(modifiers.current.detail===3){anchor.current=point;drag.current=null;publish(selectionForTrack(current.current.score,point.track));return;}
      if(modifiers.current.toggle)return;
      if(modifiers.current.shift&&!anchor.current&&current.current.editorSelection){try{const first=resolveSelectionBeats(current.current.score,current.current.editorSelection).find(item=>sameLane(address(item),point));if(first)anchor.current=address(first);}catch{ /* A replaced document can invalidate an old indexed selection. */ }}
      const from=modifiers.current.shift&&anchor.current&&sameLane(anchor.current,point)?anchor.current:point;
      anchor.current=from;const lanes=[{track:point.track,staff:point.staff,voice:point.voice}];
      drag.current={anchor:from,last:point,lanes};
      if(!chooseRange(from,point,lanes))publish(selectionForBars(current.current.score,[point.track],point.bar,point.bar));
    }),view.noteMouseDown.on(note=>{
      const source=canonicalNote(note);if(!source)return;
      const point=address(source.beat);current.current.onSelect(point,source.string,source.index);
      if(!current.current.onEditorSelection||!modifiers.current.toggle||modifiers.current.detail===3)return;
      let notes:model.Note[]=[];try{if(current.current.editorSelection)notes=resolveSelectionNotes(current.current.score,current.current.editorSelection);}catch{ /* A replaced document can invalidate an old indexed selection. */ }
      const selected=notes.map(item=>({target:address(item.beat),noteIndex:item.index})),index=selected.findIndex(item=>sameBeat(item.target,point)&&item.noteIndex===source.index);
      if(index>=0)selected.splice(index,1);else selected.push({target:point,noteIndex:source.index});anchor.current=point;drag.current=null;publish(selected.length?{kind:'notes',notes:selected}:null);
    }),view.beatMouseMove.on(move),view.beatMouseUp.on(()=>{drag.current=null;}),view.postRenderFinished.on(()=>refresh.current()),view.playbackRangeHighlightChanged.on(event=>{
      if(current.current.editorSelection&&current.current.editorSelection.kind!=='notes')placeHandles(event);
    })];
    const mouseMove=(event:MouseEvent)=>{
      if(!drag.current)return;const bounds=view.uiFacade.getOffset(null,view.canvasElement),beat=view.boundsLookup?.getBeatAtPos(event.clientX+window.scrollX-bounds.x,event.clientY+window.scrollY-bounds.y);if(beat)move(beat);
    };
    const mouseUp=()=>{drag.current=null;};document.addEventListener('mousemove',mouseMove);document.addEventListener('mouseup',mouseUp);
    return ()=>{for(const dispose of subscriptions)dispose();document.removeEventListener('mousemove',mouseMove);document.removeEventListener('mouseup',mouseUp);view.destroy();api.current=null;};
  },[]);
  useEffect(()=>{anchor.current=null;drag.current=null;},[score,track,projection,visibleTracks]);
  useEffect(()=>{if(!editorSelection)anchor.current=null;refresh.current();},[editorSelection,score,track,zoom,profile,projection,visibleTracks]);
  useEffect(()=>{if(playback&&api.current)playback.attachView(api.current);},[playback]);
  useEffect(()=>{const view=api.current!;view.settings.display.scale=zoom/100;
    if(engraving)configureEngraving(view.settings,engraving);else view.settings.display.staveProfile=StaveProfile[profile as keyof typeof StaveProfile] as StaveProfile;
    view.updateSettings();playback?.setRenderedScore(renderedScore,tracks);
  },[renderedScore,track,zoom,profile,playback,visibleTracks,engraving]);
  const capture=(event:ReactMouseEvent<HTMLDivElement>)=>{if(event.button!==0)return;event.preventDefault();event.currentTarget.focus({preventScroll:true});modifiers.current={shift:event.shiftKey,toggle:event.ctrlKey||event.metaKey,detail:event.detail};drag.current=null;};
  const resize=(edge:'start'|'end',event:ReactMouseEvent)=>{
    event.preventDefault();event.stopPropagation();if(event.button!==0||!handles||!editorSelection||editorSelection.kind==='notes')return;
    const fixed=handles[edge==='start'?'end':'start'].target;
    drag.current={anchor:fixed,last:handles[edge].target,lanes:editorSelection.kind==='range'?editorSelection.range.lanes:[{track:fixed.track,staff:fixed.staff,voice:fixed.voice}],...(editorSelection.kind==='bars'?{bars:editorSelection}:{})};
  };
  return <div ref={wrapper} tabIndex={-1} style={{position:'relative'}} onMouseDownCapture={capture}>
    <div ref={container} aria-label="Music notation"/>
    {markers.map((marker,index)=><span key={index} role="img" aria-label={`Selected note ${index+1}`} style={{position:'absolute',left:marker.x,top:marker.y,width:marker.w,height:marker.h,boxSizing:'border-box',border:'2px solid #9aaf38',background:'rgba(185,205,105,.3)',borderRadius:3,pointerEvents:'none'}}/>)}
    {handles&&(['start','end'] as const).map(edge=><button key={edge} type="button" aria-label={`Resize selection ${edge}`} onMouseDown={event=>resize(edge,event)} style={{position:'absolute',left:handles[edge].x-6,top:handles[edge].y+handles[edge].h/2-12,width:12,height:24,padding:0,border:'2px solid #60712b',borderRadius:3,background:'#bccf6e',cursor:'ew-resize',zIndex:4}}/>)}
  </div>;
}
