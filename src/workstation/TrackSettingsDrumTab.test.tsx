// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { model } from '@coderline/alphatab';
import { buildDocument, previewEdit, replayDocumentSettings, trackIdentity, } from '../engine';
import { blankProject, type EditCommand } from '../project';
import { readStaffSettings } from '../editor/staff-settings';
import { defaultEngraving, projectEngraving } from '../engraving/projection';
import { drumTabLeftOff } from '../engraving/drum-tab-status';
import { kitScore } from '../engraving/drum-tab-fixtures';
import { TrackSettingsPanel } from './TrackSettingsPanel';
type Doc = ReturnType<typeof previewEdit>;
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => ({ format: 'tabplayer-tuning-library', version: 1, entries: [] })) }));
afterEach(cleanup);

/** A score with a guitar and a drum track holding a kick, a snare and a closed hi-hat in one beat. */
function authored(): Doc {
  let built = previewEdit(blankProject(), { type: 'addPercussionTrack', name: 'Drums', program: 0 });
  const track = built.score.tracks.findIndex(candidate => candidate.isPercussion);
  for (const articulation of [36, 38, 42]) built = previewEdit(built.project, { type: 'addPercussionNote', target: { track, staff: 0, bar: 0, voice: 0, beat: 0 }, articulation }, built);
  return built;
}
const drumIndex = (score: model.Score) => score.tracks.findIndex(track => track.isPercussion);
const tabButton = () => screen.getByRole('button', { name: 'Show tablature' });
const standardButton = () => screen.getByRole('button', { name: 'Show notation' });
const pressed = () => [tabButton(), standardButton()].map(button => button.getAttribute('aria-pressed'));

/** The panel on a live document: every edit is applied the way the app does, and the documents are kept so the tests can undo and redo. */
function Harness({ start, log }: { start: Doc; log: { edits: EditCommand[]; documents: Doc[] } }) {
  const [built, setBuilt] = useState(start);
  log.documents.push(built);
  return <TrackSettingsPanel score={built.score} selected={drumIndex(built.score)} busy={false} engraving={built.settings.engraving} onEdit={command => { log.edits.push(command); setBuilt(previewEdit(built.project, command, built)); return true; }} />;
}

it('a drum track reads its profile: standard alone today, tablature alone, or both', () => {
  const built = authored(), id = trackIdentity(built.score.tracks[drumIndex(built.score)]);
  const shows = (profile: string | null) => {
    cleanup();
    render(<TrackSettingsPanel score={built.score} selected={drumIndex(built.score)} busy={false} onEdit={vi.fn()} engraving={{ ...defaultEngraving(), profiles: profile ? [{ trackId: id, profile: profile as never }] : [] }} />);
    return pressed();
  };
  expect(shows(null)).toEqual(['false', 'true']);
  expect(shows('standard')).toEqual(['false', 'true']);
  expect(shows('tablature')).toEqual(['true', 'false']);
  expect(shows('standardTab')).toEqual(['true', 'true']);
});

it('each gesture is one setEngraving edit, never a staff-settings edit, and the only notation that is on does nothing when pressed', () => {
  const built = authored(), onEdit = vi.fn(), id = trackIdentity(built.score.tracks[drumIndex(built.score)]);
  render(<TrackSettingsPanel score={built.score} selected={drumIndex(built.score)} busy={false} onEdit={onEdit} engraving={defaultEngraving()} />);
  const standard = standardButton();
  standard.focus();
  fireEvent.click(standard);
  expect(onEdit).not.toHaveBeenCalled();
  expect(standard).toHaveAttribute('aria-disabled', 'true');
  expect(standard).not.toBeDisabled();
  expect(standard).toHaveFocus();
  expect(document.getElementById(standard.getAttribute('aria-describedby')!)).toHaveTextContent('One of the two always stays on');
  expect(standard.title).toContain('One of the two always stays on');
  fireEvent.click(tabButton());
  expect(onEdit).toHaveBeenCalledTimes(1);
  expect(onEdit.mock.calls[0][0]).toMatchObject({ type: 'setEngraving', engraving: { profiles: [{ trackId: id, profile: 'standardTab' }] } });
});

it('toggling through the document: one undoable step each, undo and redo restore the profile, and the source is never edited', () => {
  const start = authored(), log = { edits: [] as EditCommand[], documents: [] as Doc[] }, before = start.project.edits.length;
  const sourceJson = model.JsonConverter.scoreToJson(start.score);
  render(<Harness start={start} log={log} />);
  expect(pressed()).toEqual(['false', 'true']);
  fireEvent.click(tabButton());
  expect(pressed()).toEqual(['true', 'true']);
  fireEvent.click(standardButton());
  expect(pressed()).toEqual(['true', 'false']);
  // The one that is now the only one on does nothing.
  fireEvent.click(tabButton());
  expect(log.edits.map(edit => edit.type)).toEqual(['setEngraving', 'setEngraving']);
  fireEvent.click(standardButton());
  expect(pressed()).toEqual(['true', 'true']);
  fireEvent.click(tabButton());
  expect(pressed()).toEqual(['false', 'true']);
  expect(log.edits).toHaveLength(4);
  const last = log.documents.at(-1)!;
  expect(last.project.edits.length).toBe(before + 4);
  expect(last.project.edits.slice(before).every(edit => edit.type === 'setEngraving')).toBe(true);
  expect(model.JsonConverter.scoreToJson(last.score)).toBe(sourceJson);
  // Undo replays the log one edit shorter each time; redo puts the last one back.
  let document: ReturnType<typeof replayDocumentSettings> = last;
  const profiles: Array<string | undefined> = [];
  for (let step = 1; step <= 4; step++) {
    document = replayDocumentSettings({ ...last.project, edits: last.project.edits.slice(0, -step) }, document);
    profiles.push(document.settings.engraving.profiles[0]?.profile);
  }
  expect(profiles).toEqual(['standardTab', 'tablature', 'standardTab', undefined]);
  document = replayDocumentSettings(last.project, document);
  expect(document.settings.engraving.profiles).toEqual(last.settings.engraving.profiles);
});

it('the staff-settings edits old projects hold for a drum staff still replay and show standard notation', () => {
  let built = authored();
  const track = drumIndex(built.score), staff = built.score.tracks[track].staves[0];
  const old: Extract<EditCommand, { type: 'setStaffSettings' }> = { type: 'setStaffSettings', track, staff: 0, settings: { ...readStaffSettings(staff, staff.bars[0].clef), showTab: true } };
  built = previewEdit(built.project, old, built);
  built = previewEdit(built.project, old, built);
  const reopened = buildDocument(JSON.parse(JSON.stringify(built.project)));
  expect(built.project.edits.filter(edit => edit.type === 'setStaffSettings').length).toBeGreaterThan(0);
  const drums = reopened.score.tracks[track].staves[0];
  expect(drums.isPercussion).toBe(true);
  expect(drums.showTablature).toBe(false);
  const ids = reopened.score.tracks.map(trackIdentity), projected = projectEngraving(reopened.score, ids, reopened.settings.engraving);
  expect(projected.score.tracks[track].staves).toHaveLength(1);
  expect(projected.score.tracks[track].staves[0].isPercussion).toBe(true);
  expect(projected.score.tracks[track].staves[0].showStandardNotation).toBe(true);
  expect(projected.drumTab).toBeUndefined();
  render(<TrackSettingsPanel score={reopened.score} selected={track} busy={false} onEdit={vi.fn()} engraving={reopened.settings.engraving} />);
  expect(pressed()).toEqual(['false', 'true']);
});

it('a guitar track keeps its staff-settings toggles, and showing drum tab does not change the tuning row', () => {
  const built = authored(), onEdit = vi.fn(), guitar = built.score.tracks.findIndex(track => !track.isPercussion);
  render(<TrackSettingsPanel score={built.score} selected={guitar} busy={false} onEdit={onEdit} engraving={defaultEngraving()} />);
  fireEvent.click(standardButton());
  expect(onEdit).toHaveBeenCalledTimes(1);
  expect(onEdit.mock.calls[0][0]).toMatchObject({ type: 'setStaffSettings', track: guitar, settings: { showNotation: false } });
  cleanup();
  const drums = drumIndex(built.score), id = trackIdentity(built.score.tracks[drums]);
  const tuningRow = (engraving: ReturnType<typeof defaultEngraving>) => {
    cleanup();
    const view = render(<TrackSettingsPanel score={built.score} selected={drums} busy={false} onEdit={vi.fn()} engraving={engraving} />);
    return (view.container.querySelector('.tuning-row') ?? view.container.querySelector('[class*="tuning"]'))?.outerHTML ?? '';
  };
  const plain = tuningRow(defaultEngraving()), shown = tuningRow({ ...defaultEngraving(), profiles: [{ trackId: id, profile: 'standardTab' }] });
  expect(plain).not.toBe('');
  expect(shown).toBe(plain);
});

it('explains the numbers, and says how many hits the tab left off only when some are', () => {
  const built = authored(), drums = drumIndex(built.score);
  const view = render(<TrackSettingsPanel score={built.score} selected={drums} busy={false} onEdit={vi.fn()} engraving={defaultEngraving()} />);
  const hint = document.getElementById(tabButton().getAttribute('aria-describedby')!)!;
  expect(hint).toHaveTextContent('Tab numbers are the sound numbers (36 kick, 38 snare, 42 closed hi-hat).');
  expect(hint).toHaveTextContent('Shown: Standard.');
  expect(view.container.querySelector('.notation-note')).toBeNull();
  view.rerender(<TrackSettingsPanel score={built.score} selected={drums} busy={false} onEdit={vi.fn()} engraving={defaultEngraving()} drumTabLeftOff={2} />);
  expect(view.container.querySelector('.notation-note')).toHaveTextContent('Hits left off the drum tab: 2.');
});

it('counts the hits the tab leaves off from the conversion report: none for a beat of six, one for a beat of seven', () => {
  for (const [crowded, expected] of [[false, 0], [true, 1]] as const) {
    const { score, ids } = kitScore({ crowded });
    const projected = projectEngraving(score, ids, { ...defaultEngraving(), profiles: [{ trackId: ids[1], profile: 'tablature' }] });
    expect(drumTabLeftOff(score.tracks[1], projected.drumTab)).toBe(expected);
    expect(drumTabLeftOff(score.tracks[0], projected.drumTab)).toBe(0);
  }
  expect(drumTabLeftOff(kitScore().score.tracks[1], undefined)).toBe(0);
});
