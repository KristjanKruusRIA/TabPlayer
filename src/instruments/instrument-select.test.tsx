// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { model, Settings } from '@coderline/alphatab';
import { buildPlaybackPlan } from '../audio/plan';
import type { BeatTarget } from '../project';
import { InstrumentView } from './InstrumentView';
import { LiveInstrumentView } from './LiveInstrumentView';
import { writeInstrumentViewPreferences } from './view-preferences';

afterEach(() => { cleanup(); localStorage.clear(); });
type Spec = [number, number][];
/** One bar of quarter beats. Fretted: [string, fret] pairs; keyboard: [octave, tone] pairs. */
function music(beats: Spec[], keyboard = false, percussion = false) {
  const score = new model.Score(), track = new model.Track(), staff = new model.Staff(); track.name = percussion ? 'Drums' : 'Guitar'; track.playbackInfo.program = keyboard ? 0 : 25;
  if (!keyboard) staff.stringTuning.tunings = [64, 59, 55, 50, 45, 40];
  if (percussion) { staff.isPercussion = true; track.playbackInfo.primaryChannel = track.playbackInfo.secondaryChannel = 9; }
  track.addStaff(staff); score.addTrack(track); score.addMasterBar(new model.MasterBar());
  const bar = new model.Bar(), voice = new model.Voice();
  for (const spec of beats) {
    const beat = new model.Beat(); beat.duration = model.Duration.Quarter;
    for (const [a, b] of spec) { const note = new model.Note(); if (percussion) note.percussionArticulation = a; else if (keyboard) { note.octave = a; note.tone = b; } else { note.string = a; note.fret = b; } beat.addNote(note); }
    voice.addBeat(beat);
  }
  bar.addVoice(voice); staff.addBar(bar); score.finish(new Settings());
  return { score, notes: buildPlaybackPlan(score, 1).notes };
}
const at = (beat: number): BeatTarget => ({ track: 0, staff: 0, bar: 0, voice: 0, beat });
type Fixture = ReturnType<typeof music>;
const view = ({ score, notes }: Fixture, props: Partial<Parameters<typeof InstrumentView>[0]> = {}) => <InstrumentView score={score} track={0} staff={0} notes={notes} {...props} />;
/** G2 (string 1 fret 3) in beats 1 and 3, A2 (string 2 fret 0) in beat 2. */
const repeated = () => music([[[1, 3]], [[2, 0]], [[1, 3]]]);

it('selects the matching note in the score when a note on the neck is clicked, and tells the score how it was picked', () => {
  const fixture = music([[[1, 0], [5, 1]], [[2, 0]]]), onSelect = vi.fn(), { container } = render(view(fixture, { onSelect }));
  fireEvent.click(container.querySelector('.fret-pick[data-string="5"]')!, { detail: 1 });
  expect(onSelect).toHaveBeenCalledWith(at(0), 5, 1, 'pointer');
  fireEvent.click(container.querySelector('.fret-pick[data-string="2"]')!, { detail: 1 });
  expect(onSelect).toHaveBeenLastCalledWith(at(1), 2, 0, 'pointer');
  expect(onSelect).toHaveBeenCalledTimes(2);
});

it('lets keyboard users select a note on the neck, names the control with its octave and beat, and reports a keyboard pick', () => {
  const fixture = music([[[1, 0], [5, 1]], [[2, 0]]]), onSelect = vi.fn(); render(view(fixture, { onSelect }));
  const note = screen.getByRole('button', { name: 'Select C4 in the score, bar 1, beat 1' });
  fireEvent.keyDown(note, { key: 'Enter' }); fireEvent.keyDown(note, { key: ' ' }); fireEvent.keyDown(note, { key: 'a' });
  expect(onSelect).toHaveBeenCalledTimes(2); expect(onSelect).toHaveBeenLastCalledWith(at(0), 5, 1, 'keyboard');
});

it('offers one button per position on the neck, selects the first occurrence and then walks the repeats of the bar, wrapping', () => {
  const fixture = repeated(), onSelect = vi.fn(), { container, rerender } = render(view(fixture, { onSelect }));
  expect(container.querySelectorAll('.fret-pick')).toHaveLength(2);
  expect(screen.getAllByRole('button', { name: /^Select G2/ })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Select G2 in the score, bar 1, beat 1' }), { detail: 1 });
  expect(onSelect).toHaveBeenLastCalledWith(at(0), 1, 0, 'pointer');
  rerender(view(fixture, { onSelect, selected: { target: at(0), noteIndex: 0 } }));
  fireEvent.click(screen.getByRole('button', { name: 'Select G2 in the score, bar 1, beat 3' }), { detail: 1 });
  expect(onSelect).toHaveBeenLastCalledWith(at(2), 1, 0, 'pointer');
  rerender(view(fixture, { onSelect, selected: { target: at(2), noteIndex: 0 } }));
  fireEvent.click(screen.getByRole('button', { name: 'Select G2 in the score, bar 1, beat 1' }), { detail: 1 });
  expect(onSelect).toHaveBeenLastCalledWith(at(0), 1, 0, 'pointer');
  // A beat selected without a note does not count as that note being selected.
  rerender(view(fixture, { onSelect, selected: { target: at(0), noteIndex: null } }));
  expect(screen.getByRole('button', { name: 'Select G2 in the score, bar 1, beat 1' })).toBeInTheDocument();
});

it('does the same on the keyboard: one button per key, first occurrence first, then the next in the bar', () => {
  const fixture = music([[[5, 7]], [[5, 9]], [[5, 7]]], true), onSelect = vi.fn(), { container, rerender } = render(view(fixture, { onSelect }));
  expect(container.querySelectorAll('g[data-key][role="button"]')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Select G4 in the score, bar 1, beat 1' }), { detail: 1 });
  expect(onSelect).toHaveBeenLastCalledWith(at(0), undefined, 0, 'pointer');
  rerender(view(fixture, { onSelect, selected: { target: at(0), noteIndex: 0 } }));
  fireEvent.click(screen.getByRole('button', { name: 'Select G4 in the score, bar 1, beat 3' }), { detail: 1 });
  expect(onSelect).toHaveBeenLastCalledWith(at(2), undefined, 0, 'pointer');
  rerender(view(fixture, { onSelect, selected: { target: at(2), noteIndex: 0 } }));
  expect(screen.getByRole('button', { name: 'Select G4 in the score, bar 1, beat 1' })).toBeInTheDocument();
  fireEvent.click(container.querySelector('g[data-key="62"]')!, { detail: 1 });
  expect(onSelect).toHaveBeenCalledTimes(2);
});

it('selects the right note of a unison by the index the plan carries, not by guessing the pitch', () => {
  // A2 is played on string 1 fret 5 and on string 2 fret 0 in the same beat.
  const fixture = music([[[1, 5], [2, 0]]]), onSelect = vi.fn(), { rerender } = render(view(fixture, { onSelect, lockedMode: 'keys' }));
  fireEvent.click(screen.getByRole('button', { name: 'Select A2 in the score, bar 1, beat 1' }), { detail: 1 });
  expect(onSelect).toHaveBeenLastCalledWith(at(0), 1, 0, 'pointer');
  rerender(view(fixture, { onSelect, lockedMode: 'keys', selected: { target: at(0), noteIndex: 0 } }));
  fireEvent.click(screen.getByRole('button', { name: 'Select A2 in the score, bar 1, beat 1' }), { detail: 1 });
  expect(onSelect).toHaveBeenLastCalledWith(at(0), 2, 1, 'pointer');
});

it('exposes the marks as a group, not an image, exactly when they can be used', () => {
  const fixture = repeated(), plain = render(view(fixture));
  expect(screen.getByRole('img', { name: 'Guitar fretboard' })).toBeInTheDocument(); plain.unmount();
  render(view(fixture, { onSelect: () => {} }));
  expect(screen.getByRole('group', { name: 'Guitar fretboard' })).toBeInTheDocument(); expect(screen.queryByRole('img', { name: 'Guitar fretboard' })).toBeNull(); cleanup();
  const keys = music([[[5, 7]]], true); render(view(keys)); expect(screen.getByRole('img', { name: 'Keyboard' })).toBeInTheDocument(); cleanup();
  render(view(keys, { onSelect: () => {} })); expect(screen.getByRole('group', { name: 'Keyboard' })).toBeInTheDocument();
});

it('keeps one tab stop per instrument and moves between marks with the arrows in musical order, Home and End', () => {
  // Musical order: beat first, then string: G2 (beat 1), A2 (beat 2), then the second G2 shares the first one's button.
  const fixture = music([[[1, 3], [3, 0]], [[2, 0]]]), { container } = render(view(fixture, { onSelect: () => {} }));
  const marks = [...container.querySelectorAll<SVGGElement>('.fret-pick')];
  expect(marks).toHaveLength(3); expect(marks.filter(mark => mark.getAttribute('tabindex') === '0')).toHaveLength(1);
  const names = () => marks.map(mark => mark.getAttribute('data-string'));
  expect(names()).toEqual(['1', '3', '2']);
  marks[0].focus(); fireEvent.keyDown(marks[0], { key: 'ArrowRight' });
  expect(marks[1]).toHaveFocus(); expect(marks[1]).toHaveAttribute('tabindex', '0'); expect(marks[0]).toHaveAttribute('tabindex', '-1');
  fireEvent.keyDown(marks[1], { key: 'ArrowDown' }); expect(marks[2]).toHaveFocus();
  fireEvent.keyDown(marks[2], { key: 'ArrowLeft' }); expect(marks[1]).toHaveFocus();
  fireEvent.keyDown(marks[1], { key: 'End' }); expect(marks[2]).toHaveFocus();
  fireEvent.keyDown(marks[2], { key: 'Home' }); expect(marks[0]).toHaveFocus();
  fireEvent.keyDown(marks[0], { key: 'ArrowLeft' }); expect(marks[0]).toHaveFocus();
});

it('does the same on the keyboard: one tab stop and arrows in order of beat, then pitch', () => {
  const fixture = music([[[5, 7], [5, 0]], [[5, 4]]], true), { container } = render(view(fixture, { onSelect: () => {} }));
  const marks = [...container.querySelectorAll<SVGGElement>('g[data-key][role="button"]')];
  expect(marks.map(mark => mark.getAttribute('data-key')).sort()).toEqual(['60', '64', '67']);
  expect(marks.filter(mark => mark.getAttribute('tabindex') === '0')).toHaveLength(1);
  const first = container.querySelector<SVGGElement>('g[data-key="60"]')!; first.focus();
  fireEvent.keyDown(first, { key: 'ArrowRight' }); expect(container.querySelector('g[data-key="67"]')).toHaveFocus();
  fireEvent.keyDown(container.querySelector('g[data-key="67"]')!, { key: 'ArrowRight' }); expect(container.querySelector('g[data-key="64"]')).toHaveFocus();
  fireEvent.keyDown(container.querySelector('g[data-key="64"]')!, { key: 'Home' }); expect(first).toHaveFocus();
});

it('shows a short message instead of selectable keys when the keyboard panel is on a percussion staff', () => {
  const fixture = music([[[38, 0]]], false, true);
  render(view(fixture, { onSelect: () => {}, lockedMode: 'keys' }));
  expect(screen.getByText('The keyboard shows pitched staves. Use the Drums view for this percussion staff.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^Select / })).toBeNull(); expect(screen.queryByRole('img', { name: 'Keyboard' })).toBeNull(); expect(screen.queryByRole('group', { name: 'Keyboard' })).toBeNull();
  cleanup();
  // Elsewhere a keyboard on a drum staff stays a plain picture: nothing there is selectable.
  const { container } = render(view(fixture, { onSelect: () => {} }));
  fireEvent.change(screen.getByLabelText('Instrument view mode'), { target: { value: 'keys' } });
  expect(container.querySelector('g[data-key][role]')).toBeNull();
});

it('keeps accessible names unique when the visible names drop the octave', () => {
  writeInstrumentViewPreferences({ noteNames: 'letter' });
  const fixture = music([[[1, 12], [5, 5]]]), { container } = render(view(fixture, { onSelect: () => {} }));
  fireEvent.change(screen.getByLabelText('Instrument view mode'), { target: { value: 'keys' } });
  const names = screen.getAllByRole('button', { name: /^Select / }).map(button => button.getAttribute('aria-label'));
  expect(names).toEqual(['Select E3 in the score, bar 1, beat 1', 'Select E4 in the score, bar 1, beat 1']);
  cleanup();
  const same = music([[[1, 12], [6, 0]]]); render(view(same));
  fireEvent.change(screen.getByLabelText('Instrument view mode'), { target: { value: 'keys' } });
  const chips = document.querySelectorAll('.instrument-note');
  expect(chips).toHaveLength(2); expect([...chips].map(chip => chip.querySelector('[aria-hidden]')?.textContent)).toEqual(['E', 'E']);
  expect([...chips].map(chip => chip.querySelector('.tp-sr')?.textContent)).toEqual(['E3', 'E4']);
  expect(container).toBeDefined();
});

const area = (element: Element) => { const [x, y, width, height] = ['x', 'y', 'width', 'height'].map(name => Number(element.getAttribute(name))); return { x, y, width, height }; };
const overlap = (a: ReturnType<typeof area>, b: ReturnType<typeof area>) => Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 1e-6 && Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 1e-6;
/** A chord on every string at fret 3, then two strings at fret 4, on a neck of the given number of strings. */
function chordNeck(strings: number) {
  const score = new model.Score(), track = new model.Track(), staff = new model.Staff(); track.name = 'Guitar'; track.playbackInfo.program = 25;
  staff.stringTuning.tunings = [64, 59, 55, 50, 45, 40, 35].slice(0, strings); track.addStaff(staff); score.addTrack(track); score.addMasterBar(new model.MasterBar());
  const bar = new model.Bar(), voice = new model.Voice();
  for (const notes of [Array.from({ length: strings }, (_, index) => [index + 1, 3]), [[1, 4], [2, 4]]]) { const beat = new model.Beat(); beat.duration = model.Duration.Quarter; for (const [string, fret] of notes) { const note = new model.Note(); note.string = string; note.fret = fret; beat.addNote(note); } voice.addBeat(beat); }
  bar.addVoice(voice); staff.addBar(bar); score.finish(new Settings());
  return { score, notes: buildPlaybackPlan(score, 1).notes };
}
it.each([6, 7])('gives every neck mark a hit area as large as its fret and string cell allows, with no two overlapping, on a %i-string neck', strings => {
  const { container } = render(view(chordNeck(strings), { onSelect: () => {} }));
  const hits = [...container.querySelectorAll('.fret-pick .fret-hit')].map(area);
  expect(hits).toHaveLength(strings + 2);
  for (let first = 0; first < hits.length; first++) for (let second = first + 1; second < hits.length; second++) expect(overlap(hits[first], hits[second]), JSON.stringify([hits[first], hits[second]])).toBe(false);
  // Neighbouring strings split the space between them: a full column is exactly one string pitch per mark, and fills the fret cell.
  const column = [...container.querySelectorAll('.fret-pick[data-fret="3"] .fret-hit')].map(area);
  expect(column).toHaveLength(strings); for (const hit of column) expect(hit.width).toBeGreaterThan(14);
  const heights = column.map(hit => hit.height), pitch = Math.min(...heights);
  expect(pitch).toBeGreaterThan(5); expect(Math.max(...heights.slice(1, -1), pitch)).toBeCloseTo(pitch, 6);
});

it('lets a lone mark reach at least 14 units up and down, since no neighbour is in the way', () => {
  const { container } = render(view(music([[[3, 5]]]), { onSelect: () => {} }));
  const [hit] = [...container.querySelectorAll('.fret-pick .fret-hit')].map(area);
  expect(hit.height).toBeGreaterThanOrEqual(14); expect(hit.width).toBeGreaterThan(14);
  expect(container.querySelector('.fret-pick .fret-hit')).toHaveAttribute('fill', 'transparent');
});

it('does nothing without a selection handler, and edits instead of selecting in entry mode', () => {
  const fixture = music([[[1, 0]]]), onSelect = vi.fn(), onEdit = vi.fn();
  const plain = render(view(fixture)); expect(plain.container.querySelector('.fret-pick')).toBeNull(); expect(plain.container.querySelector('g[data-note-id][role]')).toBeNull(); cleanup();
  const { container } = render(view({ ...fixture, notes: [] }, { onSelect, entry: { target: at(0), busy: false, onEdit } }));
  fireEvent.click(container.querySelector('[data-entry-string="3"][data-entry-fret="2"]')!, { detail: 1 });
  expect(onEdit).toHaveBeenCalledTimes(1); expect(onSelect).not.toHaveBeenCalled(); expect(container.querySelector('.fret-pick')).toBeNull();
});

it('passes the selection and the current note from the live view and keeps playback marks selectable', () => {
  const { score } = repeated(), onSelect = vi.fn(), plan = buildPlaybackPlan(score, 1), ready = { ready: true, error: null };
  const player = { subscribe: () => () => {}, getState: () => ready, activeNotes: () => plan.notes.slice(0, 1), scheduledNotes: () => null };
  const { container } = render(<LiveInstrumentView score={score} track={0} staff={0} target={at(0)} noteIndex={0} player={player as never} onSelect={onSelect} />);
  fireEvent.click(container.querySelector('.fret-pick')!, { detail: 1 });
  expect(onSelect).toHaveBeenCalledTimes(1); expect(onSelect.mock.calls[0][0]).toEqual(at(0));
});

/** Four beats of the same note, the first one played with extra attacks, so the plan holds several notes for it. */
const attackKinds = { 'tremolo picking': (beat: model.Beat) => { beat.tremoloSpeed = model.Duration.Sixteenth; }, rasgueado: (beat: model.Beat) => { beat.rasgueado = model.Rasgueado.Ii; }, 'a brushed chord': (beat: model.Beat) => { beat.brushType = model.BrushType.BrushDown; beat.brushDuration = 120; const extra = new model.Note(); extra.string = 4; extra.fret = 5; beat.addNote(extra); } };
function repeatedWithExtraAttacks(kind: keyof typeof attackKinds, keyboard: boolean) {
  const fixture = keyboard ? music([[[5, 7]], [[5, 7]], [[5, 7]], [[5, 7]]], true) : music([[[3, 5]], [[3, 5]], [[3, 5]], [[3, 5]]]);
  const beat = fixture.score.tracks[0].staves[0].bars[0].voices[0].beats[0]; attackKinds[kind](beat);
  fixture.score.finish(new Settings());
  return { ...fixture, notes: buildPlaybackPlan(fixture.score, 1).notes };
}
it.each(Object.keys(attackKinds) as (keyof typeof attackKinds)[])('walks all four beats of a repeated note when the first beat has more attacks (%s), on the neck and on the keyboard', kind => {
  for (const keyboard of [false, true]) {
    if (keyboard && kind === 'a brushed chord') continue;
    const fixture = repeatedWithExtraAttacks(kind, keyboard);
    // The plan holds more than one note for the first beat's note; that must not make the walk stand still.
    if (kind !== 'a brushed chord') expect(fixture.notes.filter(note => note.source.target.beat === 0 && note.id.split('/').at(-4) === '0').length).toBeGreaterThan(1);
    const onSelect = vi.fn(), name = keyboard ? /^Select G4 / : /^Select G3 /;
    const { rerender } = render(view(fixture, { onSelect }));
    const walked: number[] = [];
    let selected: { target: BeatTarget; noteIndex: number | null } | undefined;
    for (let step = 0; step < 5; step++) {
      fireEvent.click(screen.getAllByRole('button', { name })[0], { detail: 1 });
      const [target, , index] = onSelect.mock.lastCall!; walked.push(target.beat); selected = { target, noteIndex: index ?? null };
      rerender(view(fixture, { onSelect, selected }));
    }
    expect(walked).toEqual([0, 1, 2, 3, 0]);
    cleanup();
  }
});

it('treats a click with no pointer behind it (detail 0: assistive technology or a keyboard activation) as a keyboard pick, and a real click as a pointer pick', () => {
  const fixture = music([[[1, 3]]]), onSelect = vi.fn(); render(view(fixture, { onSelect }));
  const mark = screen.getByRole('button', { name: /^Select G2 / });
  fireEvent.click(mark, { detail: 0 }); expect(onSelect).toHaveBeenLastCalledWith(at(0), 1, 0, 'keyboard');
  fireEvent.click(mark, { detail: 1 }); expect(onSelect).toHaveBeenLastCalledWith(at(0), 1, 0, 'pointer');
  fireEvent.click(mark, { detail: 2 }); expect(onSelect).toHaveBeenLastCalledWith(at(0), 1, 0, 'pointer');
});
