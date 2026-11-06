import { useI18n } from '../i18n';
import {memo,useCallback,useLayoutEffect,useMemo,useRef,useState} from 'react';
import type {ComponentType,CSSProperties,KeyboardEvent,ReactNode} from 'react';
import type {BeatTarget} from '../project';
import {overviewWindow} from './overview';
import type {ScoreOverviewModel} from './overview';
import './score-overview.css';

export interface ScoreOverviewProps {
  model:ScoreOverviewModel;target:BeatTarget;playbackBar:number|null;
  onSelect:(track:number,bar:number)=>void;onExit:()=>void;
  /** Track colours by row; written measures are tinted with their track's colour, as one band per track. */
  colors?:readonly string[];
  /** Mixer controls beside each track name. Row is a stable component type, so clock ticks re-render the controls, not the grid. */
  controls?:{header:ReactNode;Row:ComponentType<{track:number}>};
}
const cellSize=28,baseNameWidth=144,controlsWidth=202;
type Position={track:number;bar:number};
type Window={first:number;last:number};
interface GridContentProps {
  model:ScoreOverviewModel;targetTrack:number;targetBar:number;focused:Position;
  columns:Window;rows:Window;nameWidth:number;colors?:readonly string[];controls?:ScoreOverviewProps['controls'];
  onFocus:(position:Position)=>void;onSelect:(track:number,bar:number)=>void;
}
const GridContent=memo(function GridContent({model,targetTrack,targetBar,focused,columns,rows,nameWidth,colors,controls,onFocus,onSelect}:GridContentProps){
  const { t } = useI18n();
  const bars=Array.from({length:columns.last-columns.first},(_,index)=>columns.first+index);
  const tracks=Array.from({length:rows.last-rows.first},(_,index)=>rows.first+index);
  if(!tracks.includes(focused.track))tracks.push(focused.track);
  return <>
    <div className="score-overview-ruler" role="row" aria-rowindex={1}>
      <div className="score-overview-corner" role="columnheader" style={{width:nameWidth}}><span className="score-overview-corner-label">{t('overview.track_measure')}</span>{controls?.header}</div>
      {bars.map(bar=>{
        const section=model.sections.find(section=>section.bar===bar);
        return <div key={bar} role="columnheader" aria-colindex={bar+2} aria-label={`Measure ${bar+1}${section?`, ${section.text}`:''}`}
          className="score-overview-bar-label" style={{left:nameWidth+bar*cellSize}} title={section?.text}>
          {bar+1}{section&&<span className="score-overview-section">{section.text}</span>}
        </div>;
      })}
    </div>
    {tracks.map(row=>{
      const track=model.tracks[row],visible=row>=rows.first&&row<rows.last;
      const cells=visible?[...bars]:[];
      if(row===focused.track&&!cells.includes(focused.bar))cells.push(focused.bar);
      const Row=controls?.Row,color=colors?.[row];
      return <div key={row} role="row" aria-rowindex={row+2} className="score-overview-row" data-selected-track={targetTrack===track.index||undefined}
        style={{top:cellSize+row*cellSize,...(color?{'--overview-track':color}:{})} as CSSProperties}>
        <div role="rowheader" aria-colindex={1} className="score-overview-track" title={track.name} style={{width:nameWidth}}><span className="score-overview-track-number" aria-hidden="true">{track.index+1}.</span><span className="score-overview-track-name">{track.name}</span>{Row&&<Row track={track.index}/>}</div>
        {cells.map(bar=>{
          const content=track.cells[bar],selected=targetTrack===track.index&&targetBar===bar;
          return <div key={bar} role="gridcell" aria-colindex={bar+2} aria-label={t('overview.cell_label',{track:track.name,measure:bar+1,content})}
            aria-selected={selected} tabIndex={focused.track===row&&focused.bar===bar?0:-1}
            data-overview-track={row} data-overview-bar={bar} data-content={content}
            className="score-overview-cell" style={{left:nameWidth+bar*cellSize}}
            onFocus={()=>onFocus({track:row,bar})} onClick={event=>{event.currentTarget.focus();onSelect(track.index,bar);}}>
            <span className="score-overview-occupancy" aria-hidden="true"/>
          </div>;
        })}
      </div>;
    })}
  </>;
});

export function ScoreOverview({model,target,playbackBar,onSelect,onExit,colors,controls}:ScoreOverviewProps) {
  const nameWidth=controls?baseNameWidth+controlsWidth:baseNameWidth;
  const { t } = useI18n();
  const grid=useRef<HTMLDivElement>(null),pendingFocus=useRef(false);
  const callbacks=useRef({onSelect,onExit});callbacks.current={onSelect,onExit};
  const [retainedFocus,setFocused]=useState<Position>(()=>({track:Math.max(0,model.tracks.findIndex(track=>track.index===target.track)),bar:Math.min(target.bar,model.barCount-1)}));
  // A score can shrink while this mounted grid is hidden; bound focus before its children render.
  const focused=useMemo(()=>({track:Math.min(retainedFocus.track,model.tracks.length-1),bar:Math.min(retainedFocus.bar,model.barCount-1)}),[retainedFocus,model.tracks.length,model.barCount]);
  const [viewport,setViewport]=useState({left:0,top:0,width:0,height:0});
  const readViewport=useCallback(()=>{
    const node=grid.current;if(!node)return;
    setViewport(previous=>({left:node.scrollLeft,top:node.scrollTop,width:node.clientWidth||previous.width,height:node.clientHeight||previous.height}));
  },[]);
  useLayoutEffect(()=>{
    readViewport();const observer=new ResizeObserver(readViewport);observer.observe(grid.current!);return ()=>observer.disconnect();
  },[readViewport]);
  useLayoutEffect(()=>{
    setFocused(previous=>previous.track<model.tracks.length&&previous.bar<model.barCount?previous:{track:Math.min(previous.track,model.tracks.length-1),bar:Math.min(previous.bar,model.barCount-1)});
  },[model]);
  useLayoutEffect(()=>{
    if(!pendingFocus.current)return;
    pendingFocus.current=false;
    grid.current?.querySelector<HTMLElement>(`[data-overview-track="${focused.track}"][data-overview-bar="${focused.bar}"]`)?.focus({preventScroll:true});
  },[focused,viewport]);
  const focusPosition=useCallback((position:Position)=>setFocused(previous=>previous.track===position.track&&previous.bar===position.bar?previous:position),[]);
  const select=useCallback((track:number,bar:number)=>callbacks.current.onSelect(track,bar),[]);
  // Stable ranges let clock-only updates change the single playhead without regenerating grid contents.
  const columns=useMemo(()=>overviewWindow(viewport.left,Math.max(0,viewport.width-nameWidth),model.barCount,cellSize,2),[viewport.left,viewport.width,model.barCount]);
  const rows=useMemo(()=>overviewWindow(viewport.top,Math.max(0,viewport.height-cellSize),model.tracks.length,cellSize,2),[viewport.top,viewport.height,model.tracks.length]);
  function keyDown(event:KeyboardEvent<HTMLDivElement>) {
    if(event.altKey||event.ctrlKey||event.metaKey||event.shiftKey)return;
    if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','Enter',' ','Escape'].includes(event.key))return;
    event.preventDefault();event.stopPropagation();
    if(event.key==='Escape'){callbacks.current.onExit();return;}
    if(event.key==='Enter'||event.key===' '){select(model.tracks[focused.track].index,focused.bar);return;}
    const next={...focused};
    if(event.key==='ArrowLeft')next.bar=Math.max(0,next.bar-1);
    if(event.key==='ArrowRight')next.bar=Math.min(model.barCount-1,next.bar+1);
    if(event.key==='ArrowUp')next.track=Math.max(0,next.track-1);
    if(event.key==='ArrowDown')next.track=Math.min(model.tracks.length-1,next.track+1);
    if(event.key==='Home')next.bar=0;
    if(event.key==='End')next.bar=model.barCount-1;
    const node=grid.current!;
    const width=Math.max(cellSize,node.clientWidth-nameWidth),height=Math.max(cellSize,node.clientHeight-cellSize);
    if(next.bar*cellSize<node.scrollLeft)node.scrollLeft=next.bar*cellSize;
    else if((next.bar+1)*cellSize>node.scrollLeft+width)node.scrollLeft=(next.bar+1)*cellSize-width;
    if(next.track*cellSize<node.scrollTop)node.scrollTop=next.track*cellSize;
    else if((next.track+1)*cellSize>node.scrollTop+height)node.scrollTop=(next.track+1)*cellSize-height;
    pendingFocus.current=true;focusPosition(next);readViewport();
  }
  const playing=playbackBar!==null&&Number.isInteger(playbackBar)&&playbackBar>=0&&playbackBar<model.barCount;
  return <div ref={grid} role="grid" aria-label={t('overview.written_measure_overview')} aria-rowcount={model.tracks.length+1} aria-colcount={model.barCount+1}
    className="score-overview" onScroll={readViewport} onKeyDown={keyDown}>
    <div className="score-overview-content" style={{width:nameWidth+model.barCount*cellSize,height:(model.tracks.length+1)*cellSize}}>
      <GridContent model={model} targetTrack={target.track} targetBar={target.bar} focused={focused} columns={columns} rows={rows}
        nameWidth={nameWidth} colors={colors} controls={controls} onFocus={focusPosition} onSelect={select}/>
      {playing&&<div role="img" aria-label={t('overview.playback_measure',{measure:playbackBar+1})} className="score-overview-playhead"
        style={{left:nameWidth+playbackBar*cellSize,height:model.tracks.length*cellSize}}/>}
    </div>
  </div>;
}
