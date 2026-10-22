// @vitest-environment jsdom
import { afterEach,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen,within } from '@testing-library/react';
import { model } from '@coderline/alphatab';
import { music,target } from './fixtures';
import { GesturePanel } from './GesturePanel';
afterEach(cleanup);
it('gesture_panel_dispatches_exact_named_choices',()=>{
  const score=music(),b=score.tracks[0].staves[0].bars[0].voices[0].beats[0];b.tap=true;b.rasgueado=18;b.fade=2;b.preferredBeamDirection=1;b.barreFret=3;b.barreShape=1;
  const onEdit=vi.fn();render(<GesturePanel score={score} target={target} busy={false} onEdit={onEdit}/>);
  expect((screen.getByLabelText('Tap') as HTMLInputElement).checked).toBe(true);expect((screen.getByLabelText('Rasgueado') as HTMLSelectElement).value).toBe('18');expect((screen.getByLabelText('Stem direction') as HTMLSelectElement).value).toBe('down');
  expect(within(screen.getByLabelText('Rasgueado')).getAllByRole('option').map(n=>n.textContent)).toEqual(['None','Ii','Mi','Mii Triplet','Mii Anapaest','Pmp Triplet','Pmp Anapaest','Pei Triplet','Pei Anapaest','Pai Triplet','Pai Anapaest','Ami Triplet','Ami Anapaest','Ppp','Amii','Amip','Eami','Eamii','Peami']);
  fireEvent.click(screen.getByLabelText('Slap'));fireEvent.change(screen.getByLabelText('Fade'),{target:{value:'3'}});expect(onEdit).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Apply beat gestures'}));
  expect(onEdit).toHaveBeenCalledExactlyOnceWith({type:'setBeatGestures',target,patch:{slap:true,fade:3}});
});
it('gesture_panel_dispatches_the_wah_pedal_choice',()=>{
  const score=music();score.tracks[0].staves[0].bars[0].voices[0].beats[0].wahPedal=model.WahPedal.Open;
  const onEdit=vi.fn();render(<GesturePanel score={score} target={target} busy={false} onEdit={onEdit}/>);
  const wah=screen.getByLabelText('Wah pedal') as HTMLSelectElement;expect(wah.value).toBe('1');
  expect(within(wah).getAllByRole('option').map(n=>n.textContent)).toEqual(['None','Open','Closed']);
  fireEvent.change(wah,{target:{value:'2'}});fireEvent.click(screen.getByRole('button',{name:'Apply beat gestures'}));
  expect(onEdit).toHaveBeenCalledExactlyOnceWith({type:'setBeatGestures',target,patch:{wahPedal:2}});
});
it('gesture_panel_dispatches_sustain_pedal_marks_for_the_selected_beat',()=>{
  const score=music();score.tracks[0].staves[0].bars[0].sustainPedals.push(Object.assign(new model.SustainPedalMarker(),{pedalType:model.SustainPedalMarkerType.Down,ratioPosition:0}));
  const onEdit=vi.fn();render(<GesturePanel score={score} target={target} busy={false} onEdit={onEdit}/>);
  const pedal=screen.getByLabelText('Sustain pedal') as HTMLSelectElement;expect(pedal.value).toBe('down');
  expect(within(pedal).getAllByRole('option').map(n=>n.textContent)).toEqual(['No mark','Press (Ped.)','Release (*)']);
  expect((screen.getByRole('button',{name:'Apply sustain pedal'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(pedal,{target:{value:'none'}});fireEvent.click(screen.getByRole('button',{name:'Apply sustain pedal'}));
  expect(onEdit).toHaveBeenCalledExactlyOnceWith({type:'setSustainPedal',target,pedal:'none'});
});
it('gesture_panel_preserves_imported_combined_stem_until_explicitly_edited',()=>{
  const score=music(),b=score.tracks[0].staves[0].bars[0].voices[0].beats[0];b.preferredBeamDirection=0;b.invertBeamDirection=true;
  const onEdit=vi.fn();render(<GesturePanel score={score} target={target} busy={false} onEdit={onEdit}/>);fireEvent.click(screen.getByLabelText('Slash notation'));fireEvent.click(screen.getByRole('button',{name:'Apply beat gestures'}));expect(onEdit.mock.calls[0][0]).toEqual({type:'setBeatGestures',target,patch:{slashed:true}});
  fireEvent.change(screen.getByLabelText('Stem direction'),{target:{value:'auto'}});fireEvent.click(screen.getByRole('button',{name:'Apply beat gestures'}));expect(onEdit.mock.calls[1][0].patch.stem).toBe('auto');
});
it('gesture_panel_dispatches_bounded_ranges_and_global_fermata',()=>{
  const score=music(),onEdit=vi.fn();render(<GesturePanel score={score} target={{...target,beat:2}} busy={false} onEdit={onEdit}/>);
  fireEvent.change(screen.getByLabelText('Range end measure'),{target:{value:'2'}});fireEvent.change(screen.getByLabelText('Range end beat'),{target:{value:'2'}});fireEvent.change(screen.getByLabelText('Octave region'),{target:{value:'1'}});fireEvent.click(screen.getByRole('button',{name:'Apply octave region'}));expect(onEdit.mock.calls[0][0]).toEqual({type:'setOttava',from:{...target,beat:2},to:{...target,bar:1,beat:1},ottava:1});
  fireEvent.change(screen.getByLabelText('Hairpin'),{target:{value:'1'}});fireEvent.change(screen.getByLabelText('Target dynamics'),{target:{value:'6'}});fireEvent.click(screen.getByRole('button',{name:'Apply hairpin'}));expect(onEdit.mock.calls[1][0]).toEqual({type:'setCrescendo',from:{...target,beat:2},to:{...target,bar:1,beat:1},crescendo:1,targetDynamics:6});
  fireEvent.change(screen.getByLabelText('Global fermata'),{target:{value:'2'}});fireEvent.change(screen.getByLabelText('Stored length'),{target:{value:'1.5'}});fireEvent.click(screen.getByRole('button',{name:'Apply global fermata'}));expect(onEdit.mock.calls[2][0]).toEqual({type:'setFermata',target:{...target,beat:2},fermata:{type:2,length:1.5}});
  fireEvent.change(screen.getByLabelText('Global fermata'),{target:{value:'none'}});fireEvent.click(screen.getByRole('button',{name:'Apply global fermata'}));expect(onEdit.mock.calls[3][0].fermata).toBeNull();
  expect(screen.getByText(/every track/i)).toBeTruthy();
});
it('gesture_panel_resets_with_selection_and_disables_busy_edits',()=>{
  const score=music(),onEdit=vi.fn(),view=render(<GesturePanel score={score} target={target} busy={false} onEdit={onEdit}/>);fireEvent.click(screen.getByLabelText('Tap'));
  view.rerender(<GesturePanel score={score} target={{...target,beat:1}} busy={false} onEdit={onEdit}/>);expect((screen.getByLabelText('Tap') as HTMLInputElement).checked).toBe(false);expect((screen.getByLabelText('Range end beat') as HTMLInputElement).value).toBe('2');
  view.rerender(<GesturePanel score={score} target={{...target,beat:1}} busy={true} onEdit={onEdit}/>);for(const fieldset of view.container.querySelectorAll('fieldset'))expect(fieldset.disabled).toBe(true);
});
it('gesture_panel_clears_barre_without_clearing_omitted_gestures',()=>{
  const score=music(),b=score.tracks[0].staves[0].bars[0].voices[0].beats[0];b.barreFret=7;b.barreShape=2;const onEdit=vi.fn();render(<GesturePanel score={score} target={target} busy={false} onEdit={onEdit}/>);
  expect((screen.getByLabelText('Barre fret') as HTMLInputElement).value).toBe('7');fireEvent.change(screen.getByLabelText('Barre shape'),{target:{value:'0'}});fireEvent.click(screen.getByRole('button',{name:'Apply beat gestures'}));expect(onEdit).toHaveBeenCalledExactlyOnceWith({type:'setBeatGestures',target,patch:{barre:null}});
});
