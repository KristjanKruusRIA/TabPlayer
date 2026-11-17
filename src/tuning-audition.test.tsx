// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TrackSettingsPanel } from './workstation/TrackSettingsPanel';
import { AddTrackDialog } from './workstation/AddTrackDialog';
import { SavedTuningsDialog } from './tuning/SavedTuningsDialog';
import { buildScore, trackIdentity } from './engine';
import { blankProject } from './project';
import { tuningAudition } from './audio/audition';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(async()=>({format:'tabplayer-tuning-library',version:1,entries:[]}))}));
afterEach(cleanup);
const standard=[64,59,55,50,45,40];
it('turns a strum into the exact low-to-high payload',()=>{
  expect(tuningAudition(standard,true).notes.map(note=>[note.key,note.startMs])).toEqual([[40,0],[45,60],[50,120],[55,180],[59,240],[64,300]]);
  expect(tuningAudition([40],false)).toEqual({notes:[{key:40,startMs:0,velocity:96}],durationMs:1500});
});
it('auditions the addressed track for its tuning and the default sound of the chosen program for a new track',()=>{
  const score=buildScore(blankProject()),onAudition=vi.fn(),id=trackIdentity(score.tracks[0]);
  render(<TrackSettingsPanel score={score} selected={0} busy={false} onEdit={vi.fn()} onAudition={onAudition}/>);
  // The sidebar row plays the saved tuning; the dialog plays the draft, string by string.
  fireEvent.click(within(document.querySelector('.track-tuning-row') as HTMLElement).getByRole('button',{name:'Play tuning'}));expect(onAudition).toHaveBeenLastCalledWith({trackId:id},standard,true);
  fireEvent.click(screen.getByRole('button',{name:/^Edit tuning/}));const tuningDialog=within(screen.getByRole('dialog',{name:'Tuning'}));
  fireEvent.click(tuningDialog.getByRole('button',{name:'Play string 6 (E2)'}));expect(onAudition).toHaveBeenLastCalledWith({trackId:id},[40],false);
  fireEvent.click(tuningDialog.getByRole('button',{name:'Play tuning'}));expect(onAudition).toHaveBeenLastCalledWith({trackId:id},standard,true);
  fireEvent.click(tuningDialog.getByRole('button',{name:'Cancel'}));
  fireEvent.click(screen.getAllByRole('button',{name:'Play tuning'})[0]);expect(onAudition).toHaveBeenLastCalledWith({trackId:id},standard,true);
  render(<AddTrackDialog busy={false} onAdd={vi.fn()} onAudition={onAudition} onClose={vi.fn()}/>);fireEvent.change(screen.getByLabelText('MIDI instrument'),{target:{value:'33'}});
  const newRow=screen.getByRole('dialog',{name:'Add track'}).querySelector('.track-tuning-row') as HTMLElement;
  fireEvent.click(within(newRow).getByRole('button',{name:'Play tuning'}));expect(onAudition).toHaveBeenLastCalledWith({program:33},[43,38,33,28],true);
  fireEvent.click(within(newRow).getByRole('button',{name:/^Edit new track tuning/}));const newDialog=within(screen.getByRole('dialog',{name:'Tuning'}));
  fireEvent.click(newDialog.getByRole('button',{name:'Play string 4 (E1)'}));expect(onAudition).toHaveBeenLastCalledWith({program:33},[28],false);
  fireEvent.click(newDialog.getByRole('button',{name:'Play tuning'}));expect(onAudition).toHaveBeenLastCalledWith({program:33},[43,38,33,28],true);
});
it('plays the details pitches of the saved-tunings dialog',()=>{
  const onAudition=vi.fn();render(<SavedTuningsDialog notes="E4 B3 G3 D3 A2 E2" name="" onUse={vi.fn()} onClose={vi.fn()} onAudition={onAudition}/>);
  const dialog=screen.getByRole('dialog');fireEvent.click(within(dialog).getByRole('button',{name:'Play string 5 (A2)'}));expect(onAudition).toHaveBeenLastCalledWith([45],false);
  fireEvent.change(within(dialog).getByLabelText('Saved tuning pitches (notes, high to low)'),{target:{value:'D4 A3 F3 C3'}});
  fireEvent.click(within(dialog).getByRole('button',{name:'Play tuning'}));expect(onAudition).toHaveBeenLastCalledWith([62,57,53,48],true);
});
