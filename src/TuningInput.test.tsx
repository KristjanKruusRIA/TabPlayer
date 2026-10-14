// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TuningInput } from './TuningInput';
afterEach(cleanup);
function Draft(){const [value,onChange]=useState('E4 B3 G3 D3 A2 E2');return <TuningInput label="Notes" presetLabel="Preset" value={value} onChange={onChange}/>;}
it('groups exactly25 presets and choosing nine-string guitar only fills the editable draft',()=>{
  render(<Draft/>);const select=screen.getByLabelText('Preset');expect(select.querySelectorAll('optgroup')).toHaveLength(7);expect(select.querySelectorAll('option')).toHaveLength(26);fireEvent.change(select,{target:{value:'guitar-9-standard-csharp'}});expect(screen.getByLabelText('Notes')).toHaveValue('E4 B3 G3 D3 A2 E2 B1 F#1 C#1');expect(select).toHaveValue('guitar-9-standard-csharp');
});
it('lets Custom stay selected at matching notes then autodetects manual equivalent flats',()=>{
  render(<Draft/>);const select=screen.getByLabelText('Preset');expect(select).toHaveValue('guitar-6-standard-e');fireEvent.change(select,{target:{value:'custom'}});expect(select).toHaveValue('custom');expect(screen.getByLabelText('Notes')).toHaveValue('E4 B3 G3 D3 A2 E2');fireEvent.change(screen.getByLabelText('Notes'),{target:{value:'Eb4 Bb3 Gb3 Db3 Ab2 Eb2'}});expect(select).toHaveValue('guitar-6-half-step-down');
});
it('resets Custom on source readback and disables both controls for percussion or busy',()=>{
  const onChange=vi.fn(),first={},props={label:'Notes',presetLabel:'Preset',value:'E4 B3 G3 D3 A2 E2',onChange,revision:first};const view=render(<TuningInput {...props}/>);fireEvent.change(screen.getByLabelText('Preset'),{target:{value:'custom'}});view.rerender(<TuningInput {...props} revision={{}}/>);expect(screen.getByLabelText('Preset')).toHaveValue('guitar-6-standard-e');view.rerender(<TuningInput {...props} disabled/>);expect(screen.getByLabelText('Preset')).toBeDisabled();expect(screen.getByLabelText('Notes')).toBeDisabled();expect(onChange).not.toHaveBeenCalled();
});
