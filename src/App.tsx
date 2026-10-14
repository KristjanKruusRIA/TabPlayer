import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import type { model } from '@coderline/alphatab';
import { DocumentController } from './controller';
import { describeSelection } from './engine';
import type { BeatTarget, EditCommand } from './project';
import { ScoreView } from './ScoreView';
import { EditorPanel } from './EditorPanel';
import { TrackPanel } from './TrackPanel';
import './styles.css';
import { PlaybackController } from './playback';
import { Transport } from './Transport';

function repair(score: model.Score, target: BeatTarget): BeatTarget {
  const track=Math.min(target.track,score.tracks.length-1);
  const staff=Math.min(target.staff,score.tracks[track].staves.length-1);
  const bar=Math.min(target.bar,score.masterBars.length-1);
  const voice=Math.min(target.voice,score.tracks[track].staves[staff].bars[bar].voices.length-1);
  const beats=score.tracks[track].staves[staff].bars[bar].voices[voice].beats;
  return {track,staff,bar,voice,beat:Math.max(0,Math.min(target.beat,beats.length-1))};
}

export function App({controller}: {controller: DocumentController}) {
  const state=useSyncExternalStore(controller.subscribe,controller.getState);
  const [player,setPlayer]=useState<PlaybackController|null>(null);
  const [documentRevision,setDocumentRevision]=useState(0);
  useEffect(()=>{controller.setBeforeChange(()=>player?.beforeScoreChange());return()=>controller.setBeforeChange(()=>{});},[controller,player]);
  const [selection,setSelection]=useState<BeatTarget>({track:0,staff:0,bar:0,voice:0,beat:0});
  const [selectedString,setString]=useState(6); const [fret,setFret]=useState(0);
  const [zoom,setZoom]=useState(100); const [profile,setProfile]=useState('ScoreTab');
  const digits=useRef({text:'',time:0});
  const target=repair(state.score,selection);
  const location=describeSelection(state.score,target);
  const string=Math.max(1,Math.min(selectedString,location.staff.tuning.length));
  const act=(job: Promise<unknown>)=>{void job.catch(()=>{});};
  const change=(job:Promise<unknown>)=>act(job.then(()=>setSelection(old=>repair(controller.getState().score,old))));
  const edit=(command:EditCommand)=>change(controller.edit(command));
  const documentAction=(job:Promise<unknown>)=>change(job.then(()=>{if(controller.getState().score!==state.score){player?.resetMix();setDocumentRevision(v=>v+1);}}));
  const select=(next:BeatTarget,s=string)=>{
    const fixed=repair(state.score,next);setSelection(fixed);
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
    <button disabled={state.busy} onClick={()=>act(controller.export())}>Export GP</button></header>
    {state.error && <div className="error" role="alert">{state.error}</div>}
    <div className="workspace">
      <TrackPanel key={documentRevision} score={state.score} selected={target.track} busy={state.busy} player={player} onSelect={track=>select({track,staff:0,bar:target.bar,voice:0,beat:0},state.score.tracks[track].staves[0].tuning.length)} onEdit={edit}/>
      <section className="score-workspace" aria-label="Score workspace" tabIndex={0} onKeyDown={keys}>
        <div className="score-tools"><span>{state.score.masterBars.length} measures · {state.score.tracks.length} tracks</span>
          <label>View<select value={profile} onChange={e=>setProfile(e.target.value)}><option>ScoreTab</option><option>Tab</option><option>Score</option></select></label>
          <label>Zoom<select value={zoom} onChange={e=>setZoom(Number(e.target.value))}>{[70,85,100,115,130].map(z=><option key={z} value={z}>{z}%</option>)}</select></label>
        </div>
        <div className="paper-scroll"><div className="paper"><ScoreView score={state.score} track={target.track} zoom={zoom} profile={profile} onSelect={select} onPlayback={setPlayer}/></div></div>
        <div className="score-hint">Measure {target.bar+1} · Beat {target.beat+1} · String {string} · Fret {fret} — Click the score, then use arrow keys, digits and Enter.</div>
      </section>
      <EditorPanel score={state.score} target={target} string={string} fret={fret} busy={state.busy} onSelect={select} onString={s=>select(target,s)} onFret={setFret} onEdit={edit}/>
    </div>
    {player && <Transport key={state.snapshot.project.edits.length} player={player} measures={state.score.masterBars.length} busy={state.busy}/>}
    <footer className="statusbar">{state.busy?'Working…':state.snapshot.dirty?'Unsaved changes':'Saved'}<span>{state.snapshot.path ?? 'Save a .tabplayer project to keep the original score and edits.'}</span></footer>
  </div>;
}
