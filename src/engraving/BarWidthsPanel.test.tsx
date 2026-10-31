// @vitest-environment jsdom
import { afterEach,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen } from '@testing-library/react';
import { BarWidthsPanel } from './BarWidthsPanel';
import { withBarScale } from './bar-widths';
import { defaultEngraving } from './projection';
import { withTypography } from './typography';

afterEach(cleanup);
const open=()=>{for(const details of document.querySelectorAll('details'))details.open=true;};
const setup=(props:Partial<Parameters<typeof BarWidthsPanel>[0]>={})=>{
  const onEdit=vi.fn(),onDesign=vi.fn(),value=props.value??withBarScale(withBarScale(defaultEngraving(),1,1.5),3,.5);
  const result=render(<BarWidthsPanel value={value} design={false} onDesign={onDesign} busy={false} honoured onEdit={onEdit} {...props}/>);open();
  return {onEdit,onDesign,value,...result};
};

it('restores every default width in one edit that keeps the other engraving choices',()=>{
  const typed=withTypography(withBarScale(withBarScale(defaultEngraving(),1,1.5),3,.5),{family:'serif',textScale:null,titleScale:null,tabScale:null});
  const {onEdit}=setup({value:typed});
  expect(screen.getByText('2 bars have a custom width.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Restore default widths'}));
  expect(onEdit).toHaveBeenCalledTimes(1);
  const sent=onEdit.mock.calls[0][0];expect(sent.type).toBe('setEngraving');expect(Object.hasOwn(sent.engraving,'barWidths')).toBe(false);expect(sent.engraving.typography?.family).toBe('serif');
});

it('records nothing when every bar already has its default width',()=>{
  const {onEdit}=setup({value:defaultEngraving()});
  const button=screen.getByRole('button',{name:'Restore default widths'});expect(button.getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(button);expect(onEdit).not.toHaveBeenCalled();expect(screen.getByText('Every bar has its default width.')).toBeTruthy();
});

it('refuses to restore while busy without disabling the button, so it keeps focus',()=>{
  const {onEdit}=setup({busy:true});
  const button=screen.getByRole('button',{name:'Restore default widths'});button.focus();
  expect(button.hasAttribute('disabled')).toBe(false);expect(button.getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(button);fireEvent.keyDown(button,{key:'Enter'});expect(onEdit).not.toHaveBeenCalled();expect(document.activeElement).toBe(button);
});

it('switches design mode and says when the chosen layout ignores widths',()=>{
  const {onDesign,rerender,onEdit,value}=setup();
  fireEvent.click(screen.getByRole('checkbox',{name:/Design mode/}));expect(onDesign).toHaveBeenCalledWith(true);
  expect(screen.queryByText(/spaces bars by itself/)).toBeNull();
  rerender(<BarWidthsPanel value={value} design onDesign={onDesign} busy={false} honoured={false} onEdit={onEdit}/>);
  expect(screen.getByText(/spaces bars by itself/)).toBeTruthy();expect((screen.getByRole('checkbox',{name:/Design mode/}) as HTMLInputElement).checked).toBe(true);
});
