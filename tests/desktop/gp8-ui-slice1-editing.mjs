// GP8 UI/UX Parity — Slice 1: Score Editing Ergonomics
// Verifies TAB caret placement/traversal, click-on-empty-string, always-on GP8 shortcuts,
// continuous ArrowRight beat insert & measure append, single-beat Ctrl+C/Ctrl+V, and pointer focus retention.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { exporter, model, Settings } from '@coderline/alphatab';
import { connect, directory, launch, stop } from './harness.mjs';
import { readActiveDocument } from './document-context.mjs';
import { closeWelcomeLibrary, cursorPosition, waitForWorkspaceIdle } from './workstation-commands.mjs';

const fixture = resolve(directory, 'gp8-slice1-fixture.gp');
{
  const score = new model.Score();
  const track = new model.Track();
  const staff = new model.Staff();
  track.name = 'Guitar';
  track.playbackInfo.program = 25;
  staff.stringTuning.tunings = [64, 59, 55, 50, 45, 40];
  staff.showStandardNotation = true;
  staff.showTablature = true;
  track.addStaff(staff);
  score.addTrack(track);
  for (let barIdx = 0; barIdx < 2; barIdx++) {
    score.addMasterBar(new model.MasterBar());
    const bar = new model.Bar();
    const voice = new model.Voice();
    bar.clef = model.Clef.G2;
    for (let beatIdx = 0; beatIdx < 4; beatIdx++) {
      const beat = new model.Beat();
      beat.duration = 4;
      beat.isEmpty = false;
      if (barIdx === 0 && (beatIdx === 0 || beatIdx === 1)) {
        const note = new model.Note();
        note.string = 6;
        note.fret = 5;
        beat.addNote(note);
      }
      voice.addBeat(beat);
    }
    bar.addVoice(voice);
    staff.addBar(bar);
  }
  score.finish(new Settings());
  writeFileSync(fixture, new exporter.Gp7Exporter().export(score, new Settings()));
}

const id = launch({ TABPLAYER_TEST_OPEN: fixture });
let browser;
let page;
try {
  browser = await connect();
  page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  await waitForWorkspaceIdle(page);
  await closeWelcomeLibrary(page);
  await page.setViewportSize({ width: 1366, height: 768 });

  const fileSummary = page.locator('header details.command-menu summary', { hasText: /^File$/ });
  await fileSummary.click();
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await waitForWorkspaceIdle(page);
  await page.locator('[aria-label="Music notation"] svg').first().waitFor();
  await page.locator('.score-edit-target').waitFor();
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

  const edits = async () => (await readActiveDocument(page)).project.edits;
  const idle = async () => {
    await waitForWorkspaceIdle(page);
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  };
  const workspace = page.getByRole('region', { name: 'Score workspace', exact: true });
  const caretBox = () => page.locator('.score-edit-target').boundingBox();
  const focusInScore = () => page.evaluate(() => {
    const pane = document.querySelector('.score-workspace');
    return Boolean(pane && pane.contains(document.activeElement));
  });

  // 1. TAB caret placement & monotonic 6-string vertical traversal + no obstructive pill
  const caretMeta = await page.evaluate(() => {
    const target = document.querySelector('.score-edit-target');
    const entry = document.querySelector('.score-edit-entry');
    return {
      tabAttr: target?.getAttribute('data-tab') ?? null,
      hasEntryPill: Boolean(entry),
    };
  });
  assert.equal(caretMeta.tabAttr, 'true', 'Caret marks data-tab="true" when TAB staff is shown');
  assert.equal(caretMeta.hasEntryPill, false, 'No obstructive String N pill over TAB bar numbers');

  const staffGeometry = await page.evaluate(() => {
    const raw = [...document.querySelectorAll('[aria-label="Music notation"] svg rect')]
      .map(r => r.getBoundingClientRect())
      .filter(b => b.height > 0 && b.height < 2.5 && b.width > 80);
    const maxW = Math.max(...raw.map(b => b.width));
    const wide = raw.filter(b => b.width >= maxW * 0.5);
    const ys = [...new Set(wide.map(b => Math.round((b.y + b.height / 2) * 10) / 10))].sort((a, b) => a - b);
    return {
      trebleYs: ys.slice(0, 5),
      tabYs: ys.slice(5, 11),
    };
  });
  assert.equal(staffGeometry.trebleYs.length, 5, `Expected 5 treble lines, got ${staffGeometry.trebleYs.length}`);
  assert.equal(staffGeometry.tabYs.length, 6, `Expected 6 TAB lines, got ${staffGeometry.tabYs.length}`);
  const tabSpacing = staffGeometry.tabYs[1] - staffGeometry.tabYs[0];
  assert.ok(tabSpacing > 4, `Unexpected TAB line spacing: ${tabSpacing}`);

  // Capture crisp 1366x768 & 1920x1080 Slice 1 visual checkpoints cleanly with TAB caret at initial Beat 1 String 6
  const assertNoOverflow = async label => {
    const doc = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
    assert.ok(doc.scroll <= doc.inner + 1, `No horizontal overflow at ${label}: ${doc.scroll} <= ${doc.inner}`);
  };
  await assertNoOverflow('1366x768');
  await page.screenshot({ path: resolve(directory, 'gp8-slice1-1366.png') });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await idle();
  await assertNoOverflow('1920x1080');
  await page.screenshot({ path: resolve(directory, 'gp8-slice1-1920.png') });
  await page.setViewportSize({ width: 1366, height: 768 });
  await idle();

  // Re-measure TAB lines at 1366x768 in case zoom/reflow shifted coordinates
  const lines1366 = await page.evaluate(() => {
    const raw = [...document.querySelectorAll('[aria-label="Music notation"] svg rect')]
      .map(r => r.getBoundingClientRect())
      .filter(b => b.height > 0 && b.height < 2.5 && b.width > 80);
    const maxW = Math.max(...raw.map(b => b.width));
    const ys = [...new Set(raw.filter(b => b.width >= maxW * 0.5).map(b => Math.round((b.y + b.height / 2) * 10) / 10))].sort((a, b) => a - b);
    return { trebleYs: ys.slice(0, 5), tabYs: ys.slice(5, 11) };
  });
  const spacing1366 = lines1366.tabYs[1] - lines1366.tabYs[0];

  await workspace.focus();
  const initialBox = await caretBox();
  const initialCenterY = initialBox.y + initialBox.height / 2;
  assert.ok(initialCenterY > lines1366.trebleYs[4] + 10, `Caret (${initialCenterY}) must sit on TAB, below treble (${lines1366.trebleYs[4]})`);
  assert.ok(Math.abs(initialCenterY - lines1366.tabYs[0]) <= 4, `Initial caret centerY (${initialCenterY}) aligns with top TAB line (${lines1366.tabYs[0]})`);

  const stringCenters = [initialCenterY];
  for (let i = 1; i < 6; i++) {
    await page.keyboard.press('ArrowDown');
    await idle();
    const box = await caretBox();
    const cy = box.y + box.height / 2;
    assert.ok(cy > stringCenters.at(-1) + 2, `ArrowDown #${i} moved Y strictly downward (${stringCenters.at(-1)} -> ${cy})`);
    assert.ok(Math.abs((cy - stringCenters.at(-1)) - spacing1366) <= 3.5, `Step ${cy - stringCenters.at(-1)} matches TAB spacing ${spacing1366}`);
    assert.ok(Math.abs(cy - lines1366.tabYs[i]) <= 4, `String line ${i} Y (${cy}) aligns with SVG TAB line (${lines1366.tabYs[i]})`);
    stringCenters.push(cy);
  }
  assert.equal((await cursorPosition(page)).string, 1, 'Reached bottom string (alphaTab String 1)');

  // 2. Direct click on empty TAB rest beat (Beat 3, 1-based / index 2) on TAB line 4 (0-based -> String 2)
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await idle();
  const beat2Box = await caretBox();
  const beat2CenterX = beat2Box.x + beat2Box.width / 2;
  await page.keyboard.press('Home');
  await idle();

  await page.mouse.click(beat2CenterX, lines1366.tabYs[4]);
  await idle();
  const afterEmptyClick = await cursorPosition(page);
  assert.equal(afterEmptyClick.bar, 1);
  assert.equal(afterEmptyClick.beat, 3, 'Clicked Beat 3 (0-based beat 2)');
  assert.equal(afterEmptyClick.string, 2, 'Clicked 5th line down (alphaTab String 2)');

  const beforeDigitCount = (await edits()).length;
  await page.keyboard.press('7');
  await waitForWorkspaceIdle(page);
  await page.keyboard.press('Escape');
  await idle();
  let list = await edits();
  assert.equal(list.length, beforeDigitCount + 1, 'Digit 7 wrote note on clicked string');
  assert.deepEqual(
    [list.at(-1).type, list.at(-1).target, list.at(-1).string, list.at(-1).fret],
    ['setNote', { track: 0, staff: 0, bar: 0, voice: 0, beat: 2 }, 2, 7],
  );
  // Undo the digit so Bar 1 has only beats 0 and 1 fretted on string 6 fret 5
  await page.keyboard.press('Control+z');
  await idle();

  // 3. Always-on GP8 shortcuts with Note entry OFF
  const noteEntryBtn = page.getByRole('button', { name: 'Note entry', exact: true });
  assert.equal(await noteEntryBtn.getAttribute('aria-pressed'), 'false', 'Note entry starts OFF');
  await page.mouse.click(initialBox.x + initialBox.width / 2, lines1366.tabYs[0]);
  await workspace.focus();
  await page.keyboard.press('Home');
  await idle();
  assert.deepEqual([(await cursorPosition(page)).beat, (await cursorPosition(page)).string], [1, 6]);

  const expectOneEdit = async (fn, check) => {
    const before = (await edits()).length;
    await fn();
    await idle();
    const after = await edits();
    assert.equal(after.length, before + 1, 'Shortcut recorded one edit');
    check(after.at(-1));
    return after.at(-1);
  };

  // Tie (L) between matching beat 0 and beat 1 fret-5 notes, then undo tie cleanly
  await expectOneEdit(() => page.keyboard.press('l'), e => assert.deepEqual([e.type, e.kind], ['setNoteLink', 'tie']));
  await page.keyboard.press('Control+z');
  await idle();

  // + (shorter -> 8th), . (dotted 8th), . (undot), / (triplet), / (untriplet), - (quarter)
  await expectOneEdit(() => page.keyboard.press('+'), e => assert.deepEqual([e.type, e.duration, e.dots], ['setDuration', 8, 0]));
  await expectOneEdit(() => page.keyboard.press('.'), e => assert.deepEqual([e.type, e.duration, e.dots], ['setDuration', 8, 1]));
  await expectOneEdit(() => page.keyboard.press('.'), e => assert.deepEqual([e.type, e.duration, e.dots], ['setDuration', 8, 0]));
  await expectOneEdit(() => page.keyboard.press('/'), e => assert.deepEqual([e.type, e.tupletNumerator, e.tupletDenominator], ['setBeatRhythm', 3, 2]));
  await expectOneEdit(() => page.keyboard.press('/'), e => assert.deepEqual([e.type, e.tupletNumerator, e.tupletDenominator], ['setBeatRhythm', 1, 1]));
  await expectOneEdit(() => page.keyboard.press('-'), e => assert.deepEqual([e.type, e.duration, e.dots], ['setDuration', 4, 0]));

  // O (ghost), B (bend), P (palm mute), X (dead), R (rest leaving cursor in place)
  await expectOneEdit(() => page.keyboard.press('o'), e => assert.deepEqual(e.patch, { ghost: true }));
  await expectOneEdit(() => page.keyboard.press('b'), e => assert.equal(e.patch.bend?.type, 1));
  await expectOneEdit(() => page.keyboard.press('p'), e => assert.deepEqual(e.patch, { palmMute: true }));
  await expectOneEdit(() => page.keyboard.press('x'), e => assert.deepEqual(e.patch, { dead: true }));
  await expectOneEdit(() => page.keyboard.press('r'), e => assert.equal(e.type, 'setRest'));
  assert.equal((await cursorPosition(page)).beat, 1, 'R rest does not advance cursor when Note entry is OFF');

  // Insert on underfull bar (shorten beat 0 first with + so bar has room)
  await expectOneEdit(() => page.keyboard.press('+'), e => assert.equal(e.duration, 8));
  await expectOneEdit(() => page.keyboard.press('Insert'), e => assert.equal(e.type, 'insertBeat'));

  // Delete single note on Beat 2 (now index 2 after Insert before Beat 0)
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await idle();
  await expectOneEdit(() => page.keyboard.press('Delete'), e => assert.equal(e.type, 'removeNote'));

  // Re-add notes on Beat 0 & Beat 1, then Shift+ArrowRight + Delete clears multi-beat selection via eraseSelection
  await page.keyboard.press('Home');
  await page.keyboard.press('3');
  await waitForWorkspaceIdle(page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('3');
  await waitForWorkspaceIdle(page);
  await page.keyboard.press('Escape');
  await idle();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+ArrowRight');
  await expectOneEdit(() => page.keyboard.press('Delete'), e => assert.equal(e.type, 'eraseSelection'));

  // 4. Continuous ArrowRight flow (insertBeat into underfull bar 2, then appendMeasure at full last bar)
  // Undo everything so fixture is clean again
  for (let remaining = (await edits()).length; remaining > 0; remaining--) {
    await page.keyboard.press('Control+z');
    await idle();
  }
  assert.equal((await edits()).length, 0);

  // Move to Bar 2 last beat (Beat 4, index 3), shorten with + so Bar 2 has room
  await page.keyboard.press('Control+End');
  await page.keyboard.press('End');
  await idle();
  assert.deepEqual([(await cursorPosition(page)).bar, (await cursorPosition(page)).beat], [2, 4]);
  await expectOneEdit(() => page.keyboard.press('+'), e => assert.equal(e.duration, 8));

  // ArrowRight on last beat of underfull Bar 2 -> inserts beat 5
  await expectOneEdit(() => page.keyboard.press('ArrowRight'), e => assert.deepEqual([e.type, e.target.bar, e.target.beat], ['insertBeat', 1, 4]));
  assert.deepEqual([(await cursorPosition(page)).bar, (await cursorPosition(page)).beat], [2, 5]);

  // ArrowRight on last beat of now-full last Bar 2 -> appends Bar 3
  await expectOneEdit(() => page.keyboard.press('ArrowRight'), e => assert.equal(e.type, 'appendMeasure'));
  assert.deepEqual([(await cursorPosition(page)).bar, (await cursorPosition(page)).beat], [3, 1]);

  // 5. Single-beat Ctrl+C / Ctrl+V without drag selection
  await page.keyboard.press('Control+Home');
  await idle();
  await page.keyboard.press('Control+c');
  await idle();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await idle();
  await expectOneEdit(() => page.keyboard.press('Control+v'), e => assert.equal(e.type, 'pasteMusic'));
  // Confirm pasted fret 5 note now accepts a technique toggle on beat index 2!
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await idle();
  await expectOneEdit(() => page.keyboard.press('p'), e => assert.deepEqual([e.type, e.target.beat, e.patch], ['setNoteTechniques', 2, { palmMute: true }]));

  // 6. Pointer-click focus retention: Palette direct action, Tuplet menuitem, and Toolbar Undo
  const palette = page.getByRole('complementary', { name: 'Edition palette', exact: true });
  await expectOneEdit(() => palette.getByRole('button', { name: 'Heavy accent', exact: true }).click(), e => assert.equal(e.type, 'setNoteTechniques'));
  assert.equal(await focusInScore(), true, 'Focus returns to score workspace after clicking Edition Palette button');
  await page.keyboard.press('ArrowRight');
  await idle();
  assert.equal((await cursorPosition(page)).beat, 4, 'ArrowRight works immediately after clicking Edition Palette button');

  await page.keyboard.press('ArrowLeft');
  await idle();
  await palette.getByRole('button', { name: 'Tuplet', exact: true }).click();
  await expectOneEdit(() => palette.getByRole('menuitemradio', { name: /5:4/ }).click(), e => assert.deepEqual([e.type, e.tupletNumerator], ['setBeatRhythm', 5]));
  assert.equal(await focusInScore(), true, 'Focus returns to score workspace after picking Tuplet menuitem');

  const beforeUndoLen = (await edits()).length;
  await page.locator('.gp-toolbar').getByRole('button', { name: 'Undo', exact: true }).click();
  await idle();
  assert.equal((await edits()).length, beforeUndoLen - 1, 'Toolbar Undo undid one edit');
  assert.equal(await focusInScore(), true, 'Focus returns to score workspace after clicking toolbar Undo');

  const noteEntry = page.locator('.note-entry-toggle');
  await noteEntry.focus();
  assert.ok(await noteEntry.evaluate(el => el === document.activeElement), 'Note entry button can receive focus');
  await page.keyboard.press('Enter');
  assert.equal(await noteEntry.getAttribute('aria-pressed'), 'true');
  assert.ok(await noteEntry.evaluate(el => el === document.activeElement), 'Enter keeps focus on the Note entry button');
  assert.equal(await page.locator('.score-edit-target').getAttribute('data-tab'), 'true');
  await noteEntry.click();
  await idle();
  assert.ok(await focusInScore());

  const inspector = page.locator('[data-pane-toggle="inspector"]');
  if (await inspector.getAttribute('aria-pressed') === 'true') await inspector.click();
  await inspector.click();
  await idle();
  assert.ok(await focusInScore());

  await page.keyboard.press('Control+Home');
  await idle();
  await expectOneEdit(() => page.keyboard.press('Control+x'), edit => {
    assert.equal(edit.type, 'eraseSelection');
    assert.equal(edit.selection.kind, 'range');
  });

  assert.deepEqual(errors, []);
  console.log('gp8-ui-slice1-editing: all checks passed');
} finally {
  await browser?.close().catch(() => {});
  stop(id);
}
