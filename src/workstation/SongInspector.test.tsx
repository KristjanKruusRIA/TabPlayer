// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { SongInspector } from './SongInspector';
import { music } from '../editor/fixtures';
import { defaultMaster } from '../document-settings';
import { metadataFields } from '../editor/song';

afterEach(() => { cleanup(); localStorage.clear(); });
function setup(extra: Partial<Parameters<typeof SongInspector>[0]> = {}) {
  const onEdit = vi.fn(), onMaster = vi.fn(async () => {}), score = music();
  score.title = 'Etude';score.artist = 'Ada';
  const props = { score, busy: false, locked: false, onEdit, master: defaultMaster(), masterDisabled: false, onMaster, styleGroups: { style: <p>Style tools</p>, layout: <p>Layout tools</p>, page: <p>Page tools</p> }, ...extra };
  const view = render(<SongInspector {...props} />);
  return { onEdit, onMaster, score, view, props };
}

it('title and artist apply when left, with the tempo and its opening mark as they were, and record nothing when unchanged', () => {
  const { onEdit, score } = setup();
  const title = screen.getByLabelText('Title'), artist = screen.getByLabelText('Artist');
  fireEvent.focus(title);fireEvent.blur(title);fireEvent.blur(artist);expect(onEdit).not.toHaveBeenCalled();
  fireEvent.change(title, { target: { value: 'Etude No. 2' } });expect(onEdit).not.toHaveBeenCalled();fireEvent.blur(title);
  expect(onEdit).toHaveBeenCalledTimes(1);expect(onEdit).toHaveBeenLastCalledWith({ type: 'setScoreInfo', title: 'Etude No. 2', artist: 'Ada', tempo: score.tempo, preserveOpeningMark: true });
  fireEvent.change(artist, { target: { value: 'Bea' } });fireEvent.keyDown(artist, { key: 'Enter' });
  expect(onEdit).toHaveBeenLastCalledWith({ type: 'setScoreInfo', title: 'Etude', artist: 'Bea', tempo: score.tempo, preserveOpeningMark: true });
  fireEvent.change(title, { target: { value: 'Typed' } });fireEvent.keyDown(title, { key: 'Escape' });expect(title).toHaveValue('Etude');
  expect(screen.queryByRole('button', { name: 'Apply score info' })).toBeNull();
});

it('the initial tempo, behind More, applies when left and does not claim to keep the opening mark', () => {
  const { onEdit, score } = setup();
  fireEvent.click(screen.getByText('More', { selector: 'summary' }));
  const tempo = screen.getByLabelText('Initial tempo');expect(tempo).toHaveValue(score.tempo);
  fireEvent.blur(tempo);expect(onEdit).not.toHaveBeenCalled();
  fireEvent.change(tempo, { target: { value: String(score.tempo + 10) } });fireEvent.blur(tempo);
  expect(onEdit).toHaveBeenLastCalledWith({ type: 'setScoreInfo', title: 'Etude', artist: 'Ada', tempo: score.tempo + 10 });
});

it('each song metadata field applies when left as one setScoreMetadata with every field, and no Apply button is left', () => {
  const { onEdit, score } = setup();
  fireEvent.click(screen.getByText('More', { selector: 'summary' }));
  const subtitle = screen.getByLabelText('Subtitle');
  fireEvent.blur(subtitle);expect(onEdit).not.toHaveBeenCalled();
  fireEvent.change(subtitle, { target: { value: 'Study' } });fireEvent.blur(subtitle);
  const fields = Object.fromEntries(metadataFields.map(key => [key, score[key]]));
  expect(onEdit).toHaveBeenLastCalledWith({ type: 'setScoreMetadata', fields: { ...fields, subTitle: 'Study' } });
  const notices = screen.getByLabelText('Notices');fireEvent.change(notices, { target: { value: 'Line one\nLine two' } });fireEvent.keyDown(notices, { key: 'Enter' });expect(onEdit).toHaveBeenCalledTimes(1);
  fireEvent.blur(notices);expect(onEdit).toHaveBeenLastCalledWith({ type: 'setScoreMetadata', fields: { ...fields, notices: 'Line one\nLine two' } });
  expect(screen.queryByRole('button', { name: 'Apply song metadata' })).toBeNull();
});

it('a finalized score and a busy one refuse every field', () => {
  const locked = setup({ locked: true });
  const title = screen.getByLabelText('Title');expect(title).toBeDisabled();fireEvent.change(title, { target: { value: 'x' } });fireEvent.blur(title);expect(locked.onEdit).not.toHaveBeenCalled();
  cleanup();
  const busy = setup({ busy: true });
  const field = screen.getByLabelText('Title');fireEvent.change(field, { target: { value: 'y' } });fireEvent.blur(field);expect(busy.onEdit).not.toHaveBeenCalled();expect(field.closest('fieldset')).toHaveAttribute('aria-disabled', 'true');
});

it('Musical notation is one row that opens the Score style dialog with three groups, and opening or closing it records nothing', () => {
  const { onEdit } = setup();
  const open = screen.getByRole('button', { name: 'Score style…' });expect(open).toHaveAttribute('aria-haspopup', 'dialog');
  open.focus();fireEvent.click(open);
  const dialog = screen.getByRole('dialog', { name: 'Score style' });
  const groups = within(dialog).getByRole('tablist', { name: 'Style groups' });
  expect(within(groups).getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Engraving and fonts', 'Spacing and grouping', 'Page and view']);
  expect(within(dialog).getByText('Style tools')).toBeVisible();expect(within(dialog).getByText('Layout tools')).not.toBeVisible();
  fireEvent.click(within(groups).getByRole('tab', { name: 'Page and view' }));expect(within(dialog).getByText('Page tools')).toBeVisible();expect(within(dialog).getByText('Style tools')).not.toBeVisible();
  fireEvent.keyDown(within(groups).getByRole('tab', { name: 'Page and view' }), { key: 'ArrowRight' });expect(within(dialog).getByText('Style tools')).toBeVisible();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();expect(open).toHaveFocus();expect(onEdit).not.toHaveBeenCalled();
});

it('New score defaults opens its own dialog from More', () => {
  setup();
  fireEvent.click(screen.getByText('More', { selector: 'summary' }));
  fireEvent.click(screen.getByRole('button', { name: 'New score defaults…' }));
  const dialog = screen.getByRole('dialog');expect(within(dialog).getByRole('button', { name: 'Save defaults' })).toBeInTheDocument();
});

it('mastering is four slot rows: the switch records one master change, the same state records nothing, and the edit button opens that effect', () => {
  const { onMaster } = setup();
  const slots = within(screen.getByRole('list', { name: 'Sound mastering' }));
  expect(slots.getAllByRole('switch').map(item => item.closest('li')!.textContent)).toEqual([expect.stringContaining('Compressor'), expect.stringContaining('EQ'), expect.stringContaining('Reverb'), expect.stringContaining('Limiter')]);
  const compressor = slots.getByRole('switch', { name: /Compressor/ });expect(compressor).not.toBeChecked();
  fireEvent.click(compressor);
  expect(onMaster).toHaveBeenCalledTimes(1);expect(onMaster).toHaveBeenLastCalledWith({ ...defaultMaster(), compressor: { ...defaultMaster().compressor, enabled: true } });
  const edit = screen.getByRole('button', { name: 'Edit Reverb' });expect(edit).toHaveAttribute('aria-haspopup', 'dialog');fireEvent.click(edit);
  const dialog = screen.getByRole('dialog', { name: 'Sound mastering' });
  expect(within(dialog).getByText('Reverb', { selector: 'summary' }).parentElement).toHaveAttribute('open');
  expect(within(dialog).getByRole('button', { name: 'Reset master' })).toBeInTheDocument();
});

it('a mastering switch refuses while disabled and keeps focus', () => {
  const { onMaster } = setup({ masterDisabled: true });
  const eq = screen.getByRole('switch', { name: /EQ/ });eq.focus();fireEvent.click(eq);
  expect(onMaster).not.toHaveBeenCalled();expect(eq).toHaveFocus();expect(eq).not.toBeDisabled();expect(eq).toHaveAttribute('aria-disabled', 'true');
});

it('the initial tempo is compared as a number: 120.0 or a leading space over a tempo of 120 records nothing, and a real change is one edit', () => {
  const { onEdit, score } = setup();
  const tempo = screen.getByLabelText('Initial tempo');
  const value = score.tempo;
  fireEvent.change(tempo, { target: { value: `${value}.0` } });fireEvent.blur(tempo);
  fireEvent.change(tempo, { target: { value: ` ${value}` } });fireEvent.blur(tempo);
  expect(onEdit).not.toHaveBeenCalled();expect(tempo).toHaveValue(value);
  fireEvent.change(tempo, { target: { value: String(value + 5) } });fireEvent.blur(tempo);
  expect(onEdit).toHaveBeenCalledTimes(1);expect(onEdit).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'setScoreInfo', tempo: value + 5 }));
});
