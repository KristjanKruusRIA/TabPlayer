// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { previewEdit, trackIdentity } from '../engine';
import { blankProject } from '../project';
import { tuningPresets } from '../tuning-presets';
import { formatTuning } from '../tuning';
import { TrackSettingsPanel } from './TrackSettingsPanel';
import { trackColorHex } from '../track-color';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(async()=>({format:'tabplayer-tuning-library',version:1,entries:[]}))}));
afterEach(cleanup);
const standard=[64,59,55,50,45,40];
it('all 128 programs are selectable, and name, short name and instrument each record one edit when left, none when unchanged',()=>{
  const score=previewEdit(blankProject(),{type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},string:6,fret:3}).score,onEdit=vi.fn();
  render(<TrackSettingsPanel score={score} selected={0} busy={false} onEdit={onEdit}/>);
  const track=score.tracks[0],select=screen.getByLabelText('Track MIDI instrument');expect(select.querySelectorAll('option')).toHaveLength(128);
  const name=screen.getByLabelText('Track name'),short=screen.getByLabelText('Track short name');
  fireEvent.focus(name);fireEvent.blur(name);fireEvent.blur(short);expect(onEdit).not.toHaveBeenCalled();
  fireEvent.change(name,{target:{value:'Lead'}});expect(onEdit).not.toHaveBeenCalled();fireEvent.blur(name);
  expect(onEdit).toHaveBeenCalledTimes(1);expect(onEdit).toHaveBeenLastCalledWith({type:'setTrackInfo',track:0,name:'Lead',shortName:track.shortName,program:track.playbackInfo.program});
  fireEvent.change(short,{target:{value:'Ld'}});fireEvent.keyDown(short,{key:'Enter'});
  expect(onEdit).toHaveBeenCalledTimes(2);expect(onEdit).toHaveBeenLastCalledWith({type:'setTrackInfo',track:0,name:track.name,shortName:'Ld',program:track.playbackInfo.program});
  fireEvent.change(select,{target:{value:'127'}});
  expect(onEdit).toHaveBeenCalledTimes(3);expect(onEdit).toHaveBeenLastCalledWith({type:'setTrackInfo',track:0,name:track.name,shortName:track.shortName,program:127});
  fireEvent.change(select,{target:{value:String(track.playbackInfo.program)}});expect(onEdit).toHaveBeenCalledTimes(3);
});
it('keeps full long track names accessible and selected/remove/notation command payloads intact',()=>{
  const name='Lead guitar with a deliberately long descriptive name for the live arrangement';
  const added=previewEdit(blankProject(),{type:'addTrack',name,tuning:[64,59,55,50,45,40],program:24}),onEdit=vi.fn();
  render(<TrackSettingsPanel score={added.score} selected={1} busy={false} onEdit={onEdit}/>);
  expect(screen.getByLabelText('Track name')).toHaveValue(name);
  fireEvent.click(screen.getByRole('button',{name:'Remove track'}));expect(onEdit).toHaveBeenLastCalledWith({type:'removeTrack',track:1});
  // The arrows choose the neighbouring track (Ctrl+Up and Ctrl+Down); reordering is in the Track menu. The last of two tracks has no next one.
  const next=screen.getByRole('button',{name:'Next track'}),onStepTrack=vi.fn();
  expect(next).toHaveAttribute('aria-disabled','true');expect(next).not.toBeDisabled();expect(next).toHaveAttribute('title',expect.stringContaining('last track'));
  cleanup();render(<TrackSettingsPanel score={added.score} selected={1} busy={false} onEdit={onEdit} onStepTrack={onStepTrack}/>);
  fireEvent.click(screen.getByRole('button',{name:'Previous track'}));expect(onStepTrack).toHaveBeenLastCalledWith(-1);fireEvent.click(screen.getByRole('button',{name:'Next track'}));expect(onStepTrack).toHaveBeenCalledTimes(1);
  cleanup();render(<TrackSettingsPanel score={added.score} selected={0} busy={false} onEdit={onEdit} onStepTrack={onStepTrack}/>);
  expect(screen.getByRole('button',{name:'Previous track'})).toHaveAttribute('aria-disabled','true');
  fireEvent.click(screen.getByRole('button',{name:'Next track'}));expect(onStepTrack).toHaveBeenLastCalledWith(1);
  expect(screen.queryByRole('button',{name:/^Move track/})).toBeNull();expect(onEdit).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button',{name:'Duplicate track'}));expect(onEdit).toHaveBeenLastCalledWith({type:'duplicateTrack',track:0});
  const color=screen.getByLabelText('Track color');expect(color).toHaveValue(trackColorHex(added.score.tracks[0].color));
  const before=onEdit.mock.calls.length;fireEvent.change(color,{target:{value:trackColorHex(added.score.tracks[0].color)}});expect(onEdit).toHaveBeenCalledTimes(before);
  fireEvent.change(color,{target:{value:'#ff8800'}});expect(onEdit).toHaveBeenLastCalledWith({type:'setTrackColor',track:0,color:'#ff8800'});
  // Another track shows its own color, and an unchanged color can't be applied as an empty Undo step.
  const recolored=previewEdit(added.project,{type:'setTrackColor',track:1,color:'#00ff00'}).score;cleanup();render(<TrackSettingsPanel score={recolored} selected={1} busy={false} onEdit={onEdit}/>);
  expect(screen.getByLabelText('Track color')).toHaveValue('#00ff00');const calls=onEdit.mock.calls.length;fireEvent.change(screen.getByLabelText('Track color'),{target:{value:'#00ff00'}});expect(onEdit).toHaveBeenCalledTimes(calls);
});
const rest=()=>previewEdit(blankProject(),{type:'setRest',target:{track:0,staff:0,bar:0,voice:0,beat:0}}).score;
const edit=()=>screen.getByRole('button',{name:/^Edit tuning/});
const dialog=()=>screen.getByRole('dialog',{name:'Tuning'});
const notes=()=>within(dialog()).getByLabelText('Notes, high to low') as HTMLInputElement;
const inDialog=(name:string|RegExp)=>within(dialog()).getByRole('button',{name});
const select=(label:string,value:string)=>fireEvent.change(within(dialog()).getByLabelText(label),{target:{value}});
it('shows the tuning as one row: a button with the notes and a play button, and a dialog opens from it',()=>{
  const onAudition=vi.fn(),score=rest(),id=trackIdentity(score.tracks[0]);
  render(<TrackSettingsPanel score={score} selected={0} busy={false} onEdit={vi.fn()} onAudition={onAudition}/>);
  expect(edit()).toHaveTextContent('E4 B3 G3 D3 A2 E2');expect(screen.queryByLabelText('Tuning preset')).toBeNull();expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(within(document.querySelector('.track-tuning-row') as HTMLElement).getByRole('button',{name:'Play tuning'}));expect(onAudition).toHaveBeenLastCalledWith({trackId:id},standard,true);
  edit().focus();fireEvent.click(edit());expect(dialog()).toBeInTheDocument();expect(notes()).toHaveValue('E4 B3 G3 D3 A2 E2');
});
it('puts the four track actions in one row of named icon buttons with Remove set apart',()=>{
  const score=previewEdit(blankProject(),{type:'addTrack',name:'Bass',tuning:[43,38,33,28],program:33}).score;
  render(<TrackSettingsPanel score={score} selected={0} busy={false} onEdit={vi.fn()}/>);
  const row=screen.getByRole('group',{name:'Track actions'});
  const names=within(row).getAllByRole('button').map(button=>button.getAttribute('aria-label'));
  expect(names).toEqual(['Previous track','Next track','Duplicate track','Remove track']);
  // At the first track the Previous button is still a focusable button; its tooltip says why it does nothing.
  for(const button of within(row).getAllByRole('button'))expect(button.getAttribute('title')!.startsWith(button.getAttribute('aria-label')!)).toBe(true);
  expect(within(row).getByRole('button',{name:'Previous track'})).toHaveAttribute('title','Previous track (this is the first track)');
  expect(within(row).getByRole('button',{name:'Remove track'})).toHaveClass('track-remove');expect(row.querySelector('.track-actions-gap')).not.toBeNull();
});
it('records nothing until Keep fingering: Cancel and Escape discard, and focus returns to the Edit button',()=>{
  const onEdit=vi.fn();render(<TrackSettingsPanel score={rest()} selected={0} busy={false} onEdit={onEdit}/>);
  edit().focus();fireEvent.click(edit());fireEvent.change(notes(),{target:{value:'E4 B3 G3 D3 A2 D2'}});fireEvent.click(inDialog('Cancel'));
  expect(screen.queryByRole('dialog')).toBeNull();expect(onEdit).not.toHaveBeenCalled();expect(edit()).toHaveFocus();expect(edit()).toHaveTextContent('E4 B3 G3 D3 A2 E2');
  fireEvent.click(edit());expect(notes()).toHaveValue('E4 B3 G3 D3 A2 E2');fireEvent.change(notes(),{target:{value:'E4 B3 G3 D3 A2 D2'}});fireEvent.keyDown(document,{key:'Escape'});
  expect(screen.queryByRole('dialog')).toBeNull();expect(onEdit).not.toHaveBeenCalled();expect(edit()).toHaveFocus();
  fireEvent.click(edit());fireEvent.change(notes(),{target:{value:'E4 B3 G3 D3 A2 D2'}});fireEvent.click(inDialog('Keep fingering'));
  expect(onEdit).toHaveBeenCalledTimes(1);expect(onEdit).toHaveBeenLastCalledWith({type:'setTuning',track:0,tuning:[64,59,55,50,45,38],tuningName:''});expect(screen.queryByRole('dialog')).toBeNull();expect(edit()).toHaveFocus();
});
it('Keep pitch sends keepPitch, and applying the current tuning and name records nothing either way',()=>{
  const onEdit=vi.fn();render(<TrackSettingsPanel score={rest()} selected={0} busy={false} onEdit={onEdit}/>);
  fireEvent.click(edit());fireEvent.click(inDialog('Keep fingering'));fireEvent.click(edit());fireEvent.click(inDialog('Keep pitch'));expect(onEdit).not.toHaveBeenCalled();expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(edit());fireEvent.change(notes(),{target:{value:'E4 B3 G3 D3 A2 D2'}});fireEvent.click(inDialog('Keep pitch'));
  expect(onEdit).toHaveBeenCalledTimes(1);expect(onEdit).toHaveBeenLastCalledWith({type:'setTuning',track:0,tuning:[64,59,55,50,45,38],tuningName:'',keepPitch:true});
});
it('Enter in the notes field keeps the fingering, and a note that does not parse keeps the dialog open with its message',()=>{
  const onEdit=vi.fn();render(<TrackSettingsPanel score={rest()} selected={0} busy={false} onEdit={onEdit}/>);
  fireEvent.click(edit());fireEvent.change(notes(),{target:{value:'E4 B3 nope'}});fireEvent.submit(notes().closest('form')!);
  expect(onEdit).not.toHaveBeenCalled();expect(dialog()).toBeInTheDocument();expect(notes()).toHaveFocus();expect(notes()).toHaveAttribute('aria-invalid','true');
  const alert=within(dialog()).getByRole('alert');expect(alert).toHaveTextContent(/nope|note.*octave/i);expect(notes()).toHaveAttribute('aria-describedby',alert.id);
  fireEvent.change(notes(),{target:{value:'E4 B3 G3 D3 A2 D2'}});expect(notes()).not.toHaveAttribute('aria-invalid');fireEvent.submit(notes().closest('form')!);
  expect(onEdit).toHaveBeenLastCalledWith({type:'setTuning',track:0,tuning:[64,59,55,50,45,38],tuningName:''});
});
it('each string has a row with a note you can step or type, and its own play button; steps change the draft only',()=>{
  const onEdit=vi.fn(),onAudition=vi.fn();render(<TrackSettingsPanel score={rest()} selected={0} busy={false} onEdit={onEdit} onAudition={onAudition}/>);
  fireEvent.click(edit());
  fireEvent.click(inDialog('Lower string 6 a semitone'));expect(notes()).toHaveValue('E4 B3 G3 D3 A2 D#2');expect(onEdit).not.toHaveBeenCalled();
  fireEvent.click(inDialog('Raise string 1 a semitone'));expect(notes()).toHaveValue('F4 B3 G3 D3 A2 D#2');
  const row=within(dialog()).getByLabelText('String 6 note');fireEvent.change(row,{target:{value:'D2'}});fireEvent.blur(row);expect(notes()).toHaveValue('F4 B3 G3 D3 A2 D2');
  fireEvent.change(row,{target:{value:'zz'}});fireEvent.blur(row);expect(row).toHaveValue('zz');fireEvent.keyDown(row,{key:'ArrowDown'});fireEvent.keyDown(row,{key:'ArrowUp'});expect(row).toHaveValue('D2');
  fireEvent.keyDown(row,{key:'ArrowUp'});expect(notes()).toHaveValue('F4 B3 G3 D3 A2 D#2');
  expect(within(dialog()).getAllByRole('button',{name:/^Play string/})).toHaveLength(6);
  fireEvent.click(inDialog('Play string 6 (D#2)'));expect(onAudition).toHaveBeenLastCalledWith({trackId:expect.anything()},[39],false);
  fireEvent.click(inDialog('Play tuning'));expect(onAudition).toHaveBeenLastCalledWith({trackId:expect.anything()},[65,59,55,50,45,39],true);
  expect(onEdit).not.toHaveBeenCalled();
});
it('retains all 25 guitar 6-9 and bass 4-6 presets and the other instruments through the Library selects, filling the draft and its name',()=>{
  const onEdit=vi.fn();render(<TrackSettingsPanel score={rest()} selected={0} busy={false} onEdit={onEdit}/>);
  expect(tuningPresets.filter(p=>p.instrument==='guitar'||p.instrument==='bass')).toHaveLength(25);expect(tuningPresets).toHaveLength(46);
  expect(new Set(tuningPresets.filter(p=>p.instrument==='guitar').map(p=>p.strings))).toEqual(new Set([6,7,8,9]));
  expect(new Set(tuningPresets.filter(p=>p.instrument==='bass').map(p=>p.strings))).toEqual(new Set([4,5,6]));
  fireEvent.click(edit());
  for(const preset of tuningPresets){
    select('Instrument',preset.instrument);select('Number of strings',String(preset.strings));select('Preset',preset.id);
    expect(notes()).toHaveValue(formatTuning(preset.tuning));expect(within(dialog()).getByLabelText('Preset')).toHaveValue(preset.id);
  }
  expect(onEdit).not.toHaveBeenCalled();
  select('Instrument','guitar');select('Number of strings','6');select('Preset','guitar-6-open-d');fireEvent.click(inDialog(/^Keep fingering/));
  expect(onEdit).toHaveBeenLastCalledWith({type:'setTuning',track:0,tuning:[62,57,54,50,45,38],tuningName:'Open D'});
});
it('shows Custom for notes no preset has and drop D one octave down is exactly that',()=>{
  const score=previewEdit(blankProject(),{type:'setTuning',track:0,tuning:[52,47,43,38,33,26]}).score;
  render(<TrackSettingsPanel score={score} selected={0} busy={false} onEdit={vi.fn()}/>);
  expect(edit()).toHaveTextContent('E3 B2 G2 D2 A1 D1');fireEvent.click(edit());expect(within(dialog()).getByLabelText('Preset')).toHaveValue('custom');
});
it('changes the string count with an explicit kept side, and the engine keeps note pitches',()=>{
  const project=previewEdit(blankProject(),{type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},string:6,fret:3}),onEdit=vi.fn();
  render(<TrackSettingsPanel score={project.score} selected={0} busy={false} onEdit={onEdit}/>);
  fireEvent.click(edit());expect(within(dialog()).queryByLabelText('Strings kept in place')).toBeNull();expect(within(dialog()).queryByRole('button',{name:'Keep pitch'})).not.toBeNull();
  fireEvent.change(notes(),{target:{value:'E4 B3 G3 D3 A2 E2 B1'}});
  expect(within(dialog()).getByRole('group',{name:'6 to 7 strings'})).toBeInTheDocument();expect(within(dialog()).queryByRole('button',{name:'Keep pitch'})).toBeNull();
  fireEvent.click(inDialog('Change string count'));
  expect(onEdit).toHaveBeenLastCalledWith({type:'setStringCount',track:0,tuning:[64,59,55,50,45,40,35],keep:'high',tuningName:'',crossVoice:true});
  cleanup();render(<TrackSettingsPanel score={project.score} selected={0} busy={false} onEdit={onEdit}/>);
  fireEvent.click(edit());fireEvent.change(notes(),{target:{value:'A4 E4 B3 G3 D3 A2 E2'}});fireEvent.change(within(dialog()).getByLabelText('Strings kept in place'),{target:{value:'low'}});fireEvent.click(inDialog('Change string count'));
  expect(onEdit).toHaveBeenLastCalledWith({type:'setStringCount',track:0,tuning:[69,64,59,55,50,45,40],keep:'low',tuningName:'',crossVoice:true});
  const before=project.score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].realValue;
  const seven=previewEdit(project.project,{type:'setStringCount',track:0,tuning:[64,59,55,50,45,40,35],keep:'high',tuningName:''}),note=seven.score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0];
  expect([seven.score.tracks[0].staves[0].tuning.length,note.string,note.fret,note.realValue]).toEqual([7,7,3,before]);
  expect(seven.project.edits.at(-1)).toEqual({type:'setStringCount',track:0,tuning:[64,59,55,50,45,40,35],keep:'high',tuningName:''});
});
it('Saved tunings opens over the dialog: Escape closes only it, Use supplies the name, and Keep fingering sends it',()=>{
  const score=rest();score.tracks[0].staves[0].stringTuning.name='Imported';const onEdit=vi.fn();
  render(<TrackSettingsPanel score={score} selected={0} busy={false} onEdit={onEdit}/>);
  fireEvent.click(edit());fireEvent.change(notes(),{target:{value:'E4 B3 G3 D3 A2 D2'}});
  inDialog('Saved tunings…').focus();fireEvent.click(inDialog('Saved tunings…'));const saved=screen.getByRole('dialog',{name:'Saved tunings'});expect(saved).toBeInTheDocument();
  fireEvent.keyDown(document,{key:'Escape'});expect(screen.queryByRole('dialog',{name:'Saved tunings'})).toBeNull();expect(dialog()).toBeInTheDocument();expect(notes()).toHaveValue('E4 B3 G3 D3 A2 D2');expect(inDialog('Saved tunings…')).toHaveFocus();
  fireEvent.click(inDialog('Saved tunings…'));
  fireEvent.click(within(within(screen.getByRole('dialog',{name:'Saved tunings'})).getByRole('group',{name:'Guitar · 6 strings'})).getByRole('button',{name:/^DADGAD/}));fireEvent.click(screen.getByRole('button',{name:'Use tuning'}));
  expect(notes()).toHaveValue('D4 A3 G3 D3 A2 D2');expect(onEdit).not.toHaveBeenCalled();
  fireEvent.click(inDialog('Keep fingering'));expect(onEdit).toHaveBeenLastCalledWith({type:'setTuning',track:0,tuning:[62,57,55,50,45,38],tuningName:'DADGAD'});
});
it('a string-count change sends the draft tuning name and the draft starts again from the new staff',()=>{
  const fresh=(name:string)=>{const score=rest();score.tracks[0].staves[0].stringTuning.name=name;return score;},onEdit=vi.fn();
  const view=render(<TrackSettingsPanel score={fresh('Imported')} selected={0} busy={false} onEdit={onEdit}/>);
  fireEvent.click(edit());fireEvent.change(notes(),{target:{value:'E4 B3 G3 D3 A2 E2 B1'}});fireEvent.click(inDialog('Change string count'));
  expect(onEdit).toHaveBeenLastCalledWith({type:'setStringCount',track:0,tuning:[64,59,55,50,45,40,35],keep:'high',tuningName:'',crossVoice:true});
  view.rerender(<TrackSettingsPanel score={fresh('Other')} selected={0} busy={false} onEdit={onEdit}/>);fireEvent.click(edit());fireEvent.click(inDialog('Keep fingering'));
  expect(onEdit).toHaveBeenCalledTimes(1);
});
it('the dialog stays open with its draft when the edit is refused and closes when it lands',async()=>{
  let settle:(landed:boolean)=>void=()=>{};const onEdit=vi.fn(()=>new Promise<boolean>(resolve=>{settle=resolve;}));
  render(<TrackSettingsPanel score={rest()} selected={0} busy={false} onEdit={onEdit}/>);
  edit().focus();fireEvent.click(edit());fireEvent.change(notes(),{target:{value:'E4 B3 G3 D3 A2 D2'}});fireEvent.click(inDialog('Keep fingering'));fireEvent.click(inDialog('Keep fingering'));
  expect(onEdit).toHaveBeenCalledTimes(1);await act(async()=>{settle(false);});expect(dialog()).toBeInTheDocument();expect(notes()).toHaveValue('E4 B3 G3 D3 A2 D2');
  fireEvent.click(inDialog('Keep fingering'));await act(async()=>{settle(true);});await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());expect(edit()).toHaveFocus();
});
it('tuning readback refreshes after same-index history replacement',()=>{
  const before=previewEdit(blankProject(),{type:'setTuning',track:0,tuning:[64,59,55,50,45,38]}).score,onEdit=vi.fn();const props={selected:0,busy:false,onEdit};const view=render(<TrackSettingsPanel {...props} score={before}/>);expect(edit()).toHaveTextContent('E4 B3 G3 D3 A2 D2');
  view.rerender(<TrackSettingsPanel {...props} score={rest()}/>);expect(edit()).toHaveTextContent('E4 B3 G3 D3 A2 E2');
});
it('disables the tuning button for percussion and a finalized score, and keeps it focusable with aria-disabled while busy',()=>{
  const score=rest(),props={score,selected:0,onEdit:vi.fn()};const view=render(<TrackSettingsPanel {...props} busy={false}/>);
  edit().focus();view.rerender(<TrackSettingsPanel {...props} busy/>);expect(edit()).not.toBeDisabled();expect(edit()).toHaveAttribute('aria-disabled','true');expect(edit()).toHaveFocus();fireEvent.click(edit());expect(screen.queryByRole('dialog')).toBeNull();
  view.rerender(<TrackSettingsPanel {...props} busy={false} locked/>);expect(edit()).toBeDisabled();
  view.rerender(<TrackSettingsPanel {...props} busy={false}/>);score.tracks[0].staves[0].isPercussion=true;view.rerender(<TrackSettingsPanel {...props} busy={false}/>);expect(screen.getByRole('button',{name:'No tuning'})).toBeDisabled();
});
it('disables removal for the sole track, and the actions keep focus and refuse presses while busy',()=>{
  const score=rest();const onEdit=vi.fn();
  const view=render(<TrackSettingsPanel score={score} selected={0} busy={false} onEdit={onEdit}/>);
  expect(screen.getByRole('button',{name:'Remove track'})).toBeDisabled();
  const dup=screen.getByRole('button',{name:'Duplicate track'});dup.focus();view.rerender(<TrackSettingsPanel score={score} selected={0} busy onEdit={onEdit}/>);
  expect(dup).toHaveFocus();expect(dup).not.toBeDisabled();expect(dup).toHaveAttribute('aria-disabled','true');fireEvent.click(dup);expect(onEdit).not.toHaveBeenCalled();
  expect(onEdit).not.toHaveBeenCalled();
});

const named=(name:string)=>{const score=rest();score.tracks[0].staves[0].stringTuning.name=name;return score;};
it('a note typed wrongly into a string row is not dropped: it shows its error, blocks applying, and steps put it right',()=>{
  const onEdit=vi.fn();render(<TrackSettingsPanel score={rest()} selected={0} busy={false} onEdit={onEdit}/>);
  fireEvent.click(edit());const row=within(dialog()).getByLabelText('String 6 note');
  fireEvent.change(row,{target:{value:'H9'}});fireEvent.blur(row);
  expect(within(dialog()).getByRole('alert')).toHaveTextContent(/String 6.*H9/);expect(notes()).toHaveValue('E4 B3 G3 D3 A2 E2');
  fireEvent.click(inDialog('Keep pitch'));fireEvent.click(inDialog('Keep fingering'));expect(onEdit).not.toHaveBeenCalled();expect(dialog()).toBeInTheDocument();
  fireEvent.change(row,{target:{value:'D2'}});fireEvent.blur(row);expect(within(dialog()).queryByRole('alert')).toBeNull();expect(notes()).toHaveValue('E4 B3 G3 D3 A2 D2');
  fireEvent.click(inDialog('Keep fingering'));expect(onEdit).toHaveBeenCalledTimes(1);
});
it('a step that changes nothing leaves the draft and its name alone, and a draft equal to the document records nothing',()=>{
  const onEdit=vi.fn();render(<TrackSettingsPanel score={named('Imported')} selected={0} busy={false} onEdit={onEdit}/>);
  fireEvent.click(edit());const row=within(dialog()).getByLabelText('String 1 note');
  fireEvent.keyDown(row,{key:'ArrowUp'});fireEvent.keyDown(row,{key:'ArrowDown'});expect(notes()).toHaveValue('E4 B3 G3 D3 A2 E2');
  fireEvent.click(inDialog('Keep fingering'));expect(onEdit).not.toHaveBeenCalled();
  fireEvent.click(edit());fireEvent.change(notes(),{target:{value:'E4  B3 G3 D3 A2 E2'}});fireEvent.click(inDialog('Keep pitch'));expect(onEdit).not.toHaveBeenCalled();
  // At the top limit an arrow is not a change either.
  cleanup();const top=previewEdit(blankProject(),{type:'setTuning',track:0,tuning:[127,59,55,50,45,40],tuningName:'Imported'}).score;
  render(<TrackSettingsPanel score={top} selected={0} busy={false} onEdit={onEdit}/>);fireEvent.click(edit());
  fireEvent.keyDown(within(dialog()).getByLabelText('String 1 note'),{key:'ArrowUp'});fireEvent.keyDown(within(dialog()).getByLabelText('String 1 note'),{key:'PageUp'});expect(notes()).toHaveValue('G9 B3 G3 D3 A2 E2');
  fireEvent.click(inDialog('Keep fingering'));expect(onEdit).not.toHaveBeenCalled();
});
it('Page keys step an octave and the wheel steps a focused note',()=>{
  render(<TrackSettingsPanel score={rest()} selected={0} busy={false} onEdit={vi.fn()}/>);fireEvent.click(edit());
  const row=within(dialog()).getByLabelText('String 6 note');
  fireEvent.keyDown(row,{key:'PageUp'});expect(notes()).toHaveValue('E4 B3 G3 D3 A2 E3');fireEvent.keyDown(row,{key:'PageDown'});expect(notes()).toHaveValue('E4 B3 G3 D3 A2 E2');
  fireEvent.keyDown(row,{key:'ArrowUp',shiftKey:true});expect(notes()).toHaveValue('E4 B3 G3 D3 A2 E3');fireEvent.keyDown(row,{key:'ArrowDown',shiftKey:true});
  fireEvent.wheel(row,{deltaY:-100});expect(notes()).toHaveValue('E4 B3 G3 D3 A2 E2');
  row.focus();fireEvent.wheel(row,{deltaY:-100});expect(notes()).toHaveValue('E4 B3 G3 D3 A2 F2');fireEvent.wheel(row,{deltaY:100});fireEvent.wheel(row,{deltaY:100});expect(notes()).toHaveValue('E4 B3 G3 D3 A2 D#2');
});
it('the dialog belongs to the track it was opened for: it follows a move and closes without an edit when the track is removed',()=>{
  const two=previewEdit(blankProject(),{type:'addTrack',name:'Bass',tuning:[43,38,33,28],program:33}),onEdit=vi.fn();
  const view=render(<TrackSettingsPanel score={two.score} selected={0} busy={false} onEdit={onEdit}/>);fireEvent.click(edit());fireEvent.change(notes(),{target:{value:'E4 B3 G3 D3 A2 D2'}});
  const moved=previewEdit(two.project,{type:'moveTrack',track:0,to:1});
  view.rerender(<TrackSettingsPanel score={moved.score} selected={0} busy={false} onEdit={onEdit}/>);
  expect(dialog()).toBeInTheDocument();expect(notes()).toHaveValue('E4 B3 G3 D3 A2 D2');fireEvent.click(inDialog('Keep fingering'));
  expect(onEdit).toHaveBeenLastCalledWith({type:'setTuning',track:1,tuning:[64,59,55,50,45,38],tuningName:''});
  fireEvent.click(edit());fireEvent.change(notes(),{target:{value:'E4 B3 G3 D3 A2 C2'}});
  const removed=previewEdit(moved.project,{type:'removeTrack',track:0});onEdit.mockClear();
  view.rerender(<TrackSettingsPanel score={removed.score} selected={0} busy={false} onEdit={onEdit}/>);
  expect(screen.queryByRole('dialog')).toBeNull();expect(onEdit).not.toHaveBeenCalled();
});
it('the tuning buttons announce a dialog',()=>{
  render(<TrackSettingsPanel score={rest()} selected={0} busy={false} onEdit={vi.fn()}/>);
  expect(edit()).toHaveAttribute('aria-haspopup','dialog');
});
it('a refused edit keeps the dialog and its draft, says why in the dialog itself, and the reason goes when the draft changes',async()=>{
  const built=previewEdit(blankProject(),{type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},string:6,fret:3});
  // The refusal is the engine's own: the real "no playable string" error for a string count the note cannot keep.
  function Harness(){
    const [refusal,setRefusal]=useState<string|null>(null);
    const onEdit=(command:Parameters<typeof previewEdit>[1])=>{try{previewEdit(built.project,command);return Promise.resolve(true);}catch(error){setRefusal(error instanceof Error?error.message:String(error));return Promise.resolve(false);}};
    return <TrackSettingsPanel score={built.score} selected={0} busy={false} refusal={refusal} onEdit={onEdit}/>;
  }
  render(<Harness/>);edit().focus();fireEvent.click(edit());
  fireEvent.change(notes(),{target:{value:'E5 E5 E5 E5 E5 E5 E5'}});fireEvent.click(inDialog('Change string count'));
  await waitFor(()=>expect(within(dialog()).getByRole('alert')).toHaveTextContent(/no playable string/));
  expect(notes()).toHaveValue('E5 E5 E5 E5 E5 E5 E5');expect(notes()).toHaveAttribute('aria-invalid','true');expect(notes()).toHaveAttribute('aria-describedby',within(dialog()).getByRole('alert').id);
  fireEvent.change(notes(),{target:{value:'E4 B3 G3 D3 A2 D2'}});expect(within(dialog()).queryByRole('alert')).toBeNull();
  fireEvent.click(inDialog('Cancel'));expect(edit()).toHaveFocus();
});
it('says the tuning was not applied when a refused edit gave no message',async()=>{
  render(<TrackSettingsPanel score={rest()} selected={0} busy={false} onEdit={()=>Promise.resolve(false)}/>);fireEvent.click(edit());fireEvent.change(notes(),{target:{value:'E4 B3 G3 D3 A2 D2'}});fireEvent.click(inDialog('Keep fingering'));
  await waitFor(()=>expect(within(dialog()).getByRole('alert')).toHaveTextContent('The tuning was not applied.'));
});

// ---- Musical notation: what the old Selection tab's Staff panel did, from the Track tab and the Tuning dialog ----
const saved=()=>({tuning:standard,capo:0,transposition:0,displayTransposition:0,clef:0,showTab:true,showNotation:true,tuningName:'Standard E'});
const lastSettings=(onEdit:ReturnType<typeof vi.fn>)=>onEdit.mock.calls.at(-1)![0];
it('two notation toggles record the staff settings with the other fields as they are, and are pressed to show what is on',()=>{
  const onEdit=vi.fn();render(<TrackSettingsPanel score={rest()} selected={0} busy={false} onEdit={onEdit}/>);
  const tab=screen.getByRole('button',{name:'Show tablature'}),notation=screen.getByRole('button',{name:'Show notation'});
  expect(tab).toHaveAttribute('aria-pressed','true');expect(notation).toHaveAttribute('aria-pressed','true');
  fireEvent.click(tab);
  expect(onEdit).toHaveBeenCalledTimes(1);expect(lastSettings(onEdit)).toEqual({type:'setStaffSettings',track:0,staff:0,settings:expect.objectContaining({tuning:standard,capo:0,transposition:0,displayTransposition:0,showTab:false,showNotation:true,tuningName:expect.any(String)})});
  fireEvent.click(notation);expect(lastSettings(onEdit).settings).toMatchObject({showTab:true,showNotation:false});
});
it('sounding and display transposition and the clef apply when left or chosen, and the values the staff has record nothing',()=>{
  const onEdit=vi.fn();render(<TrackSettingsPanel score={rest()} selected={0} busy={false} onEdit={onEdit}/>);
  const sounding=screen.getByLabelText('Sounding transposition'),display=screen.getByLabelText('Display transposition');
  fireEvent.blur(sounding);fireEvent.blur(display);expect(onEdit).not.toHaveBeenCalled();
  fireEvent.change(sounding,{target:{value:'12'}});expect(onEdit).not.toHaveBeenCalled();fireEvent.blur(sounding);
  expect(onEdit).toHaveBeenCalledTimes(1);expect(lastSettings(onEdit).settings).toMatchObject({transposition:12,displayTransposition:0});
  fireEvent.change(display,{target:{value:'-12'}});fireEvent.keyDown(display,{key:'Enter'});expect(lastSettings(onEdit).settings).toMatchObject({displayTransposition:-12});
  const clef=screen.getByLabelText('Staff clef') as HTMLSelectElement,current=clef.value;fireEvent.change(clef,{target:{value:'3'}});expect(lastSettings(onEdit).settings).toMatchObject({clef:3});
  const calls=onEdit.mock.calls.length;fireEvent.change(clef,{target:{value:current}});expect(onEdit.mock.calls.length).toBeLessThanOrEqual(calls+1);
});
it('a pitched staff has no tab toggle, and its transposition applies without a tuning',()=>{
  const score=previewEdit(blankProject(),{type:'addPitchedTrack',name:'Piano',program:0}).score,onEdit=vi.fn();
  render(<TrackSettingsPanel score={score} selected={1} busy={false} onEdit={onEdit}/>);
  expect(screen.getByRole('button',{name:'Show tablature'})).toBeDisabled();expect(screen.getByRole('button',{name:'Show notation'})).toHaveAttribute('aria-pressed','true');
  fireEvent.change(screen.getByLabelText('Sounding transposition'),{target:{value:'12'}});fireEvent.blur(screen.getByLabelText('Sounding transposition'));
  expect(onEdit).toHaveBeenLastCalledWith(expect.objectContaining({type:'setStaffSettings',track:1,settings:expect.objectContaining({tuning:[],transposition:12,showTab:false,showNotation:true})}));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();expect(screen.getByRole('button',{name:'No tuning'})).toBeDisabled();
});
it('Add staff records addStaff with the staff present settings and Remove staff records removeStaff for the staff under the cursor',()=>{
  const onEdit=vi.fn();const view=render(<TrackSettingsPanel score={rest()} selected={0} busy={false} onEdit={onEdit}/>);
  expect(screen.getByRole('button',{name:'Remove staff'})).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'Add staff'}));expect(lastSettings(onEdit)).toEqual({type:'addStaff',track:0,settings:expect.objectContaining({tuning:standard,capo:0,showTab:true})});expect(lastSettings(onEdit).settings).not.toHaveProperty('keepPitch');
  const two=previewEdit(blankProject(),{type:'addStaff',track:0,settings:saved()}).score;
  view.rerender(<TrackSettingsPanel score={two} selected={0} staff={1} busy={false} onEdit={onEdit}/>);
  expect(screen.getByText('Staff 2')).toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'Remove staff'}));expect(lastSettings(onEdit)).toEqual({type:'removeStaff',track:0,staff:1});
});
it('the Tuning dialog Capo section: a capo alone is one setStaffSettings with the tuning name kept, and the current capo records nothing',()=>{
  const score=rest(),onEdit=vi.fn();score.tracks[0].staves[0].stringTuning.name='Imported';
  render(<TrackSettingsPanel score={score} selected={0} busy={false} onEdit={onEdit}/>);
  fireEvent.click(edit());expect(within(dialog()).getByLabelText('Capo')).toHaveValue(0);
  fireEvent.click(inDialog('Keep fingering'));expect(onEdit).not.toHaveBeenCalled();expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(edit());fireEvent.change(within(dialog()).getByLabelText('Capo'),{target:{value:'2'}});expect(onEdit).not.toHaveBeenCalled();fireEvent.click(inDialog('Keep fingering'));
  expect(onEdit).toHaveBeenCalledTimes(1);expect(lastSettings(onEdit)).toEqual({type:'setStaffSettings',track:0,staff:0,settings:expect.objectContaining({capo:2,tuning:standard,tuningName:'Imported'})});
  expect(lastSettings(onEdit).settings).not.toHaveProperty('partialCapo');expect(lastSettings(onEdit).settings).not.toHaveProperty('droneFret');expect(lastSettings(onEdit).settings).not.toHaveProperty('keepPitch');
});
it('Enter in a partial capo or drone field settles that field and does not submit the Tuning dialog',()=>{
  const onEdit=vi.fn();render(<TrackSettingsPanel score={rest()} selected={0} busy={false} onEdit={onEdit}/>);
  fireEvent.click(edit());const fret=within(dialog()).getByLabelText('Partial capo fret');
  fireEvent.change(fret,{target:{value:'3'}});expect(fireEvent.keyDown(fret,{key:'Enter'})).toBe(false);
  expect(onEdit).not.toHaveBeenCalled();expect(dialog()).toBeInTheDocument();
});
it('Cancel discards a capo draft',()=>{
  const onEdit=vi.fn();render(<TrackSettingsPanel score={rest()} selected={0} busy={false} onEdit={onEdit}/>);
  fireEvent.click(edit());fireEvent.change(within(dialog()).getByLabelText('Capo'),{target:{value:'5'}});fireEvent.click(inDialog('Cancel'));
  expect(onEdit).not.toHaveBeenCalled();fireEvent.click(edit());expect(within(dialog()).getByLabelText('Capo')).toHaveValue(0);
});
it('a capo and a new tuning are one edit on a one-staff track, with Keep pitch carried, and the draft tuning name sent',()=>{
  const onEdit=vi.fn();render(<TrackSettingsPanel score={rest()} selected={0} busy={false} onEdit={onEdit}/>);
  fireEvent.click(edit());fireEvent.change(within(dialog()).getByLabelText('Capo'),{target:{value:'3'}});fireEvent.change(notes(),{target:{value:'E4 B3 G3 D3 A2 D2'}});fireEvent.click(inDialog('Keep pitch'));
  expect(onEdit).toHaveBeenCalledTimes(1);expect(lastSettings(onEdit)).toEqual({type:'setStaffSettings',track:0,staff:0,settings:expect.objectContaining({capo:3,tuning:[64,59,55,50,45,38],tuningName:'',keepPitch:true})});
  fireEvent.click(edit());fireEvent.change(within(dialog()).getByLabelText('Capo'),{target:{value:'4'}});fireEvent.change(notes(),{target:{value:'E4 B3 G3 D3 A2 D2'}});fireEvent.click(inDialog('Keep fingering'));
  expect(lastSettings(onEdit).settings).toMatchObject({capo:4,tuning:[64,59,55,50,45,38]});expect(lastSettings(onEdit).settings).not.toHaveProperty('keepPitch');
});
it('a capo with a string count change is refused in the dialog with its reason and no edit; with several staves a capo and a retune of the same count are one edit on the staff',async()=>{
  const onEdit=vi.fn();const view=render(<TrackSettingsPanel score={rest()} selected={0} busy={false} onEdit={onEdit}/>);
  fireEvent.click(edit());fireEvent.change(within(dialog()).getByLabelText('Capo'),{target:{value:'3'}});fireEvent.change(notes(),{target:{value:'E4 B3 G3 D3 A2 E2 B1'}});fireEvent.click(inDialog('Change string count'));
  expect(onEdit).not.toHaveBeenCalled();expect(await within(dialog()).findByRole('alert')).toHaveTextContent('one at a time');
  fireEvent.click(inDialog('Cancel'));
  const two=previewEdit(blankProject(),{type:'addStaff',track:0,settings:saved()}).score;
  view.rerender(<TrackSettingsPanel score={two} selected={0} busy={false} onEdit={onEdit}/>);
  fireEvent.click(edit());fireEvent.change(within(dialog()).getByLabelText('Capo'),{target:{value:'3'}});fireEvent.change(notes(),{target:{value:'E4 B3 G3 D3 A2 D2'}});fireEvent.click(inDialog('Keep fingering'));
  expect(onEdit).toHaveBeenCalledTimes(1);expect(lastSettings(onEdit)).toEqual({type:'setStaffSettings',track:0,staff:0,settings:expect.objectContaining({capo:3,tuning:[64,59,55,50,45,38]})});
  fireEvent.click(edit());fireEvent.change(within(dialog()).getByLabelText('Capo'),{target:{value:'3'}});fireEvent.change(notes(),{target:{value:'E4 B3 G3 D3 A2 E2 B1'}});fireEvent.click(inDialog('Change string count'));
  expect(onEdit).toHaveBeenCalledTimes(1);expect(await within(dialog()).findByRole('alert')).toHaveTextContent('one at a time');
});
it('the capo goes on the staff under the cursor of a track with two staves',()=>{
  const onEdit=vi.fn(),two=previewEdit(blankProject(),{type:'addStaff',track:0,settings:saved()}).score;
  render(<TrackSettingsPanel score={two} selected={0} staff={1} busy={false} onEdit={onEdit}/>);
  fireEvent.click(edit());fireEvent.change(within(dialog()).getByLabelText('Capo'),{target:{value:'2'}});fireEvent.click(inDialog('Keep fingering'));
  expect(lastSettings(onEdit)).toEqual({type:'setStaffSettings',track:0,staff:1,settings:expect.objectContaining({capo:2})});
});
it('an invalid capo is refused in the dialog, which stays open',()=>{
  const onEdit=vi.fn();render(<TrackSettingsPanel score={rest()} selected={0} busy={false} onEdit={onEdit}/>);
  fireEvent.click(edit());fireEvent.change(within(dialog()).getByLabelText('Capo'),{target:{value:'1.5'}});fireEvent.submit(notes().closest('form')!);
  expect(onEdit).not.toHaveBeenCalled();expect(within(dialog()).getByRole('alert')).toHaveTextContent('whole fret');
});
it('the notation toggles and More fields keep focus and refuse the change while busy',()=>{
  const onEdit=vi.fn(),score=rest();const view=render(<TrackSettingsPanel score={score} selected={0} busy={false} onEdit={onEdit}/>);
  const tab=screen.getByRole('button',{name:'Show tablature'});tab.focus();view.rerender(<TrackSettingsPanel score={score} selected={0} busy onEdit={onEdit}/>);
  expect(tab).toHaveFocus();expect(tab).not.toBeDisabled();expect(tab).toHaveAttribute('aria-disabled','true');fireEvent.click(tab);expect(onEdit).not.toHaveBeenCalled();
  const sounding=screen.getByLabelText('Sounding transposition');fireEvent.change(sounding,{target:{value:'5'}});fireEvent.blur(sounding);expect(onEdit).not.toHaveBeenCalled();
});
