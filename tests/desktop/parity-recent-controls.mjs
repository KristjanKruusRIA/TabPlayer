// Real-app acceptance of the controls added on 2026-11-17 and 2026-11-18 (docs/validation/2026-11-17-remainder-batch-1.md, -batch-2.md,
// 2026-11-18-remainder-batch-3.md, -batch-4.md), which had only been unit-tested. One authored score (a guitar, a bass and a drum track)
// goes through the real window over CDP, with silent output, and the driver checks that
//  1. dragging a track's grip in the dock overview with real pointer events moves the track as one undoable edit, one undo restores the
//     order, a drop in place and an Escape during the drag record nothing, and Alt+Down on the focused grip moves the track and keeps
//     focus on that track's grip;
//  2. F1 inside the Export dialog opens help above it, and Escape closes the help first, leaving the dialog open with its state;
//  3. the Export dialog offers "Include count-in" (off by default) for every audio file type and not for stems, and "Apply drum maps"
//     (off by default) for MIDI; with a drum map row that changes a key the two MIDI files differ (the mapped key replaces the scored one),
//     with no map they are identical;
//  4. the chord dialog's "Play chord" and the scale panel's "Play scale" ask the native side for an audition (audio_status.auditionSerial
//     rises, playback never starts) and record no edit;
//  5. Trim to fit on an overfull bar whose last note crosses the barline announces a shortening, leaves the note present and shortened
//     (read from the Guitar Pro file the app exports), and one undo restores it;
//  6. the ASCII tab export carries the six drum tab line labels with the drum hits.
// Screenshots of every area go to .analysis/desktop-smoke/recent-controls/ (git-ignored) for a person to look at.
//
// Build with scripts/build-desktop-test.ps1, then, from the checkout root:
//   node tests/desktop/parity-recent-controls.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { directory, launch, connect, stop } from './harness.mjs';
import { waitForWorkspaceIdle, closeWelcomeLibrary, clickWorkstationButton, clickWorkspaceCommand, selectWorkspaceTrack, revealDock, revealInspectorTab, editionPalette, moveCursor, openProperties, closeProperties, revealPractice, hidePractice } from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';

const shots = resolve(directory, 'recent-controls'), folder = resolve(directory, 'recent-controls-out'), fixture = resolve(directory, 'recent-controls-fixture.gp'), gpPath = resolve(directory, 'recent-controls-export.gp');
const BARS = 3;
const TEST_PORT = 'Test MIDI output';
/** [standard id, name, staff line, MIDI key]: the drum track's own articulation table, as a Guitar Pro file writes it. */
const TABLE = [[36, 'Kick Drum', 7, 36], [38, 'Snare', 3, 38], [91, 'Snare', 3, 38], [42, 'Charley', -1, 42], [92, 'Charley', -1, 46], [46, 'Charley', -1, 46], [49, 'Crash High', -2, 49], [55, 'Splash', -2, 55], [51, 'Ride', 0, 51], [50, 'Tom Very High', 1, 50], [48, 'Tom High', 2, 48], [47, 'Tom Medium', 4, 47], [45, 'Tom Low', 5, 45]];
/** The drum hits of a bar, beat by beat, as standard sound numbers: every line of the drum tab (Cr Rd HH Tm Sn Bd) is struck, and no two hits of one beat share a line (a second hit on a busy line is moved to a free one). */
const DRUM_BARS = [[[36, 42], [38, 92], [36, 49], [38, 51]], [[50, 38], [48, 42], [47, 36], [45, 55]], [[36, 42], [38, 92], [36, 49], [38, 51]]];
const QUARTER = 960;
/** The overfull bar is the bass track's second: three quarters then a half, so the half note starts at the end of beat 3 and crosses the barline by a quarter. */
const OVERFULL_BAR = 1, OVERFULL_FRETS = [1, 2, 3, 5];

/** Authors a guitar track, a bass track (one overfull bar) and a drum track, three bars of 4/4 at 90 bpm. */
async function author() {
  const { exporter, model, Settings } = await import('@coderline/alphatab');
  const score = new model.Score();
  for (let index = 0; index < BARS; index++) {
    const master = new model.MasterBar();
    if (index === 0) { const tempo = new model.Automation(); tempo.type = model.AutomationType.Tempo; tempo.value = 90; tempo.isLinear = false; master.tempoAutomations.push(tempo); }
    master.timeSignatureNumerator = 4; master.timeSignatureDenominator = 4; score.addMasterBar(master);
  }
  let id = 0;
  const pitched = (name, short, program, tuning, frets, longBar) => {
    const track = new model.Track(), staff = new model.Staff();
    track.name = name; track.shortName = short; track.playbackInfo.program = program; staff.stringTuning.tunings = tuning; track.addStaff(staff); score.addTrack(track);
    for (let bar = 0; bar < BARS; bar++) {
      const made = new model.Bar(); made.id = id++; made.clef = model.Clef.G2; staff.addBar(made);
      const voice = new model.Voice(); voice.id = id++; made.addVoice(voice);
      const over = longBar === bar;
      for (let beat = 0; beat < 4; beat++) {
        const value = new model.Beat(); value.id = id++; value.duration = over && beat === 3 ? model.Duration.Half : model.Duration.Quarter; value.isEmpty = false; voice.addBeat(value);
        const note = new model.Note(); note.id = id++; note.string = 1; note.fret = over ? OVERFULL_FRETS[beat] : frets[(bar + beat) % frets.length]; value.addNote(note);
      }
    }
  };
  pitched('Guitar', 'Gtr', 25, [64, 59, 55, 50, 45, 40], [0, 2, 3, 5], -1);
  pitched('Bass', 'Bs', 33, [43, 38, 33, 28], [0, 3, 5, 7], OVERFULL_BAR);
  const drums = new model.Track(), kit = new model.Staff();
  drums.name = 'Drums'; drums.shortName = 'Dr'; Object.assign(drums.playbackInfo, { program: 0, primaryChannel: 9, secondaryChannel: 9 });
  drums.percussionArticulations = TABLE.map(([sound, name, line, key]) => new model.InstrumentArticulation(name, line, key, model.MusicFontSymbol.NoteheadBlack, model.MusicFontSymbol.NoteheadHalf, model.MusicFontSymbol.NoteheadWhole, model.MusicFontSymbol.None, 0, sound));
  kit.isPercussion = true; kit.showTablature = false; kit.showStandardNotation = true; drums.addStaff(kit); score.addTrack(drums);
  for (const hits of DRUM_BARS) {
    const bar = new model.Bar(); bar.id = id++; bar.clef = model.Clef.Neutral; kit.addBar(bar);
    const voice = new model.Voice(); voice.id = id++; bar.addVoice(voice);
    for (const group of hits) {
      const beat = new model.Beat(); beat.id = id++; beat.duration = model.Duration.Quarter; beat.isEmpty = false; voice.addBeat(beat);
      for (const sound of group) { const note = new model.Note(); note.id = id++; note.percussionArticulation = TABLE.findIndex(row => row[0] === sound); beat.addNote(note); }
    }
  }
  score.finish(new Settings());
  writeFileSync(fixture, new exporter.Gp7Exporter().export(score, new Settings()));
}

/** The note-on keys on MIDI channel 10 (index 9) of a standard MIDI file, in file order. */
function drumKeys(bytes) {
  const keys = [];
  let at = 14;
  while (at + 8 <= bytes.length) {
    const type = bytes.subarray(at, at + 4).toString(), length = bytes.readUInt32BE(at + 4), end = at + 8 + length;
    if (type === 'MTrk') {
      let cursor = at + 8, running = 0;
      const variable = () => { let value = 0, byte; do { byte = bytes[cursor++]; value = (value << 7) | (byte & 0x7f); } while (byte & 0x80); return value; };
      while (cursor < end) {
        variable();
        let status = bytes[cursor];
        if (status === 0xff) { cursor += 2; cursor += variable(); continue; }
        if (status === 0xf0 || status === 0xf7) { cursor++; cursor += variable(); continue; }
        if (status & 0x80) { cursor++; running = status; } else status = running;
        const kind = status & 0xf0;
        if (kind === 0xc0 || kind === 0xd0) { cursor += 1; continue; }
        if (kind === 0x90 && (status & 0x0f) === 9 && bytes[cursor + 1] > 0) keys.push(bytes[cursor]);
        cursor += 2;
      }
    }
    at = end;
  }
  return keys;
}
/** Loads the score of a Guitar Pro file the app exported, to read its tracks, bars and beats. */
const tracksOf = bytes => import('@coderline/alphatab').then(({ importer, Settings }) => importer.ScoreLoader.loadScoreFromBytes(Uint8Array.from(bytes), new Settings()));

for (const file of [fixture, gpPath]) if (existsSync(file)) rmSync(file);
rmSync(folder, { recursive: true, force: true }); mkdirSync(folder, { recursive: true }); mkdirSync(shots, { recursive: true });
await author();
const id = launch({ TABPLAYER_TEST_OPEN: fixture, TABPLAYER_TEST_EXPORT_DIR: folder, TABPLAYER_TEST_EXPORT: gpPath, TABPLAYER_MIDI_OUT_TEST: '1' });
let browser, page;
const seen = {};
/** Checks that fail because the product is wrong, not the driver. They stay as strict assertions, are reported together at the end, and fail the run; every other check still runs. */
const defects = [];
const productDefect = (name, check) => { try { check(); } catch (error) { defects.push(`${name}: ${error.message.split('\n')[0]}`); } };
try {
  browser = await connect(); page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(30000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const idle = async () => { await waitForWorkspaceIdle(page); assert.deepEqual(await page.getByRole('alert').allTextContents(), []); };
  const button = async name => { await clickWorkstationButton(page, name, { waitForIdle: false }); await idle(); };
  const invoke = (command, args = {}) => page.evaluate(([command, args]) => window.__TAURI_INTERNALS__.invoke(command, args), [command, args]);
  const edits = async () => (await readActiveDocument(page)).project.edits;
  const shoot = async (name, target) => { const path = resolve(shots, `${name}.png`); await (target ?? page).screenshot({ path }); return path; };
  const sleep = ms => new Promise(accept => setTimeout(accept, ms));

  await closeWelcomeLibrary(page); await button('Open'); await page.locator('[aria-label="Music notation"] svg').first().waitFor();
  assert.deepEqual(await edits(), [], 'the opened score starts with no edits');

  // ---- 1. Track drag reorder (batch 4, row S03) --------------------------------------------------------------------------------
  {
    await revealDock(page, 'Overview');
    const grips = page.locator('.workstation-dock .dock-track-handle');
    await grips.first().waitFor();
    const order = () => grips.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label').replace(/^Move /, '')));
    const centre = async index => { const box = await grips.nth(index).boundingBox(); assert.ok(box && box.width > 0 && box.height > 0, `grip ${index} is on screen`); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; };
    assert.deepEqual(await order(), ['Guitar', 'Bass', 'Drums'], 'the dock lists the three tracks with a grip each');
    const log = (await edits()).length;
    await shoot('1a-overview-grips');
    // Each row's mix controls (eye, mute, solo, one volume fader, pan) sit inside the row: measured now, and again after a move.
    const mixInside = () => page.evaluate(() => [...document.querySelectorAll('.workstation-dock .score-overview-track')].map(row => { const r = row.getBoundingClientRect(), m = row.querySelector('.score-overview-mix')?.getBoundingClientRect(); return { row: Math.round(r.height), mix: m ? Math.round(m.height) : null, offset: m ? Math.round(m.top - r.top) : null, faders: row.querySelectorAll('.dock-fader').length }; }));
    const rowsAreWhole = rows => { for (const row of rows) { assert.equal(row.faders, 1, `each overview row has exactly one volume fader (rows: ${JSON.stringify(rows)})`); assert.equal(row.mix, row.row, `each row's mix controls are as tall as the row (rows: ${JSON.stringify(rows)})`); assert.equal(row.offset, 0, 'and sit inside it'); } };
    rowsAreWhole(await mixInside());

    // A real pointer drag of track 1's grip to below track 3: the drop line is drawn while dragging, and the release is one moveTrack edit.
    const from = await centre(0), last = await centre(2), rowHeight = last.y - (await centre(1)).y;
    await page.mouse.move(from.x, from.y); await page.mouse.down();
    await page.mouse.move(from.x, from.y + rowHeight, { steps: 4 }); await page.mouse.move(from.x, last.y + rowHeight * 0.4, { steps: 6 });
    await page.locator('[data-testid="track-drop-indicator"]').waitFor({ state: 'visible' });
    const line = await page.locator('[data-testid="track-drop-indicator"]').boundingBox();
    assert.ok(line && line.width > 50 && line.height > 0, `the drop line is drawn: ${JSON.stringify(line)}`);
    assert.ok(line.y > last.y - rowHeight / 2, `the drop line sits below the third row, where the track will land: ${JSON.stringify(line)} against row 3 at ${last.y}`);
    assert.equal(await grips.first().getAttribute('data-dragging'), '', 'the grip shows it is being dragged');
    await shoot('1b-drag-in-progress');
    assert.equal((await edits()).length, log, 'nothing is recorded while the drag is going on');
    await page.mouse.up(); await idle();
    const moved = await edits();
    assert.equal(moved.length, log + 1, 'the drag is one edit however far it goes');
    assert.deepEqual(moved.at(-1), { type: 'moveTrack', track: 0, to: 2 });
    assert.deepEqual(await order(), ['Bass', 'Drums', 'Guitar']);
    assert.equal(await page.locator('[data-testid="track-drop-indicator"]').count(), 0, 'the drop line is gone after the release');
    await shoot('1c-after-drag');
    const afterMove = await mixInside();
    productDefect('1. after a track move the dock rows keep one volume fader and their height', () => rowsAreWhole(afterMove));
    await button('Undo');
    assert.equal((await edits()).length, log, 'one undo takes the move back');
    assert.deepEqual(await order(), ['Guitar', 'Bass', 'Drums'], 'one undo restores the order');

    // A drop on the row it started in, and an Escape during a drag, record nothing and change nothing.
    const start = await centre(0);
    await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(start.x, start.y + 4, { steps: 3 }); await page.mouse.up(); await idle();
    assert.equal((await edits()).length, log, 'a drop in place records nothing'); assert.deepEqual(await order(), ['Guitar', 'Bass', 'Drums']);
    await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(start.x, start.y + rowHeight * 2, { steps: 6 });
    await page.locator('[data-testid="track-drop-indicator"]').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await page.locator('[data-testid="track-drop-indicator"]').waitFor({ state: 'detached' });
    await page.mouse.move(start.x, start.y + rowHeight * 2 + 2); await page.mouse.up(); await idle();
    assert.equal((await edits()).length, log, 'Escape during the drag records nothing, and the release afterwards does not move the track');
    assert.deepEqual(await order(), ['Guitar', 'Bass', 'Drums']);

    // The keyboard way: Alt+Down on the focused grip moves the track one row and focus stays on that track's grip.
    await grips.first().focus();
    await page.keyboard.press('Alt+ArrowDown'); await idle();
    assert.equal((await edits()).length, log + 1, 'Alt+Down is one edit'); assert.deepEqual((await edits()).at(-1), { type: 'moveTrack', track: 0, to: 1 });
    assert.deepEqual(await order(), ['Bass', 'Guitar', 'Drums']);
    const focused = () => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? null);
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Move Guitar');
    assert.equal(await focused(), 'Move Guitar', 'focus follows the moved track to its new row');
    await page.keyboard.press('Alt+ArrowDown'); await idle();
    assert.deepEqual(await order(), ['Bass', 'Drums', 'Guitar'], 'the same key moves it again from where focus is');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Move Guitar');
    await shoot('1d-after-alt-down');
    await button('Undo'); await button('Undo');
    assert.equal((await edits()).length, log, 'two undos undo the two keyboard moves'); assert.deepEqual(await order(), ['Guitar', 'Bass', 'Drums']);
    seen.reorder = 'drag +1 edit, undo restores, drop in place and Escape record nothing, Alt+Down keeps focus on the grip';
  }

  // ---- shared export helpers ---------------------------------------------------------------------------------------------------
  const exportDialog = () => page.getByRole('dialog', { name: 'Export score', exact: true });
  const openExport = async format => {
    await clickWorkspaceCommand(page, 'Export score', { waitForIdle: false });
    const dialog = exportDialog(); await dialog.waitFor();
    await dialog.getByLabel('Export format').selectOption(format);
    return dialog;
  };
  /** Exports through the open dialog into the test folder under `name` and returns the file's bytes; the dialog closes itself when the file is written. */
  const finishExport = async (dialog, name, extension) => {
    await dialog.getByLabel('File name', { exact: true }).fill(name);
    // A Guitar Pro export goes through the test hook's single export file; every other format is named by the dialog inside the test folder.
    const path = extension === 'gp' ? gpPath : resolve(folder, `${name}.${extension}`);
    rmSync(path, { force: true });
    await dialog.getByRole('button', { name: 'Export', exact: true }).click();
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline && !existsSync(path)) {
      const failure = dialog.getByRole('alert'); if (await failure.count()) throw new Error(await failure.innerText());
      await sleep(150);
    }
    assert.ok(existsSync(path), `${name}.${extension} was written`);
    await dialog.waitFor({ state: 'hidden', timeout: 30000 }); await idle();
    return readFileSync(path);
  };
  const exportFile = async (format, name, extension, setup = async () => {}) => { const dialog = await openExport(format); await setup(dialog); return finishExport(dialog, name, extension); };

  // ---- 2. F1 inside the Export dialog (batch 4, row W21) ----------------------------------------------------------------------
  {
    const log = (await edits()).length;
    const dialog = await openExport('midi');
    await dialog.getByRole('checkbox', { name: 'Apply drum maps', exact: true }).check();
    await dialog.getByLabel('File name', { exact: true }).fill('f1-state');
    await page.keyboard.press('F1');
    const help = page.getByRole('dialog', { name: 'TabPlayer help', exact: true }); await help.waitFor();
    assert.equal(await help.getByRole('button', { name: 'Exporting', exact: true }).getAttribute('aria-current'), 'true', 'help opens on the Exporting topic');
    const where = await help.evaluate(node => {
      const r = node.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const owner = element => element?.closest('[role="dialog"]');
      const other = [...document.querySelectorAll('[role="dialog"]')].find(item => item !== node);
      const o = other?.getBoundingClientRect();
      const overlap = o ? Math.max(0, Math.min(r.right, o.right) - Math.max(r.left, o.left)) * Math.max(0, Math.min(r.bottom, o.bottom) - Math.max(r.top, o.top)) : 0;
      return { topmostIsHelp: owner(hit) === node, visible: r.width > 100 && r.height > 100, dialogs: document.querySelectorAll('[role="dialog"]').length, overlapsExport: overlap > 0 };
    });
    assert.equal(where.topmostIsHelp, true, 'the help is what is at its own centre (above the Export dialog)');
    assert.equal(where.visible, true); assert.equal(where.dialogs, 2, 'both dialogs are open');
    assert.ok(await dialog.isVisible(), 'the Export dialog is still open behind the help');
    await shoot('2a-help-over-export');
    await page.keyboard.press('Escape'); await help.waitFor({ state: 'detached' });
    assert.ok(await dialog.isVisible(), 'Escape closed only the help; the Export dialog is still open');
    assert.equal(await dialog.getByLabel('Export format').inputValue(), 'midi', 'the format is kept');
    assert.equal(await dialog.getByRole('checkbox', { name: 'Apply drum maps', exact: true }).isChecked(), true, 'the option is kept');
    assert.equal(await dialog.getByLabel('File name', { exact: true }).inputValue(), 'f1-state', 'the file name is kept');
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')), true, 'focus is back inside the Export dialog');
    await shoot('2b-export-after-help');
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' }); await idle();
    assert.equal((await edits()).length, log, 'help and the dialog record nothing');
    seen.help = `F1 opened "Exporting" above the Export dialog (overlapping it: ${where.overlapsExport}); Escape closed only the help; format, option and file name kept`;
  }

  // ---- 3. Export options (batch 2 count-in, batch 3 drum maps) ------------------------------------------------------------------
  {
    const setPracticeCountIn = async bars => {
      await revealPractice(page);
      const panel = page.locator('details.gp-practice');
      await panel.getByLabel('Count-in bars', { exact: true }).fill(String(bars));
      await panel.getByRole('button', { name: 'Apply practice settings' }).click();
      let status; const limit = Date.now() + 8000;
      do { status = await invoke('audio_status'); if (status.practice?.settings?.countIn?.bars === bars) break; await sleep(50); } while (Date.now() < limit);
      assert.equal(status.practice?.settings?.countIn?.bars, bars, `practice count-in bars are ${bars}`);
      await hidePractice(page); await idle();
    };
    // With no count-in bars set the option is drawn unchecked and disabled whatever its state is, so the default is only tested once it can be ticked.
    const dialogDefault = await openExport('wav');
    const countInDefault = dialogDefault.getByRole('checkbox', { name: 'Include count-in', exact: true });
    assert.equal(await countInDefault.isChecked(), false, 'without practice count-in bars the option is unchecked');
    assert.equal(await countInDefault.isDisabled(), true, 'without practice count-in bars the option is disabled');
    await page.keyboard.press('Escape'); await dialogDefault.waitFor({ state: 'hidden' }); await idle();
    await setPracticeCountIn(2);
    const dialog = await openExport('wav');
    const countIn = dialog.getByRole('checkbox', { name: 'Include count-in', exact: true });
    for (const [label, selector] of [['WAV', /^WAV$/], ['AIFF', /^AIFF$/], ['FLAC', /^FLAC/], ['OGG', /^OGG/], ['MP3', /^MP3/]]) {
      await dialog.getByRole('radio', { name: selector }).click();
      assert.equal(await countIn.count(), 1, `"Include count-in" is offered for ${label}`);
      assert.equal(await countIn.isDisabled(), false, `it can be ticked for ${label} once the practice settings have count-in bars`);
      assert.equal(await countIn.isChecked(), false, `it is off by default for ${label}`);
    }
    const staleNote = await dialog.getByText('Audio export does not include count-in or progressive speed changes.').count();
    seen.countIn = { enabledWithPracticeCountIn: !await countIn.isDisabled(), staleNoteShown: staleNote };
    productDefect('3. the WAV options claim the export has no count-in beside the Include count-in option', () => assert.equal(staleNote, 0, 'the note "Audio export does not include count-in ..." is shown next to "Include count-in"'));
    await dialog.getByRole('radio', { name: /^WAV$/ }).click();
    await shoot('3a-export-audio-count-in', dialog);
    await dialog.getByLabel('Export format').selectOption('stems');
    assert.equal(await dialog.getByRole('checkbox', { name: 'Include count-in', exact: true }).count(), 0, 'stems do not offer a count-in');
    await shoot('3b-export-stems', dialog);
    await dialog.getByLabel('Export format').selectOption('midi');
    const drumMaps = dialog.getByRole('checkbox', { name: 'Apply drum maps', exact: true });
    assert.equal(await drumMaps.count(), 1, '"Apply drum maps" is offered for MIDI'); assert.equal(await drumMaps.isChecked(), false, 'it is off by default');
    await dialog.getByLabel('Export format').selectOption('gp');
    assert.equal(await dialog.getByRole('checkbox', { name: 'Apply drum maps', exact: true }).count(), 0, 'it is a MIDI option only');
    await dialog.getByLabel('Export format').selectOption('midi'); await shoot('3c-export-midi', dialog);
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' }); await idle();
    await setPracticeCountIn(0);

    const midi = (name, on) => exportFile('midi', name, 'mid', async d => { if (on) await d.getByRole('checkbox', { name: 'Apply drum maps', exact: true }).check(); });
    const logBeforeMaps = (await edits()).length;
    const off1 = await midi('midi-nomap-off-1', false), off2 = await midi('midi-nomap-off-2', false), on1 = await midi('midi-nomap-on', true);
    assert.equal(off1.subarray(0, 4).toString(), 'MThd'); assert.ok(drumKeys(off1).includes(38), 'the scored snare is key 38');
    assert.ok(off1.equals(off2), 'two MIDI exports of the same score are the same bytes');
    assert.ok(off1.equals(on1), 'with no drum map set, "Apply drum maps" writes the same bytes');
    assert.equal((await edits()).length, logBeforeMaps, 'exporting records no edit');

    // A drum map row that changes a key: the snare goes to key 52 on the drum track's MIDI output (the desktop-test build's recording port).
    await selectWorkspaceTrack(page, 'Track 3: Drums'); await idle(); await revealInspectorTab(page, 'Track');
    const panel = page.locator('details.midi-out-more'); await panel.evaluate(node => { node.open = true; });
    await panel.getByLabel('Output').selectOption(TEST_PORT); await idle();
    const section = page.locator('details.midi-out-more .drum-map').first(); await section.waitFor();
    const keys = section.locator('details.drum-map-keys');
    if (!await keys.evaluate(node => node.open)) { await keys.locator(':scope > summary').scrollIntoViewIfNeeded(); await keys.locator(':scope > summary').click(); }
    await section.locator('[role="radio"]').nth(0).click();
    const beforeKey = (await edits()).length;
    const snare = section.locator('li.drum-map-row input').nth(await section.locator('li.drum-map-row input').evaluateAll(nodes => nodes.findIndex(node => node.value === '38')));
    await snare.fill('52'); await snare.press('Enter'); await idle();
    assert.equal((await edits()).length, beforeKey + 1, 'the map row change is one edit');
    await shoot('3d-drum-map-row', section);
    await page.keyboard.press('Escape');
    const off3 = await midi('midi-map-off', false), on3 = await midi('midi-map-on', true);
    assert.ok(off3.equals(off1), 'with the option off, a drum map changes nothing in the MIDI file');
    assert.ok(!off3.equals(on3), 'with the option on and a map row that changes a key, the MIDI bytes differ');
    const offKeys = drumKeys(off3), onKeys = drumKeys(on3);
    assert.ok(offKeys.includes(38) && !offKeys.includes(52), 'off: the snare stays on 38');
    assert.ok(onKeys.includes(52) && !onKeys.includes(38), `on: every snare is written on 52, none on 38 (${[...new Set(onKeys)].sort((a, b) => a - b)})`);
    assert.equal(onKeys.length, offKeys.length, 'the map moves a hit, it does not add or drop one');
    seen.midi = { snareKeysOff: offKeys.filter(key => key === 38).length, snareKeysOn: onKeys.filter(key => key === 52).length };
  }

  // ---- 4. Chord and scale audition (batch 4, rows U04 and U06) -----------------------------------------------------------------
  {
    await selectWorkspaceTrack(page, 'Track 1: Guitar'); await idle(); await moveCursor(page, { bar: 1, beat: 1 });
    for (let attempt = 0; attempt < 150; attempt++) { const status = await invoke('audio_status'); assert.equal(status.error, null); if (status.ready && status.generation === status.desiredGeneration) break; await sleep(200); }
    const log = (await edits()).length;
    /** Presses an audition button: the native serial must rise by one, playback never starts, and nothing is recorded. */
    const heard = async (label, control) => {
      const before = (await invoke('audio_status')).auditionSerial ?? 0;
      await control.click();
      let status; const until = Date.now() + 15000;
      do { status = await invoke('audio_status'); if ((status.auditionSerial ?? 0) > before) break; await sleep(50); } while (Date.now() < until);
      assert.ok((status.auditionSerial ?? 0) > before, `${label}: the native side was asked for an audition (serial ${before} -> ${status.auditionSerial})`);
      assert.equal(status.playing, false, `${label}: an audition never starts playback`);
      let peak = 0; const heardUntil = Date.now() + 8000;
      do { status = await invoke('audio_status'); peak = Math.max(peak, status.auditionPeak ?? 0); if (peak > 0.001) break; await sleep(50); } while (Date.now() < heardUntil);
      assert.equal(status.error, null); assert.ok(peak > 0.001, `${label}: the clip is audible in the mix (peak ${peak})`);
      assert.equal((await edits()).length, log, `${label}: records no edit`);
      return status.auditionSerial;
    };
    const quiet = async (label, control) => {
      const before = (await invoke('audio_status')).auditionSerial ?? 0;
      await control.click({ force: true }); await sleep(800);
      assert.equal((await invoke('audio_status')).auditionSerial ?? 0, before, `${label}: no audition`);
      assert.equal((await edits()).length, log, `${label}: records no edit`);
    };

    await editionPalette(page).getByRole('button', { name: 'Chords', exact: true }).click();
    const chord = page.getByRole('dialog', { name: 'Harmony chord', exact: true }); await chord.waitFor();
    const playChord = chord.getByRole('button', { name: 'Play chord', exact: true });
    assert.equal(await playChord.count(), 1, '"Play chord" is in the chord dialog');
    assert.equal(await playChord.getAttribute('aria-disabled'), 'true', 'with every string muted there is nothing to play, and the button says so');
    await quiet('Play chord with no sounding string', playChord);
    await chord.getByRole('button', { name: 'Generate shapes', exact: true }).click();
    await chord.getByRole('button', { name: 'Use shape 1', exact: true }).click();
    assert.equal(await playChord.getAttribute('aria-disabled'), null, 'with a shape chosen, "Play chord" is available while the transport is stopped');
    const serialChord = await heard('Play chord', playChord);
    await shoot('4a-chord-dialog-play-chord');
    // Pressing it again strums again (a new request).
    const serialAgain = await heard('Play chord again', playChord); assert.ok(serialAgain > serialChord);
    await page.keyboard.press('Escape'); await chord.waitFor({ state: 'hidden' }); await idle();
    assert.equal((await edits()).length, log, 'closing the chord dialog with Escape records nothing');

    await editionPalette(page).getByRole('button', { name: 'Scale diagram', exact: true }).click();
    const scaleRoot = page.getByRole('dialog', { name: 'Scale browser', exact: true }); await scaleRoot.waitFor();
    const playScale = scaleRoot.getByRole('button', { name: 'Play scale', exact: true });
    assert.equal(await playScale.count(), 1, '"Play scale" is in the scale panel');
    assert.equal(await playScale.getAttribute('aria-disabled'), null, 'it is available while the transport is stopped');
    await heard('Play scale', playScale);
    await shoot('4b-scale-panel-play-scale');
    await page.keyboard.press('Escape'); await scaleRoot.waitFor({ state: 'hidden' }); await idle();
    assert.equal((await edits()).length, log);
    seen.audition = { chord: serialChord, scale: (await invoke('audio_status')).auditionSerial };
  }

  // ---- 5. Trim to fit shortens the note that crosses the barline (batch 2, row E15) ----------------------------------------------
  {
    const bassBar = async name => {
      const score = await tracksOf(await exportFile('gp', name, 'gp'));
      const bass = score.tracks.find(track => track.name === 'Bass');
      return bass.staves[0].bars[OVERFULL_BAR].voices[0].beats.map(beat => [beat.duration, beat.notes.map(note => note.fret), beat.notes.some(note => note.isTieDestination)]);
    };
    const log = (await edits()).length;
    const before = await bassBar('gp-before-trim');
    assert.deepEqual(before, [[4, [1], false], [4, [2], false], [4, [3], false], [2, [5], false]], 'the authored bass bar 2 is three quarters and a half (five quarters in 4/4)');
    const dialog = await openProperties(page, 'score');
    const heading = dialog.locator('summary').filter({ hasText: /^Score errors \(/ }).first();
    await heading.evaluate(node => { node.parentElement.open = true; });
    assert.equal(await heading.textContent(), 'Score errors (1)', 'the one overfull bar is listed');
    const trim = dialog.getByRole('button', { name: /^Trim to fit/ }); assert.equal(await trim.count(), 1);
    const hint = (await trim.innerText()).replace(/\s+/g, ' ').trim();
    assert.match(hint, /shortens 1 note/, `the hint announces a shortening: "${hint}"`);
    assert.doesNotMatch(hint, /removes/, 'nothing is announced as removed when the crossing note is only shortened');
    assert.match(await trim.getAttribute('aria-label'), /^Trim to fit: measure 2, .*, voice 1, shortens 1 note$/, 'the accessible name carries the hint');
    await shoot('5a-trim-hint', dialog);
    await trim.click(); await idle();
    const edit = (await edits()); assert.equal(edit.length, log + 1, 'Trim to fit is one edit');
    assert.equal(edit.at(-1).type, 'fitVoice'); assert.equal(edit.at(-1).shorten, true, 'the edit records that it shortens');
    const after = await bassBar('gp-after-trim');
    assert.deepEqual(after, [[4, [1], false], [4, [2], false], [4, [3], false], [4, [5], false]], 'the crossing note is still there, shortened to the quarter that fits');
    const dialogAfter = await openProperties(page, 'score');
    await dialogAfter.locator('summary').filter({ hasText: /^Score errors \(/ }).first().evaluate(node => { node.parentElement.open = true; });
    await dialogAfter.getByText('Every measure is complete.', { exact: true }).waitFor();
    await shoot('5b-trim-done', dialogAfter);
    await closeProperties(page);
    await button('Undo');
    assert.equal((await edits()).length, log, 'one undo takes Trim to fit back');
    assert.deepEqual(await bassBar('gp-undone-trim'), before, 'the long note is back as it was');
    seen.trim = { hint, before: before.at(-1), after: after.at(-1) };
  }

  // ---- 6. ASCII tab export carries the six drum tab lines (batch 1, row F14) ----------------------------------------------------
  {
    const text = (await exportFile('ascii', 'ascii-tab', 'txt', async dialog => { await dialog.getByText(/^ASCII tablature writes the fret numbers/).waitFor(); })).toString('utf8');
    const lines = text.split('\n');
    const start = lines.indexOf('Drums [drum tab Cr Rd HH Tm Sn Bd]'); assert.ok(start >= 0, `the drum track is written as a drum tab:\n${text}`);
    const end = lines.findIndex((line, at) => at > start && /^\S.* \[/.test(line)), block = lines.slice(start + 1, end < 0 ? undefined : end);
    const lineOf = { 36: 'Bd', 38: 'Sn', 91: 'Sn', 42: 'HH', 92: 'HH', 46: 'HH', 49: 'Cr', 55: 'Cr', 51: 'Rd', 50: 'Tm', 48: 'Tm', 47: 'Tm', 45: 'Tm' };
    for (const label of ['Cr', 'Rd', 'HH', 'Tm', 'Sn', 'Bd']) {
      const rows = block.filter(line => line.startsWith(`${label}|`));
      assert.ok(rows.length > 0, `the drum tab has a "${label}" line`);
      const written = rows.map(line => line.slice(label.length + 1)).join('').match(/\d+/g)?.map(Number) ?? [];
      const expected = DRUM_BARS.flat().flat().filter(sound => lineOf[sound] === label);
      assert.ok(expected.length > 0, `the fixture strikes the ${label} line`);
      assert.deepEqual(written.sort((a, b) => a - b), expected.sort((a, b) => a - b), `the ${label} line holds its hits' sound numbers`);
    }
    assert.ok(lines.some(line => /^Guitar \[/.test(line)) && lines.some(line => /^Bass \[/.test(line)), 'the pitched tracks are still written as strings');
    await shoot('6-ascii-export-dialog-closed');
    seen.ascii = `${lines.length} lines; labels Cr Rd HH Tm Sn Bd each hold their hits`;
  }

  assert.deepEqual(errors, []);
  if (defects.length) console.log(`recent controls: every other check passed (${Object.keys(seen).join(', ')}).`);
  assert.deepEqual(defects, [], 'PRODUCT DEFECTS found by this driver (the assertions are kept strict)');
  console.log(`recent controls: ${Object.entries(seen).map(([area, value]) => `${area}: ${typeof value === 'string' ? value : JSON.stringify(value)}`).join('; ')}; screenshots under .analysis/desktop-smoke/recent-controls.`);
} catch (error) { if (page) await page.screenshot({ path: resolve(shots, 'failure.png') }).catch(() => {}); throw error; }
finally { if (browser) await browser.close().catch(() => {}); try { stop(id); } catch {} }
