// The inspector fixes (picking and playing a track keeps its staff in view, the Track tab scrolls with the wheel, Add track is a dialog, the
// Information arrows choose tracks and Track > Move track reorders, the Plug-in row and Sound > VST3 plug-in…), driven in the real app over CDP
// with real mouse wheel, mouse and key events, on a generated score of five guitar tracks and drums over 52 bars, at 1366x768 and 1920x1080.
// usage (from the checkout root, after scripts/build-desktop-test.ps1): node tests/desktop/inspector-fixes.mjs [screenshot-directory] [--shots-only]
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { exporter, model, Settings } from '@coderline/alphatab';
import { directory } from './harness.mjs';
import { openScore, settle, sleep, SIZES } from './entry-mix-support.mjs';
import { revealDock, revealInspectorTab, clickTrackMenuItem, closeInspectorDialogs } from './workstation-commands.mjs';

const shots = resolve(process.argv.find((arg, index) => index > 1 && !arg.startsWith('--')) ?? '.analysis/desktop-smoke/inspector-fixes'); mkdirSync(shots, { recursive: true });
const BARS = 52, GUITARS = ['Rhythm', 'Lead', 'Clean', 'Acoustic', 'Octave'], NAMES = [...GUITARS, 'Drums'];
const report = { checks: [], shots };
const note = (name, evidence = {}) => { report.checks.push({ name, evidence }); console.log(`ok - ${name} ${JSON.stringify(evidence)}`); };

/** Five guitar tracks and a drum track of quarter-note bars, at a tempo that crosses systems quickly, written by alphaTab's own GP7 exporter. */
function buildScore() {
  const score = new model.Score(); score.title = 'Inspector fixes'; score.artist = 'TabPlayer desktop verification';
  for (let index = 0; index < BARS; index++) {
    const master = new model.MasterBar(); master.timeSignatureNumerator = 4; master.timeSignatureDenominator = 4;
    if (index === 0) { const tempo = new model.Automation(); tempo.type = model.AutomationType.Tempo; tempo.value = 240; tempo.isLinear = false; master.tempoAutomations.push(tempo); }
    score.addMasterBar(master);
  }
  let id = 0;
  const bars = (staff, make) => { for (let b = 0; b < BARS; b++) { const bar = new model.Bar(); bar.id = id++; bar.clef = staff.isPercussion ? model.Clef.Neutral : model.Clef.G2; staff.addBar(bar); const voice = new model.Voice(); voice.id = id++; bar.addVoice(voice); for (let i = 0; i < 4; i++) { const beat = new model.Beat(); beat.id = id++; beat.duration = model.Duration.Quarter; beat.isEmpty = false; voice.addBeat(beat); make(beat, b, i); } } };
  for (const [t, name] of GUITARS.entries()) {
    const track = new model.Track(), staff = new model.Staff(); track.name = name; track.shortName = name.slice(0, 3);
    Object.assign(track.playbackInfo, { program: 25, primaryChannel: t * 2, secondaryChannel: t * 2 + 1 });
    staff.stringTuning.tunings = [64, 59, 55, 50, 45, 40]; staff.showTablature = true; staff.showStandardNotation = true; track.addStaff(staff); score.addTrack(track);
    bars(staff, (beat, b, i) => { const note = new model.Note(); note.id = id++; note.string = 1 + ((b + i + t) % 6); note.fret = (b * 2 + i + t) % 12; beat.addNote(note); });
  }
  const drums = new model.Track(), staff = new model.Staff(); drums.name = 'Drums'; drums.shortName = 'Dr';
  Object.assign(drums.playbackInfo, { program: 0, primaryChannel: 9, secondaryChannel: 9 });
  const articulations = [[36, 'Kick Drum', 7], [38, 'Snare', 3], [42, 'Hi-Hat (closed)', -1]], articulationOf = { 36: 0, 38: 1, 42: 2 };
  drums.percussionArticulations = articulations.map(([key, label, line]) => new model.InstrumentArticulation(label, line, key, model.MusicFontSymbol.NoteheadBlack, model.MusicFontSymbol.NoteheadHalf, model.MusicFontSymbol.NoteheadWhole, model.MusicFontSymbol.None, model.TechniqueSymbolPlacement.Above, key));
  staff.isPercussion = true; staff.showTablature = false; staff.showStandardNotation = true; drums.addStaff(staff); score.addTrack(drums);
  bars(staff, (beat, _b, i) => { const note = new model.Note(); note.id = id++; note.percussionArticulation = articulationOf[[36, 42, 38, 42][i]]; beat.addNote(note); });
  score.finish(new Settings());
  return new exporter.Gp7Exporter().export(score, new Settings());
}

SIZES.inspector = { tracks: NAMES.length, bars: BARS };
writeFileSync(resolve(directory, 'entry-mix-inspector.gp'), buildScore());
const session = await openScore('inspector'), { page, cdp } = session;
const edits = async () => (await session.edits());
const viewport = async (width, height) => { await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); await sleep(900); await settle(page, 600); };
const trackTab = () => page.locator('#inspector-tab-track').click();
const trackName = () => page.locator('.track-settings').getByLabel('Track name', { exact: true }).inputValue();
const shot = async name => { await page.screenshot({ path: resolve(shots, name) }); report.shots = [...(report.shots?.push ? report.shots : []), name]; };
const language = async code => { await closeInspectorDialogs(page); const view = page.locator('summary').filter({ hasText: /^View$|^Vaade$|^Ansicht$/ }); if (!await view.evaluate(node => node.parentElement.open)) await view.click(); await page.getByLabel(/^Language$|^Keel$|^Sprache$/).selectOption(code); await sleep(500); await view.click(); await sleep(300); };

/** Every track of the score shown, as a score open on all six is. */
async function showAllTracks() {
  await revealDock(page, 'Overview');
  for (const name of NAMES) { const eye = page.locator(`button[aria-label="Show ${name} in the score"]`); await reach(eye); if (await eye.count() && await eye.getAttribute('aria-pressed') === 'false') { await eye.click(); await sleep(250); } }
  await settle(page, 900);
}
/** The dock's track list draws only the rows near its scroll position: wheel it, as a player would, until the row is there. */
const reach = async button => {
  const grid = page.locator('.score-overview').first(), box = await grid.boundingBox();
  for (let i = 0; i < 12 && !await button.count(); i++) { await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.wheel(0, i < 6 ? 120 : -600); await sleep(200); }
  await button.scrollIntoViewIfNeeded();
};
const pick = async name => { if (!await page.locator('.score-overview').first().isVisible()) await revealDock(page, 'Overview'); const button = page.locator('button.score-overview-track-name').filter({ hasText: new RegExp(`^${name}$`) }); await reach(button); await button.click(); await sleep(900); };
const geometry = () => page.evaluate(() => {
  const host = document.querySelector('.paper-scroll'), box = document.querySelector('.score-edit-target');
  const h = host.getBoundingClientRect(), c = box?.getBoundingClientRect();
  return { host: { top: h.top, bottom: h.bottom, height: h.height }, scrollTop: host.scrollTop, scrollMax: host.scrollHeight - host.clientHeight, caret: c ? { top: c.top, bottom: c.bottom, centre: (c.top + c.bottom) / 2 } : null };
});

try {
  // ---- 0. state of the view -------------------------------------------------------------------------------------------------------------
  await revealInspectorTab(page, 'Track');
  assert.equal(await page.locator('.workstation-inspector details.track-add').count(), 0, 'the sidebar has no Add instrument disclosure');
  assert.equal(await page.getByText('Add instrument', { exact: true }).count(), 0);
  await showAllTracks();

  for (const [width, height] of [[1366, 768], [1920, 1080]]) {
    await viewport(width, height); const tag = `${width}x${height}`;
    await revealDock(page, 'Overview');

    // ---- 1a. picking each track centres its staff ------------------------------------------------------------------------------------------
    const picks = [];
    await pick('Clean'); // a pick of the track that is already selected changes no track, so start from another one
    for (const name of [...NAMES, 'Rhythm', 'Drums', 'Clean']) {
      await pick(name); const g = await geometry(); assert.ok(g.caret, `the edit target of ${name} is drawn`);
      const middle = (g.host.top + g.host.bottom) / 2, offset = Math.round(g.caret.centre - middle), atEdge = g.scrollTop <= 1 || g.scrollTop >= g.scrollMax - 1;
      picks.push({ name, offset, scrollTop: Math.round(g.scrollTop), atEdge });
      assert.ok(g.caret.top >= g.host.top - 1 && g.caret.bottom <= g.host.bottom + 1, `${tag}: ${name}'s edit target is inside the score area`);
      // Centred within a staff's height of the middle, or the score ran out of room at an end of its scroll range.
      assert.ok(Math.abs(offset) <= 90 || atEdge, `${tag}: ${name} is centred (offset ${offset}px, scrollTop ${g.scrollTop}/${g.scrollMax})`);
    }
    note(`${tag}: picking a track centres its staff in the score area`, picks);
    await pick('Drums'); await shot(`score-drums-picked-${tag}.png`);

    // ---- 1b. arrow keys inside a track keep the nearest-edge behaviour --------------------------------------------------------------------
    await pick('Drums'); const before = await geometry();
    await page.locator('.paper-scroll').focus().catch(() => {}); await page.keyboard.press('ArrowRight'); await sleep(300); const after = await geometry();
    assert.ok(Math.abs(after.scrollTop - before.scrollTop) <= 2, `${tag}: moving along the track does not re-centre it`);
    note(`${tag}: an arrow key inside the track leaves the scroll position alone`, { before: before.scrollTop, after: after.scrollTop });

    // ---- 1c. playing with the drums selected keeps the drum staff in view across a system change ---------------------------------------
    await pick('Drums'); await page.keyboard.press('Home'); await sleep(300);
    await page.keyboard.press('Space'); const samples = [];
    for (let i = 0; i < 70; i++) {
      await sleep(250);
      samples.push(await page.evaluate(() => {
        const host = document.querySelector('.paper-scroll').getBoundingClientRect(), bar = document.querySelector('.score-playback-bar:not([hidden])') ?? document.querySelector('.at-cursor-bar'), r = bar?.getBoundingClientRect();
        return r ? { barTop: Math.round(r.top + document.querySelector('.paper-scroll').scrollTop), barBottom: Math.round(r.bottom), top: Math.round(r.top), hostTop: host.top, hostBottom: host.bottom } : null;
      }));
      if (new Set(samples.filter(Boolean).map(s => s.barTop)).size >= 4 && i > 20) break;
    }
    await page.keyboard.press('Space'); await sleep(400);
    const live = samples.filter(Boolean), systems = new Set(live.map(s => s.barTop)).size;
    assert.ok(live.length > 8, `${tag}: the playback bar was seen (${live.length} samples)`);
    // The drum staff is the last in the system: its band from 140 px to 20 px above the bar's bottom edge (the staff, without the bar's padding) must be inside the score area at every sample.
    const hidden = live.filter(s => s.barBottom - 20 > s.hostBottom + 2 || s.barBottom - 140 < s.hostTop);
    assert.equal(hidden.length, 0, `${tag}: the drum staff stayed in view (${hidden.length} of ${live.length} samples out): ${JSON.stringify(hidden.slice(0, 2))}`);
    assert.ok(systems >= 2, `${tag}: playback crossed ${systems} systems`);
    note(`${tag}: playing with the drums selected keeps their staff in view`, { samples: live.length, systems });
    await page.keyboard.press('Home'); await sleep(300);

    // ---- 2. the wheel scrolls the Track tab from anywhere over its content, top to bottom ------------------------------------------------
    await pick('Rhythm'); await revealInspectorTab(page, 'Track');
    const scroller = page.locator('.workstation-inspector'), box = await scroller.boundingBox();
    const info = () => scroller.evaluate(node => ({ top: node.scrollTop, max: node.scrollHeight - node.clientHeight, client: node.clientHeight }));
    await scroller.evaluate(node => { node.scrollTop = 0; });
    const start = await info(); assert.ok(start.max > 40, `${tag}: the Track tab is taller than the sidebar (${start.max}px to scroll)`);
    const spots = [['the Information arrows', '.track-actions'], ['the track name field', '.track-info-row'], ['the tuning row', '.track-tuning-row'], ['the Sounds section', '.sound-summary'], ['the Musical notation heading', '#inspector-track-notation']];
    for (const [label, selector] of spots) {
      await scroller.evaluate(node => { node.scrollTop = 0; });
      const target = page.locator(selector).first(); const r = await target.boundingBox(); if (!r) continue;
      if (r.y < box.y || r.y + r.height > box.y + box.height) continue;
      await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2); await page.mouse.wheel(0, 120); await sleep(150);
      const moved = await info(); assert.ok(moved.top > 0, `${tag}: the wheel scrolls over ${label} (${moved.top})`);
    }
    await scroller.evaluate(node => { node.scrollTop = 0; });
    await page.mouse.move(box.x + box.width / 2, box.y + 200);
    for (let i = 0; i < 60 && (await info()).top < (await info()).max - 1; i++) { await page.mouse.wheel(0, 240); await sleep(40); }
    const end = await info(); assert.ok(end.top >= end.max - 1, `${tag}: the wheel reached the bottom of the Track tab (${end.top}/${end.max})`);
    await shot(`sidebar-track-bottom-${tag}.png`);
    for (let i = 0; i < 60 && (await info()).top > 0; i++) { await page.mouse.wheel(0, -240); await sleep(40); }
    assert.equal((await info()).top, 0, `${tag}: and back to the top`);
    note(`${tag}: the wheel scrolls the Track tab over its content, top to bottom and back`, { overflow: start.max, spotsTried: spots.length });

    // ---- 3. Add track: the dock's + and Track > Add track… open the dialog; one undo step; nothing in the sidebar ------------------------
    const count = async () => (await session.snapshot()).project.edits.length, tracks = async () => Number(await page.locator('.score-overview[role="grid"], [role="grid"].score-overview').first().getAttribute('aria-rowcount')) - 1;
    const editsBefore = await count(), tracksBefore = await tracks();
    await revealDock(page, 'Overview'); await page.getByRole('button', { name: 'Add a track', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add track', exact: true }); await dialog.waitFor();
    assert.equal(await dialog.getByLabel('New track name', { exact: true }).evaluate(node => node === document.activeElement), true, 'the name field has focus');
    await shot(`add-track-dialog-from-plus-${tag}.png`);
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' }); assert.equal(await count(), editsBefore, 'Escape adds nothing');
    await clickTrackMenuItem(page, 'Add track…'); await dialog.waitFor();
    await dialog.getByLabel('New track name', { exact: true }).fill('Added bass'); await page.keyboard.press('Enter'); await dialog.waitFor({ state: 'hidden' }); await settle(page, 600);
    assert.equal(await count(), editsBefore + 1, 'adding is one edit'); assert.equal(await tracks(), tracksBefore + 1);
    assert.equal(await trackName(), 'Added bass', 'the new track is selected');
    await page.getByRole('button', { name: /^Undo/ }).first().click(); await settle(page, 600);
    assert.equal(await count(), editsBefore, 'one undo step removes it'); assert.equal(await tracks(), tracksBefore);
    note(`${tag}: Add track opens from the + and Track > Add track…, adds in one undoable edit and selects the new track`, { editsBefore });

    // ---- 4. the arrows choose tracks; Track > Move track up and down reorder with undo --------------------------------------------------
    await pick('Lead'); await revealInspectorTab(page, 'Track'); const e0 = await count();
    await page.locator('.track-settings').getByRole('button', { name: 'Next track', exact: true }).click(); await sleep(500);
    assert.equal(await trackName(), 'Clean'); assert.equal(await count(), e0, 'choosing a track records no edit');
    await page.locator('.track-settings').getByRole('button', { name: 'Previous track', exact: true }).click(); await sleep(500); assert.equal(await trackName(), 'Lead');
    await page.locator('.score-workspace').focus(); await page.keyboard.press('Control+ArrowDown'); await sleep(500); assert.equal(await trackName(), 'Clean', 'Ctrl+Down does the same');
    await page.keyboard.press('Control+ArrowUp'); await sleep(500); assert.equal(await trackName(), 'Lead');
    await clickTrackMenuItem(page, 'Move track down'); await settle(page, 600);
    assert.equal(await count(), e0 + 1); assert.deepEqual((await edits()).at(-1), { type: 'moveTrack', track: 1, to: 2 }); assert.equal(await trackName(), 'Lead', 'the selection follows the moved track');
    await clickTrackMenuItem(page, 'Move track up'); await settle(page, 600); assert.equal(await count(), e0 + 2);
    await page.getByRole('button', { name: /^Undo/ }).first().click(); await settle(page, 400); await page.getByRole('button', { name: /^Undo/ }).first().click(); await settle(page, 600);
    assert.equal(await count(), e0, 'two undo steps restore the order');
    await pick('Rhythm'); await revealInspectorTab(page, 'Track');
    assert.equal(await page.locator('.track-settings').getByRole('button', { name: 'Previous track', exact: true }).getAttribute('aria-disabled'), 'true', 'inert at the first track');
    note(`${tag}: the arrows and Ctrl+Up/Down choose tracks (no edit); Move track up/down is one undo step each`, { e0 });

    // ---- 5. the Plug-in row and Sound > VST3 plug-in… open the dialog at the plug-in slot, in view, Add plug-in… in two clicks -------------------------
    for (const name of ['Rhythm', 'Drums']) {
      await pick(name); await revealInspectorTab(page, 'Track');
      for (const via of ['row', 'menu']) {
        if (via === 'row') await page.locator('.sound-plugin-open').scrollIntoViewIfNeeded().then(() => page.locator('.sound-plugin-open').click());
        else await clickTrackMenuItem(page, 'VST3 plug-in…', 'Sound');
        const sound = page.locator('.sound-dialog'); await sound.waitFor();
        const slot = sound.locator('.sound-plugin-slot'), add = sound.getByRole('button', { name: 'Add plug-in…', exact: true });
        await add.waitFor(); const body = await sound.locator('.tp-dialog-body').boundingBox(), r = await slot.boundingBox(), a = await add.boundingBox();
        assert.ok(r.y >= body.y - 1 && a.y + a.height <= body.y + body.height + 1, `${tag}: ${name} via ${via}: the plug-in section and Add plug-in… are in view without scrolling`);
        assert.equal(await sound.getByRole('combobox', { name: 'VST3 plug-in' }).evaluate(node => node === document.activeElement), true, 'its choice has focus');
        if (via === 'row') await shot(`sound-dialog-from-plugin-row-${name === 'Drums' ? 'drums' : 'guitar'}-${tag}.png`);
        await page.keyboard.press('Escape'); await sound.waitFor({ state: 'hidden' });
      }
    }
    note(`${tag}: Plug-in… and Sound > VST3 plug-in… open the sound dialog at the plug-in slot with Add plug-in… in view (guitar and drums)`);
  }

  // ---- screenshots in English, Estonian and German ---------------------------------------------------------------------------------------
  await viewport(1366, 768);
  for (const code of ['en', 'et', 'de']) {
    await language(code); await trackTab();
    for (const [name, label] of [['Rhythm', 'guitar'], ['Drums', 'drums']]) {
      await pick(name); await trackTab(); await page.locator('.workstation-inspector').evaluate(node => { node.scrollTop = 0; });
      await shot(`sidebar-track-${label}-${code}.png`);
      await page.locator('.workstation-inspector').evaluate(node => { node.scrollTop = node.scrollHeight; }); await shot(`sidebar-track-${label}-${code}-bottom.png`);
      await page.locator('.workstation-inspector').evaluate(node => { node.scrollTop = 0; });
    }
    await page.locator('button.dock-add-track').click();
    const addDialog = page.locator('.add-track-dialog'); await addDialog.waitFor(); await shot(`add-track-dialog-${code}.png`);
    await page.keyboard.press('Escape'); await addDialog.waitFor({ state: 'hidden' });
    for (const [name, label] of [['Rhythm', 'guitar'], ['Drums', 'drums']]) {
      await pick(name); await trackTab(); await page.locator('.sound-plugin-open').click();
      const sound = page.locator('.sound-dialog'); await sound.waitFor(); await sleep(300); await shot(`sound-dialog-from-plugin-row-${label}-${code}.png`); await page.keyboard.press('Escape'); await sound.waitFor({ state: 'hidden' });
    }
  }
  await language('en');
  writeFileSync(resolve(shots, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`inspector fixes: ${report.checks.length} checks passed; screenshots in ${shots}`);
} finally { await session.close(); }
