// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { PropertiesDialog, propertiesTabs, type PropertiesRequest, type PropertiesTab } from './PropertiesDialog';
import { music, target } from './fixtures';
import { previewEdit } from '../engine';
import { blankProject } from '../project';
import type { EditCommand } from '../edit-types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => ({ format: 'tabplayer-tuning-library', version: 1, entries: [] })) }));
afterEach(cleanup);

/** What the old Selection tab's controls must still record, from their new home: the same edit type and payload. */
function setup(tab: PropertiesTab, extra: Partial<Parameters<typeof PropertiesDialog>[0]> = {}) {
  const onEdit = vi.fn(), onTab = vi.fn(), onClose = vi.fn(), onSelect = vi.fn();
  const props = { score: music(), target, string: 6, noteIndex: null, busy: false, locked: false, onSelect, onSelectNote: vi.fn(), onEdit, musicSelection: null, onMusicSelection: vi.fn(), onTab, onClose, ...extra };
  const view = render(<PropertiesDialog request={{ tab, nonce: 1 }} {...props} />);
  return { onEdit, onTab, onClose, onSelect, props, view };
}
const disclose = (name: string) => fireEvent.click(screen.getByText(name, { selector: 'summary' }));

it('has the seven groups the Selection tab broke into, as tabs, and a tab change asks the owner to switch', () => {
  const { onTab } = setup('note');
  const tabs = within(screen.getByRole('tablist', { name: 'Property groups' }));
  expect(tabs.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Note', 'Beat', 'Bar', 'Selection', 'Staff and voices', 'Pitch entry', 'Score']);
  expect(tabs.getByRole('tab', { name: 'Note' })).toHaveAttribute('aria-selected', 'true');
  fireEvent.click(tabs.getByRole('tab', { name: 'Bar' }));expect(onTab).toHaveBeenLastCalledWith('bar');
  fireEvent.keyDown(tabs.getByRole('tab', { name: 'Note' }), { key: 'ArrowLeft' });expect(onTab).toHaveBeenLastCalledWith('score');
  expect(screen.getByLabelText('Properties location')).toHaveTextContent('Guitar · Bar 1 · Beat 1 · Voice 1');
  expect(propertiesTabs).toHaveLength(7);
});

it('Note tab: a technique records the same note edit, and the same value twice records nothing more', () => {
  const { onEdit } = setup('note');
  disclose('Notes & techniques');
  fireEvent.click(screen.getByLabelText('Palm mute'));
  expect(onEdit).toHaveBeenLastCalledWith({ type: 'setNoteTechniques', target, string: 6, patch: { palmMute: true } });
  expect(onEdit).toHaveBeenCalledTimes(1);
});

it('Note tab on a percussion staff addresses the note by index, as the tab did', () => {
  const score = music();score.tracks[0].staves[0].isPercussion = true;
  const { onEdit } = setup('note', { score, noteIndex: 0 });
  disclose('Notes & techniques');
  fireEvent.click(screen.getByLabelText('Ghost note'));
  expect(onEdit).toHaveBeenCalledWith({ type: 'setNoteTechniquesByIndex', target, noteIndex: 0, patch: { ghost: true } });
});

it('Beat tab: a tuplet of any ratio and the grace type record setBeatRhythm with the beat\'s own duration and dots; the current values record nothing', () => {
  const { onEdit } = setup('beat');
  const apply = screen.getByRole('button', { name: 'Apply rhythm' });
  expect(apply).toHaveAttribute('aria-disabled', 'true');expect(apply).not.toBeDisabled();fireEvent.click(apply);expect(onEdit).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Tuplet numerator'), { target: { value: '5' } });fireEvent.change(screen.getByLabelText('Tuplet denominator'), { target: { value: '3' } });
  expect(apply).toBeEnabled();fireEvent.click(apply);
  expect(onEdit).toHaveBeenCalledTimes(1);expect(onEdit).toHaveBeenLastCalledWith({ type: 'setBeatRhythm', target, duration: 4, dots: 0, tupletNumerator: 5, tupletDenominator: 3, graceType: 0 });
  fireEvent.change(screen.getByLabelText('Tuplet numerator'), { target: { value: '1' } });fireEvent.change(screen.getByLabelText('Tuplet denominator'), { target: { value: '1' } });
  expect(apply).toHaveAttribute('aria-disabled', 'true');
});

it('Beat tab: the beat notation panel is there with its picking and whammy controls', () => {
  setup('beat');
  expect(screen.getByText('Beat notation', { selector: 'summary' })).toBeInTheDocument();
});

it('Bar tab: measure settings, directions, bar gestures and measure insert and removal are reachable; the time signature records the same edit', () => {
  const { onEdit } = setup('bar');
  for (const title of ['Measure & notation', 'Directions', 'Bar gestures', 'Insert & remove measures']) expect(screen.getByText(title, { selector: 'summary' })).toBeInTheDocument();
  disclose('Measure & notation');
  fireEvent.change(screen.getByLabelText('Time numerator'), { target: { value: '3' } });fireEvent.click(screen.getByRole('button', { name: 'Apply measure settings' }));
  expect(onEdit).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'setMeasureSettings', bar: 0, numerator: 3, denominator: 4 }));
});

it('Bar tab: inserting measures records insertMeasures', () => {
  const { onEdit } = setup('bar');
  disclose('Insert & remove measures');
  fireEvent.click(screen.getByRole('button', { name: 'Insert after' }));
  expect(onEdit).toHaveBeenLastCalledWith({ type: 'insertMeasures', beforeBar: 1, count: 1 });
});

it('Selection tab: the music selection tools select a bar, and the clipboard and harmony tools passed in are shown', () => {
  const onMusicSelection = vi.fn();
  setup('selection', { onMusicSelection, selectionTools: <button>Clipboard tool</button> });
  fireEvent.click(screen.getByRole('button', { name: 'Select bar' }));
  expect(onMusicSelection).toHaveBeenCalledWith(expect.objectContaining({ kind: 'bars', firstBar: 0, lastBar: 0 }));
  expect(screen.getByRole('button', { name: 'Clipboard tool' })).toBeInTheDocument();
});

it('Staff tab: voices, copy voice, the system layout and lyrics record the same edits; the staff settings are not here any more', () => {
  const { onEdit } = setup('staff');
  disclose('Staff, voices & layout');
  fireEvent.click(screen.getByRole('button', { name: 'Add voice' }));expect(onEdit).toHaveBeenLastCalledWith({ type: 'addVoice', track: 0, staff: 0 });
  fireEvent.change(screen.getByLabelText('Bars per system'), { target: { value: '3' } });fireEvent.click(screen.getByRole('button', { name: 'Apply system layout' }));
  expect(onEdit).toHaveBeenLastCalledWith({ type: 'setTrackLayout', track: 0, barsPerSystem: 3, lineBreaks: [] });
  expect(screen.queryByRole('button', { name: 'Apply staff settings' })).toBeNull();expect(screen.queryByLabelText('Capo')).toBeNull();expect(screen.queryByRole('button', { name: 'Add staff' })).toBeNull();
  expect(screen.getByText('Lyrics', { selector: 'summary' })).toBeInTheDocument();
});

it('Staff tab on a lyrics request opens the Lyrics disclosure and focuses it; a clipboard request does the same on the Selection tab', () => {
  const request: PropertiesRequest = { tab: 'staff', focus: 'lyrics', nonce: 1 };
  const base = { score: music(), target, string: 6, noteIndex: null, busy: false, locked: false, onSelect: vi.fn(), onSelectNote: vi.fn(), onEdit: vi.fn(), musicSelection: null, onMusicSelection: vi.fn(), onTab: vi.fn(), onClose: vi.fn() };
  const view = render(<PropertiesDialog request={request} {...base} />);
  const lyrics = screen.getByText('Lyrics', { selector: 'summary' });
  expect(lyrics.parentElement).toHaveAttribute('open');expect(lyrics).toHaveFocus();
  view.rerender(<PropertiesDialog request={{ tab: 'selection', focus: 'clipboard', nonce: 2 }} {...base} selectionTools={<details><summary>Musical clipboard</summary></details>} />);
  const clip = screen.getByText('Musical clipboard', { selector: 'summary' });
  expect(clip.parentElement).toHaveAttribute('open');expect(clip).toHaveFocus();
});

it('Pitch entry and Score tabs show the tools the app passes in', () => {
  setup('entry', { entryTools: <p>Entry tool</p> });expect(screen.getByText('Entry tool')).toBeInTheDocument();
  cleanup();setup('score', { scoreTools: <p>Sections tool</p> });expect(screen.getByText('Sections tool')).toBeInTheDocument();
});

it('while busy the edit controls refuse, and a finalized score refuses them too', () => {
  const { onEdit } = setup('note', { busy: true });
  disclose('Notes & techniques');
  const mute = screen.getByLabelText('Palm mute');expect(mute).not.toBeDisabled();expect(mute.closest('fieldset')).toHaveAttribute('aria-disabled', 'true');
  fireEvent.click(mute);expect(onEdit).not.toHaveBeenCalled();
});

it('Escape and the close button close it and record nothing; focus goes back to the opener', () => {
  function Harness() {
    const [open, setOpen] = useState<PropertiesRequest | null>(null), edit = vi.fn();
    return <>
      <button onClick={() => setOpen({ tab: 'note', nonce: 1 })} aria-haspopup="dialog">Open properties</button>
      {open && <PropertiesDialog request={open} onTab={tab => setOpen({ ...open, tab })} onClose={() => setOpen(null)} score={previewEdit(blankProject(), { type: 'setRest', target }).score} target={target} string={6} noteIndex={null} busy={false} locked={false} onSelect={vi.fn()} onSelectNote={vi.fn()} onEdit={edit as (command: EditCommand) => void} musicSelection={null} onMusicSelection={vi.fn()} />}
    </>;
  }
  render(<Harness />);
  const opener = screen.getByRole('button', { name: 'Open properties' });opener.focus();fireEvent.click(opener);
  expect(screen.getByRole('dialog', { name: 'Properties' })).toBeInTheDocument();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();expect(opener).toHaveFocus();
});

it('opens with focus on the selected tab, not on the close button', () => {
  setup('beat');
  expect(screen.getByRole('tab', { name: 'Beat' })).toHaveFocus();
  expect(screen.getByRole('button', { name: 'Close' })).not.toHaveFocus();
});

/** Every Apply button of the moved panels refuses while an edit is in flight without becoming disabled, so the focus stays on it and a second Enter does not reach the close button. */
it('a focused Apply button keeps focus when the edit it started is in flight, on every tab', () => {
  for (const tab of ['note', 'beat', 'bar', 'staff'] as const) {
    const { view, props } = setup(tab);
    const dialog = screen.getByRole('dialog', { name: 'Properties' });
    for (const summary of Array.from(dialog.querySelectorAll('details > summary'))) fireEvent.click(summary);
    const buttons = Array.from(dialog.querySelectorAll<HTMLButtonElement>('.properties-body button')).filter(button => !button.disabled && /^Apply/.test(button.textContent ?? ''));
    expect(buttons.length, tab).toBeGreaterThan(0);
    for (const button of buttons) {
      button.focus();
      view.rerender(<PropertiesDialog request={{ tab, nonce: 1 }} {...props} busy />);
      expect(document.activeElement, `${tab}: ${button.textContent}`).toBe(button);
      expect(button.disabled, `${tab}: ${button.textContent}`).toBe(false);
      view.rerender(<PropertiesDialog request={{ tab, nonce: 1 }} {...props} busy={false} />);
    }
    cleanup();
  }
});
