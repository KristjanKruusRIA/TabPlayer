// @vitest-environment jsdom
import { afterEach,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { SectionsPanel } from './SectionsPanel';

afterEach(cleanup);
const sections=[{bar:0,name:'Intro'},{bar:8,name:'Verse'},{bar:16,name:'Chorus'}];

it('lists sections with their first measure and jumps to one',()=>{
  const onGo=vi.fn();
  render(<SectionsPanel sections={sections} bar={9} onGo={onGo}/>);
  expect(screen.getByText('Sections (3)')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Measure 17 · Chorus'}));
  expect(onGo).toHaveBeenCalledWith(16);
});

it('marks the section the cursor is in',()=>{
  render(<SectionsPanel sections={sections} bar={9} onGo={()=>{}}/>);
  expect(screen.getByRole('button',{name:'Measure 9 · Verse'})).toHaveAttribute('aria-current','location');
  expect(screen.getByRole('button',{name:'Measure 1 · Intro'})).not.toHaveAttribute('aria-current');
});

it('steps between sections and keeps focus on an end that has no neighbour',()=>{
  const onGo=vi.fn();
  render(<SectionsPanel sections={sections} bar={16} onGo={onGo}/>);
  const next=screen.getByRole('button',{name:'Next section'});
  expect(next).not.toBeDisabled();expect(next).toHaveAttribute('aria-disabled','true');
  next.focus();fireEvent.click(next);
  expect(onGo).not.toHaveBeenCalled();expect(next).toHaveFocus();
  fireEvent.click(screen.getByRole('button',{name:'Previous section'}));
  expect(onGo).toHaveBeenCalledWith(8);
});

it('explains how to name a section when there are none',()=>{
  render(<SectionsPanel sections={[]} bar={0} onGo={()=>{}}/>);
  expect(screen.getByText('Sections (0)')).toBeInTheDocument();
  expect(screen.getByText(/Section label/)).toBeInTheDocument();
  expect(screen.queryByRole('button')).toBeNull();
});
