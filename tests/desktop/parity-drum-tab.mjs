// Drum tablature desktop acceptance (THE-220): the inspector's TAB and notation toggles on a drum track write the track's engraving profile,
// and the score shows the drum tab (a six-line staff of sound numbers) beside or instead of the percussion staff.
// Through the real interface over CDP it checks that
//  1. before anything is pressed a drum track shows standard notation only, and the Tuning row stays unavailable throughout;
//  2. TAB adds digits (the written sound numbers: 36 kick, 38 snare, 42/92/46 hi-hats, 49 crash, 51 ride, 91 rim shot, tom numbers),
//     turning standard off leaves the tab alone, turning it on again shows both; each gesture is one undo step and one setEngraving
//     edit (never a setStaffSettings edit); the one notation that is on cannot be turned off (aria-disabled, focusable, no edit);
//  3. clicking a tab number selects the same note the keyboard reaches by position, and arrow keys step between the notes of a beat;
//  4. a note added from the drum kit while tab is shown appears as a new number;
//  5. the playback cursor moves across the tab staff, and choosing the drum track centres its staff;
//  6. the exported PDF pages carry the numbers (read from the pages' SVG the app hands to the test hook);
//  7. the profile survives save, close and reopen;
//  8. screenshots of tab only, both, and the multi-track view in English, Estonian and German are written under
//     .analysis/desktop-smoke/ (git-ignored) for a person to look at.
//
// Build with scripts/build-desktop-test.ps1, then, from the checkout root:
//   node tests/desktop/parity-drum-tab.mjs
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { directory, launch, connect, stop } from './harness.mjs';
import { waitForWorkspaceIdle, clickWorkstationButton, revealInspectorTab, selectWorkspaceTrack, cursorPosition, moveCursor, scoreWorkspace } from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';

const fixture = resolve(directory, 'drum-tab-fixture.gp'), saved = resolve(directory, 'drum-tab.tabplayer'), exported = resolve(directory, 'drum-tab-export'), pdf = `${exported}.pdf`;
const BARS = 2;
/** Beats of bar 1 and bar 2, by the standard sound number of each hit. Beat 3 of bar 1 holds three hits at once (kick, crash, open hi-hat). */
const BAR_1 = [[36, 42], [38, 92], [36, 49, 46], [91, 51]];
const BAR_2 = [[50, 48], [47, 45], [38, 42], [36, 55]];
/** [standard id, name, staff line, MIDI key]: the drum track's own articulation table, as a Guitar Pro file writes it. */
const TABLE = [[36, 'Kick Drum', 7, 36], [38, 'Snare', 3, 38], [91, 'Snare', 3, 38], [42, 'Charley', -1, 42], [92, 'Charley', -1, 46], [46, 'Charley', -1, 46], [49, 'Crash High', -2, 49], [55, 'Splash', -2, 55], [51, 'Ride', 0, 51], [50, 'Tom Very High', 1, 50], [48, 'Tom High', 2, 48], [47, 'Tom Medium', 4, 47], [45, 'Tom Low', 5, 45]];
const digitsOf = list => list.filter(text => /^\d{2,3}$/.test(text)).sort();
const without = (all, base) => { const rest = [...all]; for (const text of base) { const at = rest.indexOf(text); if (at >= 0) rest.splice(at, 1); } return rest.sort(); };
const hitsOf = bars => bars.flat().map(String).sort();

/** A guitar track of rests and one drum track, authored here: two bars of four beats at 90 bpm. */
async function author() {
  const { exporter, model, Settings } = await import('@coderline/alphatab');
  const score = new model.Score();
  for (let index = 0; index < BARS; index++) {
    const master = new model.MasterBar();
    if (index === 0) { const tempo = new model.Automation(); tempo.type = model.AutomationType.Tempo; tempo.value = 90; tempo.isLinear = false; master.tempoAutomations.push(tempo); }
    master.timeSignatureNumerator = 4; master.timeSignatureDenominator = 4; score.addMasterBar(master);
  }
  const guitar = new model.Track(), lead = new model.Staff();
  guitar.name = 'Guitar'; guitar.shortName = 'Gtr'; guitar.playbackInfo.program = 25;
  lead.stringTuning.tunings = [64, 59, 55, 50, 45, 40]; guitar.addStaff(lead); score.addTrack(guitar);
  const drums = new model.Track(), kit = new model.Staff();
  drums.name = 'Drums'; drums.shortName = 'Dr'; Object.assign(drums.playbackInfo, { program: 0, primaryChannel: 9, secondaryChannel: 9 });
  drums.percussionArticulations = TABLE.map(([id, name, line, key]) => new model.InstrumentArticulation(name, line, key, model.MusicFontSymbol.NoteheadBlack, model.MusicFontSymbol.NoteheadHalf, model.MusicFontSymbol.NoteheadWhole, model.MusicFontSymbol.None, 0, id));
  kit.isPercussion = true; kit.showTablature = false; kit.showStandardNotation = true; drums.addStaff(kit); score.addTrack(drums);
  let id = 0;
  [BAR_1, BAR_2].forEach(hits => {
    const rested = new model.Bar(); rested.id = id++; rested.clef = model.Clef.G2; lead.addBar(rested);
    const restVoice = new model.Voice(); restVoice.id = id++; rested.addVoice(restVoice);
    const rest = new model.Beat(); rest.id = id++; rest.duration = model.Duration.Whole; rest.isEmpty = false; restVoice.addBeat(rest);
    const bar = new model.Bar(); bar.id = id++; bar.clef = model.Clef.Neutral; kit.addBar(bar);
    const voice = new model.Voice(); voice.id = id++; bar.addVoice(voice);
    for (const group of hits) {
      const beat = new model.Beat(); beat.id = id++; beat.duration = model.Duration.Quarter; beat.isEmpty = false; voice.addBeat(beat);
      for (const sound of group) { const note = new model.Note(); note.id = id++; note.percussionArticulation = TABLE.findIndex(row => row[0] === sound); beat.addNote(note); }
    }
  });
  score.finish(new Settings());
  writeFileSync(fixture, new exporter.Gp7Exporter().export(score, new Settings()));
}

for (const file of [fixture, saved, pdf]) if (existsSync(file)) rmSync(file);
await author();
let id = launch({ TABPLAYER_TEST_OPEN: fixture, TABPLAYER_TEST_SAVE: saved, TABPLAYER_TEST_EXPORT: exported }), browser, page;
const notes = [];
try {
  browser = await connect(); page = browser.contexts()[0].pages()[0]; await waitForWorkspaceIdle(page);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const closeLibrary = async () => { const library = page.getByRole('dialog', { name: 'Library', exact: true }); await library.getByRole('heading', { name: 'Welcome to TabPlayer', exact: true }).waitFor(); await library.getByRole('button', { name: 'Close', exact: true }).click(); await library.waitFor({ state: 'hidden' }); };
  const idle = async () => { await waitForWorkspaceIdle(page); assert.deepEqual(await page.getByRole('alert').allTextContents(), []); };
  const button = async name => { await clickWorkstationButton(page, name, { waitForIdle: false }); await idle(); };
  const score = () => page.locator('[aria-label="Music notation"] svg');
  const texts = () => page.evaluate(() => [...document.querySelectorAll('[aria-label="Music notation"] svg text')].map(text => text.textContent.trim()));
  const edits = async () => (await readActiveDocument(page)).project.edits;
  const toggles = async () => { await revealInspectorTab(page, 'Track'); return { tab: page.getByRole('button', { name: 'Show tablature', exact: true }), standard: page.getByRole('button', { name: 'Show notation', exact: true }) }; };
  const pressed = async () => { const { tab, standard } = await toggles(); return [await tab.getAttribute('aria-pressed'), await standard.getAttribute('aria-pressed')]; };
  const exportPdf = async () => {
    await clickWorkstationButton(page, 'Export score', { waitForIdle: false }); const dialog = page.getByRole('dialog', { name: 'Export score' }); await dialog.getByLabel('Export format').selectOption('pdf');
    await dialog.getByRole('button', { name: 'Export', exact: true }).click();
    await Promise.race([dialog.waitFor({ state: 'hidden', timeout: 30000 }), dialog.getByRole('alert').waitFor({ timeout: 30000 }).then(async () => { throw new Error(await dialog.getByRole('alert').textContent()); })]); await dialog.waitFor({ state: 'hidden', timeout: 30000 }); await idle();
    assert.equal(readFileSync(pdf).subarray(0, 5).toString(), '%PDF-');
    // The pages' SVG as the app hands it to the test hook: the numbers are text elements in it.
    return page.evaluate(() => window.__tabplayerTestExportPages.flatMap(sheet => [...new DOMParser().parseFromString(sheet.svg, 'image/svg+xml').querySelectorAll('text')].map(text => text.textContent.trim())));
  };
  await closeLibrary(); await button('Open'); await score().first().waitFor();
  await selectWorkspaceTrack(page, 'Track 2: Drums'); await idle();

  // 1. Standard only to begin with; the Tuning row is unavailable on a drum track.
  const log0 = (await edits()).length;
  assert.deepEqual(await pressed(), ['false', 'true']);
  const tuning = page.getByRole('button', { name: /^Tuning/ }).first();
  const tuningState = async () => (await tuning.count()) ? await tuning.getAttribute('aria-disabled') : 'absent';
  const tuningBefore = await tuningState();
  const baseline = digitsOf(await texts()), baselinePdf = digitsOf(await exportPdf());

  // 2. TAB, standard off, standard on: one setEngraving edit each, and digits that are exactly the written sound numbers.
  const kit = hitsOf([...BAR_1, ...BAR_2]);
  const step = async (name, press, expectedPressed, expectedDigits) => {
    const before = (await edits()).length, { tab, standard } = await toggles();
    await (press === 'tab' ? tab : standard).click(); await idle();
    const after = await edits();
    assert.equal(after.length, before + 1, `${name}: one edit`); assert.equal(after.at(-1).type, 'setEngraving', `${name}: a setEngraving edit`);
    assert.ok(!after.slice(log0).some(edit => edit.type === 'setStaffSettings'), `${name}: no setStaffSettings edit`);
    assert.deepEqual(await pressed(), expectedPressed, name);
    await page.waitForTimeout(300);
    assert.deepEqual(without(digitsOf(await texts()), baseline), expectedDigits, `${name}: the digits drawn`);
  };
  await step('TAB on', 'tab', ['true', 'true'], kit);
  await step('standard off', 'standard', ['true', 'false'], kit);
  // The one that is on does nothing: no edit, still focusable, and it says why.
  {
    const before = (await edits()).length, { tab } = await toggles();
    await tab.focus(); await tab.click(); await page.keyboard.press('Enter'); await idle();
    assert.equal((await edits()).length, before, 'the only notation shown cannot be turned off');
    assert.equal(await tab.getAttribute('aria-disabled'), 'true'); assert.equal(await tab.isDisabled(), false);
    assert.match((await tab.getAttribute('title')) ?? '', /always stays on/i);
  }
  await page.screenshot({ path: resolve(directory, 'drum-tab-only-en.png') });
  await step('standard on', 'standard', ['true', 'true'], kit);
  await page.screenshot({ path: resolve(directory, 'drum-tab-both-en.png') });
  assert.equal(await tuningState(), tuningBefore, 'showing drum tab does not change the Tuning row');
  // One undo step each: three undos go back through standard-on, standard-off and TAB-on, to standard only.
  for (const expected of [['true', 'false'], ['true', 'true'], ['false', 'true']]) { await button('Undo'); assert.deepEqual(await pressed(), expected, 'undo'); }
  assert.equal((await edits()).length, log0, 'the log is back where it began'); assert.deepEqual(without(digitsOf(await texts()), baseline), []);
  for (let redo = 0; redo < 3; redo++) await button('Redo');
  assert.deepEqual(await pressed(), ['true', 'true']);

  // 3. Clicking a tab number selects the note the keyboard reaches by position. Crash 49 is the second of three hits in bar 1 beat 3.
  const target = page.locator('[aria-label="Music notation"] svg text', { hasText: /^49$/ }).first();
  await target.click(); await idle();
  const clicked = await cursorPosition(page);
  assert.equal(clicked.bar, 1); assert.equal(clicked.beat, 3);
  await moveCursor(page, { bar: 2 }); await moveCursor(page, { bar: 1, beat: 1 });
  await moveCursor(page, { beat: clicked.beat, string: clicked.string });
  assert.equal((await cursorPosition(page)).text, clicked.text, 'the click and the keyboard name the same note');
  // Arrow keys step between the notes of a drum beat; none of it edits.
  const walked = new Set(); await scoreWorkspace(page).focus();
  for (let press = 0; press < 3; press++) { await page.keyboard.press('ArrowUp'); await page.waitForTimeout(80); walked.add((await cursorPosition(page)).string); }
  assert.ok(walked.size >= 2, `arrow keys move between the notes of the beat: ${[...walked]}`);
  const logAfterWalk = (await edits()).length;

  // 4. A note added from the drum kit appears as a number. Beat 1 of bar 1 has no snare.
  await moveCursor(page, { bar: 1, beat: 1 });
  const beforeAdd = digitsOf(await texts());
  await button('Show instrument');
  const kitView = page.locator('.instrument-view'); await kitView.getByRole('group', { name: 'Drum kit', exact: true }).waitFor();
  const editing = kitView.getByRole('checkbox', { name: 'Click to edit notes', exact: true }); if (!(await editing.isChecked())) await editing.check();
  await kitView.getByRole('button', { name: 'Snare', exact: true }).first().click(); await idle(); await page.waitForTimeout(300);
  assert.equal((await edits()).length, logAfterWalk + 1, 'one edit for the added note');
  assert.deepEqual(without(digitsOf(await texts()), beforeAdd), ['38'], 'the new snare is a 38 on the tab');
  await button('Undo'); await page.waitForTimeout(300);
  assert.deepEqual(digitsOf(await texts()), beforeAdd);
  await button('Hide instrument').catch(() => {});

  // 5. The playback cursor moves across the tab, and a track pick centres the track's staff.
  const status = () => page.evaluate(() => window.__TAURI_INTERNALS__.invoke('audio_status'));
  const beatBox = () => page.evaluate(() => { const element = document.querySelector('.score-playback-beat'); if (!element || element.hidden) return null; const r = element.getBoundingClientRect(); return { x: r.left, top: r.top, bottom: r.bottom }; });
  const tabRows = () => page.evaluate(() => [...document.querySelectorAll('[aria-label="Music notation"] svg text')].filter(text => /^(36|38|42|92|46|49|51|91|50|48|47|45|55)$/.test(text.textContent.trim())).map(text => { const r = text.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; }));
  await moveCursor(page, { bar: 1, beat: 1 }); await button('Play');
  const seen = [];
  for (let sample = 0; sample < 12; sample++) { await page.waitForTimeout(250); const box = await beatBox(); if (box) seen.push(box); }
  await button('Stop');
  assert.ok(seen.length >= 4, 'the playback cursor was drawn while playing');
  assert.ok(Math.max(...seen.map(box => box.x)) - Math.min(...seen.map(box => box.x)) > 20, 'the cursor moved across the bar');
  assert.ok((await status()).tick !== undefined);
  const rows = await tabRows(); assert.ok(rows.length > 0);
  const last = seen.at(-1); assert.ok(rows.some(row => row.top >= last.top - 2 && row.bottom <= last.bottom + 2), 'the cursor band covers the tab numbers');
  await selectWorkspaceTrack(page, 'Track 1: Guitar'); await idle(); await selectWorkspaceTrack(page, 'Track 2: Drums'); await idle(); await page.waitForTimeout(400);
  const centred = await page.evaluate(() => { const host = document.querySelector('.paper-scroll'), h = host.getBoundingClientRect(); const marks = [...document.querySelectorAll('[aria-label="Music notation"] svg text')].filter(text => /^(36|38|42)$/.test(text.textContent.trim())).map(text => text.getBoundingClientRect()); const mid = marks.reduce((sum, r) => sum + (r.top + r.bottom) / 2, 0) / Math.max(1, marks.length); return { inside: marks.length > 0 && marks.every(r => r.top >= h.top - 1 && r.bottom <= h.bottom + 1), offset: (mid - (h.top + h.bottom) / 2) / h.height, scrollable: host.scrollHeight > host.clientHeight + 4 }; });
  assert.ok(centred.inside, 'the drum track\'s numbers are in view after picking the track');
  if (centred.scrollable) assert.ok(Math.abs(centred.offset) < 0.25, `the track is centred: ${JSON.stringify(centred)}`); else notes.push('The score fits the window, so centring could only be checked as "in view".');

  // 6. The exported PDF carries the numbers: the baseline (standard only) had none of these, tab on has all of them.
  const pdfTexts = digitsOf(await exportPdf());
  assert.deepEqual(without(pdfTexts, baselinePdf), kit, 'the PDF pages draw the same numbers');

  // 7. Save, close, reopen: the profile is still tab + standard, and the numbers are still drawn.
  await button('Save'); const stored = await readActiveDocument(page); assert.equal(stored.dirty, false);
  assert.deepEqual(errors, []);
  await browser.close(); browser = null; stop(id);
  id = launch({ TABPLAYER_TEST_OPEN: saved, TABPLAYER_TEST_EXPORT: exported }); browser = await connect(); page = browser.contexts()[0].pages()[0]; await waitForWorkspaceIdle(page); await closeLibrary();
  await button('Open'); await score().first().waitFor(); await selectWorkspaceTrack(page, 'Track 2: Drums'); await idle();
  assert.deepEqual((await readActiveDocument(page)).project, stored.project);
  assert.deepEqual(await pressed(), ['true', 'true']);
  await page.waitForTimeout(300); assert.deepEqual(without(digitsOf(await texts()), baseline), kit);

  // 8. Screenshots in three languages: tab only, both, and the multi-track view (the guitar and the drums on one page).
  const setLanguage = async language => { await page.evaluate(value => window.localStorage.setItem('tabplayer.language', value), language); await page.reload(); await page.locator('.app-shell').waitFor(); await idle(); await page.waitForTimeout(400); };
  const shoot = async (name, language) => { await page.waitForTimeout(400); await page.screenshot({ path: resolve(directory, `drum-tab-${name}-${language}.png`) }); };
  const press = async which => { await revealInspectorTab(page, 'Track'); await page.locator('.notation-toggle').nth(which).click(); await idle(); };
  for (const language of ['en', 'et', 'de']) {
    if (language !== 'en') { await setLanguage(language); await selectWorkspaceTrack(page, 'Track 2: Drums'); await idle(); }
    await revealInspectorTab(page, 'Track');
    assert.deepEqual(await Promise.all([0, 1].map(which => page.locator('.notation-toggle').nth(which).getAttribute('aria-pressed'))), ['true', 'true']);
    await shoot('both', language);
    await press(1); await shoot('tab-only', language);
    await press(1); await shoot('multi-track', language);
  }
  await page.evaluate(() => window.localStorage.setItem('tabplayer.language', 'en'));
  console.log(`drum-tab: ${kit.length} numbers drawn on the tab, ${notes.length ? notes.join(' ') : 'all checks ran'}; PDF numbers read from the export hook; screenshots under ${directory}.`);
} catch (error) { if (page) await page.screenshot({ path: resolve(directory, 'drum-tab-failure.png') }).catch(() => {}); throw error; }
finally { if (browser) await browser.close().catch(() => {}); if (id) { try { stop(id); } catch {} } }
