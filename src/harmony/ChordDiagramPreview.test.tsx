// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup,fireEvent,render,screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { model } from '@coderline/alphatab';
import type { HarmonyChord } from '../editor/harmony-types';
import { ChordDiagramPreview } from './ChordDiagramPreview';
afterEach(cleanup);
it('labels_custom_nonmonotonic_strings_in_the_supplied_sounding_context_and_highlights_the_root',()=>{
  const staff=new model.Staff();staff.stringTuning.tunings=[67,48,64];staff.capo=2;staff.transpositionPitch=1;staff.displayTranspositionPitch=24;
  const chord:HarmonyChord={name:'G#',nameMode:'theory',recipe:{root:{step:4,alteration:1},formula:'major',alterations:[],omissions:[],bass:null},firstFret:0,frets:[0,2,-1],fingers:[-2,2,-1],barreFrets:[],showName:true,showDiagram:true,showFingering:true},before=[...staff.tuning],changes:number[][]=[];
  const view=render(<ChordDiagramPreview chord={chord} staff={staff} highlightRoot onToggle={(string,fret)=>changes.push([string,fret])}/>);
  expect(screen.getByLabelText('String 1 open: G#4, root')).toBeInTheDocument();expect(screen.getByLabelText('String 2 fret 2: D#3')).toBeInTheDocument();expect(screen.getByLabelText('String 3 muted')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'String 1 fret 3: B4'}));expect(changes).toEqual([[0,3]]);
  fireEvent.click(screen.getByRole('button',{name:'String 1 muted'}));expect(changes).toEqual([[0,3],[0,-1]]);
  expect(staff.tuning).toEqual(before);expect([staff.capo,staff.transpositionPitch,staff.displayTranspositionPitch]).toEqual([2,1,24]);
  view.rerender(<ChordDiagramPreview chord={chord} staff={staff} highlightRoot={false} onToggle={null}/>);expect(screen.queryByLabelText('String 1 open: G#4, root')).not.toBeInTheDocument();expect(screen.getByLabelText('String 1 open: G#4')).toBeInTheDocument();expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
it('shows_wide_legacy_frets_and_zero_string_diagrams_without_normalizing_them',()=>{
  const staff=new model.Staff();staff.stringTuning.tunings=[64,40];const chord:HarmonyChord={name:'Legacy',nameMode:'manual',recipe:null,firstFret:0,frets:[0,24],fingers:[-2,4],barreFrets:[0,24,0],showName:false,showDiagram:false,showFingering:false};
  const before=structuredClone(chord),view=render(<ChordDiagramPreview chord={chord} staff={staff} highlightRoot onToggle={null}/>);expect(screen.getByLabelText('String 2 fret 24: E4')).toBeInTheDocument();expect(chord).toEqual(before);
  staff.stringTuning.tunings=[];view.rerender(<ChordDiagramPreview chord={{...chord,frets:[],fingers:[]}} staff={staff} highlightRoot onToggle={null}/>);expect(screen.getByText('Name-only chord; no strings.')).toBeInTheDocument();
});

it('string gauge increases with index (string 1 thinnest), single tab stop with roving tabindex, and aria-pressed attributes', () => {
  const staff = new model.Staff();
  staff.stringTuning.tunings = [64, 59, 55, 50, 45, 40];
  const chord: HarmonyChord = {
    name: 'C',
    nameMode: 'theory',
    recipe: null,
    firstFret: 1,
    frets: [-1, 3, 2, 0, 1, 0],
    fingers: [-1, 3, 2, 0, 1, 0],
    barreFrets: [],
    showName: true,
    showDiagram: true,
    showFingering: true,
  };
  const onToggle = vi.fn();
  const { container } = render(<ChordDiagramPreview chord={chord} staff={staff} highlightRoot={false} onToggle={onToggle} />);

  // Finding 11: String gauge reversed - index 0 (string 1) must be thinnest
  const stringLines = container.querySelectorAll<SVGLineElement>('line.tp-chord-string');
  expect(stringLines.length).toBe(6);
  const stroke0 = parseFloat(stringLines[0].getAttribute('stroke-width')!);
  const strokeLast = parseFloat(stringLines[5].getAttribute('stroke-width')!);
  expect(stroke0).toBeLessThan(strokeLast);

  // LOW: Live preview has 42 tab stops and no aria-pressed
  const tabStops = container.querySelectorAll<SVGElement>('[role="button"][tabindex="0"]');
  expect(tabStops.length).toBe(1);

  // Buttons must have aria-pressed
  const buttons = container.querySelectorAll<SVGElement>('[role="button"]');
  expect(buttons.length).toBeGreaterThan(1);
  for (const btn of buttons) {
    expect(btn).toHaveAttribute('aria-pressed');
  }

  // Selected note has aria-pressed="true", unselected has "false"
  const selectedNode = container.querySelector<SVGElement>('.tp-chord-node.is-selected[role="button"]');
  expect(selectedNode).toHaveAttribute('aria-pressed', 'true');

  // Keyboard navigation across frets and strings
  const initialStop = container.querySelector<SVGElement>('[role="button"][tabindex="0"]')!;
  initialStop.focus();
  fireEvent.keyDown(initialStop, { key: 'ArrowRight' });
  expect(container.querySelector<SVGElement>('[data-string="1"][tabindex="0"]')).toHaveFocus();

  fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
  expect(onToggle).toHaveBeenCalledWith(1, -1);
});
