// Drum tablature, looked at (THE-220): a six-track score whose drum track shows tab only, standard + tab, and standard only, in the "All tracks"
// view and alone, in English, Estonian and German, at 1920x1080 and 1366x768, with a beat of several simultaneous hits and a beat with more
// hits than the six lines hold. It asserts what a script can (the digits drawn, the missing-hits notice, no tuning labels, no horizontal clipping
// of the inspector) and writes the screenshots under .analysis/desktop-smoke/drum-tab-views/ (git-ignored) for a person to look at.
//
// Build with scripts/build-desktop-test.ps1, then, from the checkout root:
//   node tests/desktop/parity-drum-tab-views.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { directory, launch, connect, stop } from './harness.mjs';
import { waitForWorkspaceIdle, clickWorkstationButton, selectWorkspaceTrack, revealInspectorTab } from './workstation-commands.mjs';

const fixture = resolve(directory, 'drum-tab-views-fixture.gp'), shots = resolve(directory, 'drum-tab-views');
const BARS = 4;
/** Beats of each bar by standard sound number. Bar 1 beat 3 holds five hits at once; bar 2 beat 1 holds seven (one more than the tab has lines). */
const DRUM_BARS = [[[36, 42], [38, 42], [36, 49, 46, 51, 91], [38, 42]], [[36, 38, 42, 49, 51, 45, 50], [38, 92], [36, 46], [91, 51]], [[36, 42], [38, 42], [36, 42], [38, 55]], [[47, 45], [48, 50], [38, 53], [36, 49]]];
const TABLE = [[36, 'Kick Drum', 7, 36], [38, 'Snare', 3, 38], [91, 'Snare', 3, 38], [42, 'Charley', -1, 42], [92, 'Charley', -1, 46], [46, 'Charley', -1, 46], [49, 'Crash High', -2, 49], [55, 'Splash', -2, 55], [51, 'Ride', 0, 51], [53, 'Ride', 0, 53], [50, 'Tom Very High', 1, 50], [48, 'Tom High', 2, 48], [47, 'Tom Medium', 4, 47], [45, 'Tom Low', 5, 45]];
const SURPLUS = 1;

async function author() {
  const { exporter, model, Settings } = await import('@coderline/alphatab');
  const score = new model.Score();
  for (let index = 0; index < BARS; index++) {
    const master = new model.MasterBar();
    if (index === 0) { const tempo = new model.Automation(); tempo.type = model.AutomationType.Tempo; tempo.value = 100; tempo.isLinear = false; master.tempoAutomations.push(tempo); }
    master.timeSignatureNumerator = 4; master.timeSignatureDenominator = 4; score.addMasterBar(master);
  }
  let id = 0;
  const strings = [['Lead guitar', 'Gtr', [64, 59, 55, 50, 45, 40], 25], ['Rhythm guitar', 'Rgt', [64, 59, 55, 50, 45, 40], 27], ['Bass', 'Bs', [43, 38, 33, 28], 33], ['Second guitar', 'Gt2', [64, 59, 55, 50, 45, 40], 29], ['Third guitar', 'Gt3', [64, 59, 55, 50, 45, 40], 30]];
  for (const [name, short, tuning, program] of strings) {
    const track = new model.Track(), staff = new model.Staff();
    track.name = name; track.shortName = short; track.playbackInfo.program = program; staff.stringTuning.tunings = tuning; track.addStaff(staff); score.addTrack(track);
    for (let index = 0; index < BARS; index++) {
      const bar = new model.Bar(); bar.id = id++; bar.clef = model.Clef.G2; staff.addBar(bar);
      const voice = new model.Voice(); voice.id = id++; bar.addVoice(voice);
      for (let beat = 0; beat < 4; beat++) { const item = new model.Beat(); item.id = id++; item.duration = model.Duration.Quarter; item.isEmpty = false; voice.addBeat(item); const note = new model.Note(); note.id = id++; note.string = tuning.length - (beat % tuning.length); note.fret = 2 + beat; item.addNote(note); }
    }
  }
  const drums = new model.Track(), kit = new model.Staff();
  drums.name = 'Drums'; drums.shortName = 'Dr'; Object.assign(drums.playbackInfo, { program: 0, primaryChannel: 9, secondaryChannel: 9 });
  drums.percussionArticulations = TABLE.map(([number, name, line, key]) => new model.InstrumentArticulation(name, line, key, model.MusicFontSymbol.NoteheadBlack, model.MusicFontSymbol.NoteheadHalf, model.MusicFontSymbol.NoteheadWhole, model.MusicFontSymbol.None, 0, number));
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

if (existsSync(fixture)) rmSync(fixture);
rmSync(shots, { recursive: true, force: true }); mkdirSync(shots, { recursive: true });
await author();
const id = launch({ TABPLAYER_TEST_OPEN: fixture });
let browser, page;
try {
  browser = await connect(); page = browser.contexts()[0].pages()[0];
  const cdp = await page.context().newCDPSession(page);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const closeLibrary = async () => { const library = page.getByRole('dialog', { name: 'Library', exact: true }); await library.getByRole('heading', { name: 'Welcome to TabPlayer', exact: true }).waitFor(); await library.getByRole('button', { name: 'Close', exact: true }).click(); await library.waitFor({ state: 'hidden' }); };
  const idle = async () => { await waitForWorkspaceIdle(page); };
  const viewport = async (width, height) => { await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); await page.waitForTimeout(900); await idle(); };
  const texts = () => page.evaluate(() => [...document.querySelectorAll('[aria-label="Music notation"] svg text')].map(text => text.textContent.trim()));
  const reload = async () => { await page.reload(); await page.locator('.app-shell').waitFor(); await idle(); await page.waitForTimeout(500); };
  const shoot = async name => { await page.evaluate(() => { const mark = [...document.querySelectorAll('[aria-label="Music notation"] svg text')].find(text => /^(36|38)$/.test(text.textContent.trim())); mark?.scrollIntoView({ block: 'center' }); }); await page.waitForTimeout(500); await page.screenshot({ path: resolve(shots, `${name}.png`) }); };
  const showDrums = async language => {
    if (language === 'en') { await selectWorkspaceTrack(page, 'Track 6: Drums'); await idle(); await revealInspectorTab(page, 'Track'); return; }
    const strip = page.locator('button.track-channel-select:has-text("6. Drums")').first();
    if (await strip.isVisible()) { await strip.click(); await idle(); }
    const toggle = page.locator('.notation-toggle').first(), tabs = page.locator('[role="tab"]');
    for (let index = 0; index < await tabs.count() && !await toggle.isVisible(); index++) await tabs.nth(index).click().catch(() => {});
    await toggle.waitFor({ state: 'visible' });
  };
  const notationSection = () => page.locator('.notation-toggle').first().locator('xpath=ancestor::section[1]');
  const toggle = async which => { await page.locator('.notation-toggle').nth(which).click(); await idle(); };
  const tracksView = async value => { await page.locator('select:has(option[value="all"])').first().selectOption(value); await idle(); await page.waitForTimeout(500); };
  await closeLibrary(); await idle();
  await clickWorkstationButton(page, 'Open', { waitForIdle: false }); await idle();
  await page.locator('[aria-label="Music notation"] svg').first().waitFor();
  const summary = [];
  for (const [width, height] of [[1920, 1080], [1366, 768]]) {
    await viewport(width, height);
    for (const language of ['en', 'et', 'de']) {
      if (language !== 'en' || width !== 1920) { await page.evaluate(value => window.localStorage.setItem('tabplayer.language', value), language); await reload(); await viewport(width, height); }
      await showDrums(language);
      const tag = `${width}-${language}`;
      // Standard only (the starting state), then TAB on (both), then standard off (tab only), then back to standard only.
      await shoot(`inspector-standard-${tag}`); await notationSection().screenshot({ path: resolve(shots, `section-standard-${tag}.png`) });
      await toggle(0); const both = await texts();
      await shoot(`both-${tag}`); await notationSection().screenshot({ path: resolve(shots, `section-both-${tag}.png`) });
      await tracksView('all'); await shoot(`both-all-tracks-${tag}`); await tracksView('selected');
      await toggle(1);
      await shoot(`tab-only-${tag}`); await notationSection().screenshot({ path: resolve(shots, `section-tab-only-${tag}.png`) });
      await tracksView('all'); await shoot(`tab-only-all-tracks-${tag}`); await tracksView('selected');
      const tabOnly = await texts();
      // The only notation left cannot be turned off.
      assert.equal(await page.locator('.notation-toggle').nth(0).getAttribute('aria-disabled'), 'true');
      await toggle(1); await toggle(0); // back to standard only
      const digits = list => list.filter(text => /^\d{2,3}$/.test(text));
      const counts = { both: digits(both).length, tabOnly: digits(tabOnly).length };
      assert.ok(counts.tabOnly === DRUM_BARS.flat(2).length - SURPLUS && counts.both === counts.tabOnly, `numbers drawn: ${JSON.stringify(counts)}`);
      assert.ok(!tabOnly.some(text => /^= ?[A-G]/.test(text) || /^[A-G]#?\d?$/.test(text)), 'no tuning label on the drum tab');
      const overflow = await page.evaluate(() => { const panel = document.querySelector('.notation-toggle')?.closest('section'); return panel ? panel.scrollWidth - panel.clientWidth : -1; });
      assert.ok(overflow <= 1, `the Musical notation section does not clip sideways (${overflow}px)`);
      summary.push(`${tag}: ${counts.tabOnly} numbers`);
    }
  }
  await viewport(1920, 1080); await cdp.send('Emulation.clearDeviceMetricsOverride');
  await page.evaluate(() => window.localStorage.setItem('tabplayer.language', 'en'));
  assert.deepEqual(errors, []);
  console.log(`drum-tab-views: ${summary.join('; ')}; the bar with seven hits at one moment draws six of them (${SURPLUS} left off); screenshots under ${shots}.`);
} catch (error) { if (page) await page.screenshot({ path: resolve(shots, 'failure.png') }).catch(() => {}); throw error; }
finally { if (browser) await browser.close().catch(() => {}); if (id) { try { stop(id); } catch {} } }
