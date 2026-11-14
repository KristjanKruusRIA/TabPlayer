import { closeWelcomeLibrary, waitForWorkspaceIdle, revealPlaybackControls, selectWorkspaceTrack, clickWorkstationButton } from './workstation-commands.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { exporter, model, Settings } from '@coderline/alphatab';
import { directory, launch, connect, stop } from './harness.mjs';

// Fretlight guitar lights (THE-77, U19). The desktop-test build offers a fake Fretlight when TABPLAYER_FRETLIGHT_TEST=1 and
// keeps every report written to it, which `fretlight_test_log` returns. So this proves the path from the score and the panel to
// the bytes that would be written, and the consent, rate and clearing rules; it does not touch hidapi, a real USB stack or any
// guitar, and says nothing about whether a real Fretlight lights the right LED.
// The expected bytes are worked out by hand from the documented layout (LED k of a packet = bit 7 - k mod 8 of byte 5 - k / 8,
// k = (fret - first fret) * 6 + string - 1, string 1 the high E), not computed by the code under test.
const settings = new Settings();
function fixture() {
  const score = new model.Score(); score.title = 'Fretlight fixture'; score.artist = 'TabPlayer desktop verification';
  for (let bar = 0; bar < 2; bar++) { const master = new model.MasterBar(); master.timeSignatureNumerator = 4; master.timeSignatureDenominator = 4; score.addMasterBar(master); }
  score.masterBars[0].tempoAutomations = [model.Automation.buildTempoAutomation(false, 0, 100, 2)];
  const tracks = [
    { name: 'Guitar', program: 25, channel: 0, tuning: [64, 59, 55, 50, 45, 40], bars: [
      [[[1, 7]], [[1, 5], [4, 9]], [[6, 12]], [[2, 21], [3, 22]]], [[[1, 8]], [[1, 10]], [[2, 6]], [[3, 11]]]] },
    { name: 'Bass', program: 33, channel: 2, tuning: [43, 38, 33, 28], bars: [
      [[[1, 3]], [[2, 5]], [[3, 4]], [[4, 2]]], [[[1, 5]], [[2, 7]], [[3, 2]], [[4, 4]]]] },
  ];
  let id = 0;
  for (const [trackIndex, definition] of tracks.entries()) {
    const track = new model.Track(); track.name = definition.name; track.shortName = definition.name;
    Object.assign(track.playbackInfo, { program: definition.program, primaryChannel: definition.channel, secondaryChannel: definition.channel + 1 });
    const staff = new model.Staff(); staff.stringTuning.tunings = [...definition.tuning]; staff.showTablature = true; staff.showStandardNotation = true;
    track.addStaff(staff); score.addTrack(track);
    for (const [barIndex, beats] of definition.bars.entries()) {
      const bar = new model.Bar(); bar.id = trackIndex * 2 + barIndex; bar.clef = trackIndex ? model.Clef.F4 : model.Clef.G2; staff.addBar(bar);
      const voice = new model.Voice(); voice.id = bar.id; bar.addVoice(voice);
      for (const placed of beats) {
        const beat = new model.Beat(); beat.id = id++; beat.duration = model.Duration.Quarter; beat.isEmpty = false; voice.addBeat(beat);
        for (const [string, fret] of placed) { const note = new model.Note(); note.string = string; note.fret = fret; beat.addNote(note); }
      }
    }
  }
  score.finish(settings);
  const path = resolve(directory, 'fretlight-fixture.gp'); mkdirSync(directory, { recursive: true });
  writeFileSync(path, new exporter.Gp7Exporter().export(score, settings));
  return path;
}

/** One frame as the three 8-byte reports written for it: report id 0, six LED bytes, the packet number. */
const report = (id, bytes = [0, 0, 0, 0, 0, 0]) => [0, ...bytes, id];
const frameOf = (first = [0, 0, 0, 0, 0, 0], second = [0, 0, 0, 0, 0, 0], third = [0, 0, 0, 0, 0, 0]) => [report(1, first), report(2, second), report(3, third)];
// Each lit LED is a cell of the source post's tables (Exploring Binary, "My Fretlight Guitar as a Binary Clock", "The Fretlight Interface"): f7s6 is Packet ID 1 byte 0 bit 0, f5s6 byte 1 bit 4, f9s3 Packet ID 2 byte 4 bit 7, f12s1 byte 2 bit 7, f21s5 Packet ID 3 byte 1 bit 5.
// Worked by hand (device string 1 is the high E; the score's string 1 is the low E, so device string = 7 - score string).
const BEAT = [
  frameOf([0x01, 0, 0, 0, 0, 0]),                                                // string 6 fret 7: k = 47, byte 0 bit 0
  frameOf([0, 0x10, 0, 0, 0, 0], [0, 0, 0, 0, 0x80, 0]),                         // string 6 fret 5: k = 35, byte 1 bit 4; string 3 fret 9: k = 8, byte 4 bit 7
  frameOf(undefined, [0, 0, 0x80, 0, 0, 0]),                                     // string 1 fret 12: k = 24, byte 2 bit 7
  frameOf(undefined, undefined, [0, 0x20, 0, 0, 0, 0]),                          // string 5 fret 21: k = 34, byte 1 bit 5 (string 4 fret 22 does not exist)
];
const OFF = frameOf();

const path = fixture();
const id = launch({ TABPLAYER_FRETLIGHT_TEST: '1', TABPLAYER_TEST_OPEN: path }); let browser;
try {
  browser = await connect(); const page = browser.contexts()[0].pages()[0];
  await waitForWorkspaceIdle(page); await closeWelcomeLibrary(page); await waitForWorkspaceIdle(page);
  await clickWorkstationButton(page, 'Open', { waitForIdle: false }); await waitForWorkspaceIdle(page);
  await page.locator('[aria-label="Music notation"] svg text').first().waitFor({ timeout: 60000 });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const invoke = (command, args) => page.evaluate(([command, args]) => window.__TAURI_INTERNALS__.invoke(command, args), [command, args]);
  const log = async (clear = false) => invoke('fretlight_test_log', { clear });
  const until = async (read, predicate, label, timeout = 10000) => { const deadline = Date.now() + timeout; let last; while (Date.now() < deadline) { last = await read(); if (predicate(last)) return last; await page.waitForTimeout(40); } throw new Error(`${label} did not happen in time: ${JSON.stringify(last)}`); };
  const lastFrame = async () => { const { reports } = await log(); return reports.slice(-3); };
  const untilFrame = (expected, label) => until(lastFrame, frame => JSON.stringify(frame) === JSON.stringify(expected), label);

  // Consent: nothing has been listed, opened or written, and the status says so.
  assert.deepEqual(await log(), { reports: [], lists: 0, opens: 0 });
  assert.equal((await invoke('fretlight_status')).state, 'disconnected');
  await page.locator('details.command-menu > summary', { hasText: /^View$/ }).click();
  const panel = page.locator('details.fretlight-panel'); await panel.waitFor();
  // Selecting in the score closes the View menu, so each use of the section opens the menu and the section again if need be.
  const reveal = async () => { if (!await panel.isVisible()) await page.locator('details.command-menu > summary', { hasText: /^View$/ }).click(); if (!await panel.evaluate(element => element.open)) await panel.locator('summary').click(); };
  await reveal();
  await reveal(); await panel.getByText(/not tested with a real Fretlight/).waitFor();
  await reveal(); await panel.getByText('Not connected. Nothing is looked for until you press the button.').waitFor();
  assert.equal(await panel.getAttribute('data-menu-keep'), '', 'pressing in the section keeps the View menu open');
  // Choosing what the lights show, selecting beats and moving through the score send nothing either.
  await reveal(); await panel.getByRole('combobox', { name: 'Lights show' }).selectOption('beat');
  const notation = page.locator('[aria-label="Music notation"] svg text');
  const closeMenu = async () => { const open = page.locator('details.command-menu[open] > summary', { hasText: /^View$/ }); if (await open.count()) await open.click(); };
  const pick = async fret => { await closeMenu(); await notation.filter({ hasText: new RegExp(`^${fret}$`) }).first().click(); await waitForWorkspaceIdle(page); };
  await pick('5'); await pick('7');
  assert.deepEqual(await log(), { reports: [], lists: 0, opens: 0 }, 'nothing is listed, opened or written before Connect');

  // Connect: the guitar is looked for now, and the selected beat is lit with three reports.
  await reveal(); await panel.getByRole('button', { name: 'Connect Fretlight' }).click();
  try { await reveal(); await panel.getByText('Connected to Fretlight (test). The lights follow the score.').waitFor({ timeout: 10000 }); }
  catch (error) { console.log('PANEL:', await panel.innerText(), 'STATUS:', JSON.stringify(await invoke('fretlight_status')), 'LOG:', JSON.stringify(await log())); throw error; }
  const connected = await log(); assert.equal(connected.lists, 1); assert.equal(connected.opens, 1);
  await untilFrame(BEAT[0], 'the first beat is lit');
  assert.equal((await log()).reports.length % 3, 0, 'frames are always written whole');

  // The lights follow the selected beat, with the instrument view closed or open alike.
  const dock = await page.locator('.live-instrument-view').count();
  for (const [fret, expected] of [['5', BEAT[1]], ['12', BEAT[2]], ['21', BEAT[3]], ['7', BEAT[0]]]) { await pick(fret); await untilFrame(expected, `beat with fret ${fret}`); }
  await pick('21'); await untilFrame(BEAT[3], 'the last beat');
  await reveal(); await panel.getByText('One note is above fret 21 and is not lit.').waitFor();
  // Selecting what is already selected writes nothing more.
  const settled = (await log()).reports.length; await pick('21'); await page.waitForTimeout(400);
  assert.equal((await log()).reports.length, settled, 'an unchanged lit set is not written again');

  // The whole selected bar.
  await reveal(); await panel.getByRole('combobox', { name: 'Lights show' }).selectOption('bar');
  await pick('7');
  await untilFrame(frameOf([0x01, 0x10, 0, 0, 0, 0], [0, 0, 0x80, 0, 0x80, 0], [0, 0x20, 0, 0, 0, 0]), 'the whole bar is lit');
  await reveal(); await panel.getByRole('combobox', { name: 'Lights show' }).selectOption('beat');

  // Playing: the lights change with the music and the writing rate stays bounded.
  await pick('7'); await untilFrame(BEAT[0], 'back on the first beat');
  await reveal(); await panel.getByRole('combobox', { name: 'Lights show' }).selectOption('playing');
  await untilFrame(OFF, 'nothing is playing, so nothing is lit');
  const before = (await log(true)).reports.length; assert.equal(before > 0, true);
  await revealPlaybackControls(page);
  const play = page.getByRole('button', { name: /^Play$/ }).first(); await play.click();
  const began = Date.now(); let last = { at: began, sent: (await invoke('fretlight_status')).sent }; const windows = [];
  // Sampled every 250 ms while the first bar plays (quarter notes at 100 bpm, 0.6 s each): the writes in each window stay under the limit.
  while (Date.now() - began < 3600) {
    await page.waitForTimeout(250);
    const now = Date.now(), sent = (await invoke('fretlight_status')).sent;
    windows.push({ seconds: (now - last.at) / 1000, frames: sent - last.sent }); last = { at: now, sent };
  }
  await page.getByRole('button', { name: /^(Pause|Stop)$/ }).first().click();
  const elapsed = (Date.now() - began) / 1000; const played = await log();
  const frames = played.reports.length / 3;
  assert.equal(played.reports.length % 3, 0, 'frames are always written whole');
  for (const window of windows) assert.ok(window.frames <= 25 * window.seconds + 1, `at most 25 frames a second in any window: ${JSON.stringify(window)}`);
  // Every beat of the bar that played was lit, in order: the four beats of the first bar are frames in the written reports (the notes ending in between show as all-off frames).
  const written = []; for (let i = 0; i < played.reports.length; i += 3) written.push(JSON.stringify(played.reports.slice(i, i + 3)));
  let at = -1; for (const [number, expected] of BEAT.entries()) { at = written.indexOf(JSON.stringify(expected), at + 1); assert.ok(at >= 0, `beat ${number + 1} was lit during playback, in order: ${written.length} frames`); }
  const status = await invoke('fretlight_status'); assert.equal(status.state, 'connected');

  // A track that is not a six-string guitar lights nothing, and the section says so.
  await reveal(); await panel.getByRole('combobox', { name: 'Lights show' }).selectOption('beat');
  await selectWorkspaceTrack(page, 'Track 2: Bass');
  await reveal(); await panel.getByText('The selected track is not a six-string guitar track, so no lights are sent.').waitFor();
  await untilFrame(OFF, 'the bass track lights nothing');
  await selectWorkspaceTrack(page, 'Track 1: Guitar');
  await reveal(); await panel.getByText('The selected track is not a six-string guitar track, so no lights are sent.').waitFor({ state: 'detached' });

  // The page is untrusted: a frame of the wrong size or for another session is refused, and a flood is coalesced to the newest at a bounded rate.
  await pick('5'); await untilFrame(BEAT[1], 'lit again');
  const { session } = await invoke('fretlight_status');
  await assert.rejects(() => invoke('fretlight_frame', { session, leds: [true, false] }), /132/);
  await assert.rejects(() => invoke('fretlight_frame', { session, leds: Array(133).fill(false) }), /132/);
  await assert.rejects(() => invoke('fretlight_frame', { session, leds: Array(132).fill(1) }), /invalid type|boolean/i);
  await assert.rejects(() => invoke('fretlight_frame', { session: session + 5, leds: Array(132).fill(false) }), /not_connected/);
  const sentBefore = (await invoke('fretlight_status')).sent, floodBegan = Date.now();
  await page.evaluate(async session => { for (let n = 0; n < 3000; n++) { const leds = Array(132).fill(false); leds[n % 132] = true; await window.__TAURI_INTERNALS__.invoke('fretlight_frame', { session, leds }); } }, session);
  // The last frame sent lit index 2999 % 132 = 95: string 5, fret 7, which is k = 46: byte 0, bit 1.
  await untilFrame(frameOf([0x02, 0, 0, 0, 0, 0]), 'the newest frame of the flood');
  const flood = await invoke('fretlight_status'), floodSeconds = (Date.now() - floodBegan) / 1000;
  assert.ok(flood.sent - sentBefore <= 25 * floodSeconds + 3, `a flood of 3000 frames wrote ${flood.sent - sentBefore} in ${floodSeconds.toFixed(1)} s`);
  assert.ok(flood.coalesced >= 2000, `most of the flood was coalesced: ${flood.coalesced}`);
  // The flood bypassed the page's own session, so the next change of selection is what shows it is back on the score.
  await pick('12'); await untilFrame(BEAT[2], 'the selected beat again');

  // Disconnect: all lights off first.
  const beforeDisconnect = (await log()).reports.length;
  await reveal(); await panel.getByRole('button', { name: 'Disconnect Fretlight' }).click();
  await reveal(); await panel.getByText('Not connected. Nothing is looked for until you press the button.').waitFor();
  const closed = await log();
  assert.deepEqual(closed.reports.slice(-3), OFF, 'the all-off frame is written on Disconnect');
  assert.equal(closed.reports.length % 3, 0);
  assert.ok(closed.reports.length >= beforeDisconnect);
  assert.equal((await invoke('fretlight_status')).state, 'disconnected');
  await pick('7'); await page.waitForTimeout(400);
  assert.equal((await log()).reports.length, closed.reports.length, 'nothing is written after Disconnect');

  assert.deepEqual(await page.getByRole('alert').allTextContents(), []); assert.deepEqual(errors, []);
  mkdirSync(resolve('.analysis/parity'), { recursive: true }); await page.screenshot({ path: resolve('.analysis/parity/native-fretlight.png') });
  const result = { floodFrames: flood.sent - sentBefore, floodSeconds: Number(floodSeconds.toFixed(1)), frames, elapsedSeconds: Number(elapsed.toFixed(1)), maxFramesPerSecond: Number((frames / elapsed).toFixed(1)), viewMountedAtStart: dock > 0 };
  writeFileSync(join(directory, 'fretlight-result.json'), JSON.stringify(result, null, 2));
  console.log('Fretlight passed:', JSON.stringify(result));
} finally { try { if (browser) await browser.close(); } finally { stop(id); } }
