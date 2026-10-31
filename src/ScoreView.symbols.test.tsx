// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { model, rendering, Settings } from '@coderline/alphatab';
import { setLanguagePreference } from './i18n';
import { ScoreView, type SymbolEditing } from './ScoreView';
import { music, target } from './editor/fixtures';
import type { EditCommand } from './edit-types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => { throw new Error('Symbol editing must not invoke native IPC.'); }) }));

const fake = vi.hoisted(() => ({ systems: [] as unknown[] }));
vi.mock('@coderline/alphatab', async original => ({ ...await original<typeof import('@coderline/alphatab')>(), AlphaTabApi: class {
  settings = new Settings();
  beatMouseDown = event<model.Beat>(); noteMouseDown = event<model.Note>(); beatMouseMove = event<model.Beat>(); beatMouseUp = event<model.Beat | null>();
  renderStarted = event<boolean>(); postRenderFinished = event<void>(); playbackRangeHighlightChanged = event<unknown>();
  canvasElement = {}; uiFacade = { getOffset: () => ({ x: 0, y: 0, w: 600, h: 300 }), highlightElements() {}, removeHighlights() {} };
  renderer = { width: 0, partialRenderFinished: event<never>() }; renderScore() {} render() {}
  get boundsLookup() { return { staffSystems: fake.systems, findBeat: () => null, findBeats: () => [], getBeatAtPos: () => null }; }
  highlightPlaybackRange() {} clearPlaybackRangeHighlight() {} destroy() {} updateSettings() {}
} }));
function event<T>() { const handlers = new Set<(value: T) => void>(); return { on: (handler: (value: T) => void) => { handlers.add(handler); return () => handlers.delete(handler); }, off: (handler: (value: T) => void) => handlers.delete(handler), emit: (value: T) => { for (const handler of handlers) handler(value); } }; }

const G_CLEF = String.fromCodePoint(0xe050);
const chordAt = { track: 0, staff: 0, bar: 1, voice: 0, beat: 2 };

/** Two measures of 200px in one system, as alphaTab would report them; the test supplies the <text> alphaTab would draw. */
function document_() {
  const score = music(), staff = score.tracks[0].staves[0];
  score.title = 'Etude';
  const chord = new model.Chord();
  chord.name = 'Am'; chord.strings = [0, 0, 2, 2, 1, 0]; chord.showName = true;
  staff.addChord('c1', chord);
  staff.bars[1].voices[0].beats[2].chordId = 'c1';
  score.masterBars[0].tempoAutomations = [model.Automation.buildTempoAutomation(false, 0, 120, 2)];
  score.masterBars[1].tempoAutomations = [model.Automation.buildTempoAutomation(false, 0.5, 140, 2)];
  const system = new rendering.StaffSystemBounds();
  system.visualBounds = new rendering.Bounds(0, 0, 400, 140); system.realBounds = new rendering.Bounds(0, 0, 400, 140);
  [0, 1].forEach(index => {
    const master = new rendering.MasterBarBounds();
    master.index = index; master.realBounds = new rendering.Bounds(index * 200, 0, 200, 140); master.visualBounds = master.realBounds;
    const row = new rendering.BarBounds();
    row.bar = staff.bars[index]; row.realBounds = new rendering.Bounds(index * 200, 40, 200, 60); row.visualBounds = new rendering.Bounds(index * 200, 20, 200, 100); row.masterBarBounds = master;
    staff.bars[index].voices[0].beats.forEach((beat, at) => {
      const bounds = new rendering.BeatBounds();
      bounds.beat = beat; bounds.realBounds = new rendering.Bounds(index * 200 + 20 + at * 45, 40, 40, 60); bounds.barBounds = row; row.beats.push(bounds);
    });
    master.bars.push(row); master.staffSystemBounds = system; system.bars.push(master);
  });
  fake.systems = [system];
  score.finish(new Settings());
  return score;
}

function setup(patch: Partial<SymbolEditing> = {}, score = document_()) {
  const onEdit = vi.fn<(command: EditCommand) => void>(), onChordEditor = vi.fn(), onSelect = vi.fn();
  const symbols: SymbolEditing = { busy: false, locked: null, onEdit, onChordEditor, ...patch };
  const props = { score, track: 0, zoom: 100, profile: 'ScoreTab', playback: null, onSelect, editTarget: target, editString: 6 };
  const result = render(<ScoreView {...props} symbols={symbols}/>);
  const notation = screen.getByLabelText('Music notation');
  const draw = (text: string) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), element = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    element.textContent = text; svg.appendChild(element); notation.appendChild(svg);
    return element as unknown as HTMLElement;
  };
  const wrapper = notation.closest('.score-presentation') as HTMLElement;
  return { ...result, props, symbols, score, onEdit, onChordEditor, onSelect, notation, draw, wrapper, rerender: (next: Partial<SymbolEditing>) => result.rerender(<ScoreView {...props} symbols={{ ...symbols, ...next }}/>), rerenderScore: (next: model.Score) => result.rerender(<ScoreView {...props} score={next} symbols={symbols}/>) };
}
afterEach(() => { cleanup(); vi.clearAllMocks(); fake.systems = []; });

it('edits the title in place: Enter records one setScoreInfo and focus returns to the score', () => {
  const view = setup();
  view.wrapper.focus();
  fireEvent.doubleClick(view.draw('Etude'), { clientX: 60, clientY: -20 });
  const dialog = screen.getByRole('dialog', { name: 'Title' }), field = within(dialog).getByRole('textbox') as HTMLInputElement;
  expect(document.activeElement).toBe(field);
  expect(field.value).toBe('Etude');
  fireEvent.change(field, { target: { value: 'Nocturne' } });
  fireEvent.submit(dialog);
  expect(view.onEdit).toHaveBeenCalledTimes(1);
  expect(view.onEdit).toHaveBeenCalledWith({ type: 'setScoreInfo', title: 'Nocturne', artist: view.score.artist, tempo: view.score.tempo });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(view.wrapper);
});

it('records nothing for the current value, and Escape cancels and returns focus', () => {
  const view = setup();
  view.wrapper.focus();
  fireEvent.doubleClick(view.draw('Etude'), { clientX: 60, clientY: -20 });
  fireEvent.submit(screen.getByRole('dialog', { name: 'Title' }));
  expect(view.onEdit).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(view.wrapper);

  fireEvent.doubleClick(view.draw('Etude'), { clientX: 60, clientY: -20 });
  const field = screen.getByRole('textbox');
  fireEvent.change(field, { target: { value: 'Something else' } });
  const stray = vi.fn();
  document.addEventListener('keydown', stray);
  fireEvent.keyDown(field, { key: 'Escape' });
  document.removeEventListener('keydown', stray);
  expect(view.onEdit).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(view.wrapper);
  // The key never reached the score's own shortcuts (Escape clears the selection there).
  expect(stray).not.toHaveBeenCalled();
});

it('edits a tempo mark: the initial one through setScoreInfo, a later one through setMeasureSettings, and a bad value is explained', () => {
  const view = setup();
  fireEvent.doubleClick(view.draw(' = 120'), { clientX: 20, clientY: 10 });
  expect(screen.getByRole('dialog', { name: 'Tempo (BPM)' })).toBeTruthy();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '90' } });
  fireEvent.submit(screen.getByRole('dialog'));
  expect(view.onEdit).toHaveBeenLastCalledWith({ type: 'setScoreInfo', title: 'Etude', artist: view.score.artist, tempo: 90 });

  fireEvent.doubleClick(view.draw(' = 140'), { clientX: 300, clientY: 10 });
  const field = screen.getByRole('textbox');
  expect((field as HTMLInputElement).value).toBe('140');
  fireEvent.change(field, { target: { value: 'quick' } });
  fireEvent.submit(screen.getByRole('dialog'));
  expect(screen.getByRole('alert').textContent).toBe('Type a tempo from 1 to 999 BPM.');
  expect(field.getAttribute('aria-invalid')).toBe('true');
  expect(view.onEdit).toHaveBeenCalledTimes(1);
  fireEvent.change(field, { target: { value: '150' } });
  fireEvent.submit(screen.getByRole('dialog'));
  expect(view.onEdit).toHaveBeenCalledTimes(2);
  expect(view.onEdit.mock.calls[1][0]).toMatchObject({ type: 'setMeasureSettings', bar: 1, tempos: [{ bpm: 150 }] });
});

it('edits a chord name in place', () => {
  const view = setup();
  fireEvent.doubleClick(view.draw('Am'), { clientX: 330, clientY: 10 });
  const field = screen.getByRole('textbox', { name: 'Chord name' }) as HTMLInputElement;
  expect(field.value).toBe('Am');
  fireEvent.change(field, { target: { value: 'Am7' } });
  fireEvent.submit(screen.getByRole('dialog'));
  expect(view.onEdit).toHaveBeenCalledTimes(1);
  expect(view.onEdit.mock.calls[0][0]).toMatchObject({ type: 'setHarmonyChord', target: chordAt, chord: { name: 'Am7', nameMode: 'manual', recipe: null } });
});

it('picks a clef from a menu of choices with the current one checked; the current one records nothing', () => {
  const view = setup();
  view.wrapper.focus();
  fireEvent.doubleClick(view.draw(G_CLEF), { clientX: 210, clientY: 60 });
  const menu = screen.getByRole('menu', { name: 'Clef, measure 2' });
  const items = within(menu).getAllByRole('menuitemradio');
  expect(items.map(item => item.textContent)).toEqual(['✓Treble clef', 'Bass clef', 'Alto clef', 'Tenor clef', 'Neutral (percussion) clef']);
  expect(items.map(item => item.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false', 'false', 'false']);
  expect(document.activeElement).toBe(items[0]);
  fireEvent.keyDown(items[0], { key: 'ArrowDown' });
  expect(document.activeElement).toBe(items[1]);
  fireEvent.keyDown(items[1], { key: 'End' });
  expect(document.activeElement).toBe(items[4]);
  fireEvent.keyDown(items[4], { key: 'Home' });
  fireEvent.click(items[0]);
  expect(view.onEdit).not.toHaveBeenCalled();
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(view.wrapper);

  fireEvent.doubleClick(view.draw(G_CLEF), { clientX: 210, clientY: 60 });
  fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitemradio', { name: /Bass clef/ }));
  expect(view.onEdit).toHaveBeenCalledTimes(1);
  expect(view.onEdit.mock.calls[0][0]).toMatchObject({ type: 'setBarNotation', track: 0, staff: 0, bar: 1, clef: model.Clef.F4 });
});

it('opens a context menu with the actions that fit the clicked symbol', () => {
  const view = setup();
  const chord = view.draw('Am');
  expect(fireEvent.contextMenu(chord, { clientX: 330, clientY: 10 })).toBe(false);
  const menu = screen.getByRole('menu', { name: 'Chord Am' });
  expect(within(menu).getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Edit chord name…', 'Open chord editor…', 'Remove chord']);
  fireEvent.click(within(menu).getByRole('menuitem', { name: 'Remove chord' }));
  expect(view.onEdit).toHaveBeenCalledTimes(1);
  expect(view.onEdit.mock.calls[0][0]).toEqual({ type: 'setHarmonyChord', target: chordAt, chord: null, fillEmptyBeat: false });
  expect(screen.queryByRole('menu')).toBeNull();

  fireEvent.contextMenu(view.draw('Am'), { clientX: 330, clientY: 10 });
  fireEvent.click(screen.getByRole('menuitem', { name: 'Open chord editor…' }));
  expect(view.onChordEditor).toHaveBeenCalledWith(chordAt);
  expect(view.onEdit).toHaveBeenCalledTimes(1);

  fireEvent.contextMenu(view.draw(' = 140'), { clientX: 300, clientY: 10 });
  expect(within(screen.getByRole('menu', { name: 'Tempo, measure 2' })).getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Edit tempo…', 'Remove tempo change']);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Remove tempo change' }));
  expect(view.onEdit.mock.calls[1][0]).toMatchObject({ type: 'setMeasureSettings', bar: 1, tempos: [] });

  fireEvent.contextMenu(view.draw(' = 120'), { clientX: 20, clientY: 10 });
  expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Edit tempo…']);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Edit tempo…' }));
  expect(screen.getByRole('textbox', { name: 'Tempo (BPM)' })).toBeTruthy();
});

it('leaves everything that is not a score symbol alone', () => {
  const view = setup();
  expect(fireEvent.contextMenu(view.notation, { clientX: 100, clientY: 70 })).toBe(true);
  fireEvent.doubleClick(view.notation, { clientX: 100, clientY: 70 });
  fireEvent.doubleClick(view.draw('Hello'), { clientX: 100, clientY: 70 });
  expect(fireEvent.contextMenu(view.draw('Am'), { clientX: 100, clientY: 10 })).toBe(true);
  expect(screen.queryByRole('menu')).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(view.onEdit).not.toHaveBeenCalled();
});

it('without symbol editing the score only selects', () => {
  const view = setup();
  view.rerender({});
  cleanup();
  const score = document_();
  render(<ScoreView score={score} track={0} zoom={100} profile="ScoreTab" playback={null} onSelect={vi.fn()} editTarget={target} editString={6}/>);
  const notation = screen.getByLabelText('Music notation'), svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  text.textContent = 'Etude'; svg.appendChild(text); notation.appendChild(svg);
  expect(fireEvent.contextMenu(text)).toBe(true);
  fireEvent.doubleClick(text);
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('keeps a locked document unchanged: the menu explains and every action is unavailable but focusable', () => {
  const view = setup({ locked: 'This score is finalized.' });
  fireEvent.doubleClick(view.draw('Etude'), { clientX: 60, clientY: -20 });
  expect(screen.queryByRole('textbox')).toBeNull();
  const item = screen.getByRole('menuitem', { name: 'Edit title…' });
  expect(within(screen.getByRole('menu')).getByRole('status').textContent).toBe('This score is finalized.');
  expect(item.getAttribute('aria-disabled')).toBe('true');
  expect(item.hasAttribute('disabled')).toBe(false);
  act(() => item.focus());
  expect(document.activeElement).toBe(item);
  fireEvent.click(item);
  fireEvent.keyDown(item, { key: 'Enter' });
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(view.onEdit).not.toHaveBeenCalled();

  fireEvent.keyDown(item, { key: 'Escape' });
  fireEvent.contextMenu(view.draw('Am'), { clientX: 330, clientY: 10 });
  for (const name of ['Edit chord name…', 'Open chord editor…', 'Remove chord']) {
    const entry = screen.getByRole('menuitem', { name });
    expect(entry.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(entry);
  }
  expect(view.onEdit).not.toHaveBeenCalled();
  expect(view.onChordEditor).not.toHaveBeenCalled();
});

it('never disables a focus-holding control while busy: the editor opens, keeps focus and refuses to record', () => {
  const view = setup({ busy: true });
  fireEvent.doubleClick(view.draw('Etude'), { clientX: 60, clientY: -20 });
  const field = screen.getByRole('textbox') as HTMLInputElement, apply = screen.getByRole('button', { name: 'Apply' });
  expect(field.disabled).toBe(false);
  expect(apply.hasAttribute('disabled')).toBe(false);
  expect(apply.getAttribute('aria-disabled')).toBe('true');
  expect(document.activeElement).toBe(field);
  fireEvent.change(field, { target: { value: 'Changed' } });
  fireEvent.click(apply);
  fireEvent.submit(screen.getByRole('dialog'));
  expect(view.onEdit).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(screen.getAllByRole('status').map(node => node.textContent)).toContain('Wait for the current operation to finish.');
  expect(document.activeElement).toBe(field);
  // When the operation ends the same editor records.
  view.rerender({ busy: false });
  fireEvent.submit(screen.getByRole('dialog'));
  expect(view.onEdit).toHaveBeenCalledTimes(1);

  fireEvent.contextMenu(view.draw('Am'), { clientX: 330, clientY: 10 });
  view.rerender({ busy: true });
  const remove = screen.getByRole('menuitem', { name: 'Remove chord' });
  expect(remove.hasAttribute('disabled')).toBe(false);
  expect(remove.getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(remove);
  expect(view.onEdit).toHaveBeenCalledTimes(1);
});

it('opens the target menu from the keyboard and walks it with the arrow keys', () => {
  const view = setup();
  view.wrapper.focus();
  fireEvent.keyDown(view.wrapper, { key: 'F10', shiftKey: true });
  const menu = screen.getByRole('menu', { name: 'Score symbols' });
  expect(within(menu).getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Edit title…', 'Edit tempo 120, measure 1…', 'Change clef, measure 1…']);
  const first = within(menu).getAllByRole('menuitem')[0];
  expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first, { key: 'ArrowUp' });
  expect(document.activeElement).toBe(within(menu).getAllByRole('menuitem')[2]);
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(view.wrapper);

  fireEvent.keyDown(view.wrapper, { key: 'ContextMenu' });
  fireEvent.click(screen.getByRole('menuitem', { name: 'Edit title…' }));
  const field = screen.getByRole('textbox', { name: 'Title' });
  expect(document.activeElement).toBe(field);
  fireEvent.change(field, { target: { value: 'Keys' } });
  fireEvent.keyDown(field, { key: 'Enter' });
  fireEvent.submit(screen.getByRole('dialog'));
  expect(view.onEdit).toHaveBeenCalledWith(expect.objectContaining({ type: 'setScoreInfo', title: 'Keys' }));
});

it('opens the target menu when the app asks for it, and includes the chord on the target beat', () => {
  const view = setup();
  view.rerender({ request: 1 });
  expect(screen.getByRole('menu', { name: 'Score symbols' })).toBeTruthy();
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  // The same request count does not open it again.
  view.rerender({ request: 1 });
  expect(screen.queryByRole('menu')).toBeNull();
  const moved = { ...view.props, editTarget: chordAt };
  view.unmount();
  const second = render(<ScoreView {...moved} symbols={{ busy: false, locked: null, onEdit: view.onEdit, onChordEditor: view.onChordEditor, request: 0 }}/>);
  second.rerender(<ScoreView {...moved} symbols={{ busy: false, locked: null, onEdit: view.onEdit, onChordEditor: view.onChordEditor, request: 1 }}/>);
  expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Edit title…', 'Edit tempo 140, measure 2…', 'Remove tempo change 140, measure 2', 'Edit chord name Am…', 'Open chord editor…', 'Remove chord', 'Change clef, measure 2…']);
});

it('closes unrecorded when focus or the pointer goes elsewhere, or the score changes', () => {
  const view = setup();
  fireEvent.doubleClick(view.draw('Etude'), { clientX: 60, clientY: -20 });
  fireEvent.mouseDown(document.body);
  expect(screen.queryByRole('dialog')).toBeNull();

  fireEvent.doubleClick(view.draw('Etude'), { clientX: 60, clientY: -20 });
  const outside = document.createElement('button');
  document.body.appendChild(outside);
  act(() => outside.focus());
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(outside);
  outside.remove();

  fireEvent.doubleClick(view.draw('Etude'), { clientX: 60, clientY: -20 });
  expect(screen.getByRole('dialog')).toBeTruthy();
  view.rerender({});
  view.unmount();
  expect(view.onEdit).not.toHaveBeenCalled();
});

it('does not steal clicks inside the editor for score selection', () => {
  const view = setup();
  fireEvent.doubleClick(view.draw('Etude'), { clientX: 60, clientY: -20 });
  const field = screen.getByRole('textbox');
  expect(fireEvent.mouseDown(field, { button: 0 })).toBe(true);
  expect(screen.getByRole('dialog')).toBeTruthy();
});

it.each([['et', 'Pealkiri', 'Rakenda', 'Loobu'], ['de', 'Titel', 'Anwenden', 'Abbrechen']] as const)('shows its text in %s', (language, title, apply, cancel) => {
  setLanguagePreference(language);
  try {
    const view = setup();
    fireEvent.doubleClick(view.draw('Etude'), { clientX: 60, clientY: -20 });
    expect(screen.getByRole('dialog', { name: title })).toBeTruthy();
    expect(screen.getByRole('button', { name: apply })).toBeTruthy();
    expect(screen.getByRole('button', { name: cancel })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    fireEvent.contextMenu(view.draw('Am'), { clientX: 330, clientY: 10 });
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map(item => item.textContent).every(text => text && !/^(Edit|Remove|Open)/.test(text))).toBe(true);
  } finally { setLanguagePreference('en'); }
});

it('keeps the editor and what was typed when the edit is refused, and closes once it lands', async () => {
  const outcome: { resolve: (landed: boolean) => void }[] = [];
  const view = setup({ onEdit: vi.fn(() => new Promise<boolean>(resolve => { outcome.push({ resolve }); })) });
  view.wrapper.focus();
  fireEvent.doubleClick(view.draw('Etude'), { clientX: 60, clientY: -20 });
  const field = screen.getByRole('textbox') as HTMLInputElement;
  fireEvent.change(field, { target: { value: 'Refused title' } });
  fireEvent.submit(screen.getByRole('dialog'));
  // Nothing is sent twice while the first is in flight, and the editor stays until it has settled.
  fireEvent.submit(screen.getByRole('dialog'));
  expect(outcome).toHaveLength(1);
  expect(screen.getByRole('dialog')).toBeTruthy();
  await act(async () => outcome[0].resolve(false));
  expect(screen.getByRole('alert').textContent).toBe('The change was not applied.');
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Refused title');
  fireEvent.submit(screen.getByRole('dialog'));
  expect(outcome).toHaveLength(2);
  await act(async () => outcome[1].resolve(true));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(view.wrapper);
});

it('keeps focus on the score when the score changes under an open popover', () => {
  const view = setup();
  view.wrapper.focus();
  fireEvent.doubleClick(view.draw('Etude'), { clientX: 60, clientY: -20 });
  expect(document.activeElement).toBe(screen.getByRole('textbox'));
  view.rerenderScore(document_());
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(view.wrapper);
});

it('keeps the browser menu from opening over ours, except inside the text field', () => {
  const view = setup();
  fireEvent.contextMenu(view.draw('Am'), { clientX: 330, clientY: 10 });
  expect(fireEvent.contextMenu(screen.getByRole('menuitem', { name: 'Remove chord' }))).toBe(false);
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  fireEvent.doubleClick(view.draw('Etude'), { clientX: 60, clientY: -20 });
  expect(fireEvent.contextMenu(screen.getByRole('textbox'))).toBe(true);
});
