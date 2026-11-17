// VST3 instrument desktop acceptance (THE-218): a drum track can hold the synthetic test plug-in's drum class, "TabPlayer
// Test Drum", instead of an effect. Through the real interface over CDP it checks that
//  1. adding the test plug-in bundle puts both an effect and an instrument in the library, with their kind labels;
//  2. a drum track's plug-in select offers Instruments and Effects as two groups, a guitar track's only effects;
//  3. choosing the instrument is one undo step (undo, redo), choosing it again records nothing, the input trim is hidden,
//     the output trim shown, the kit note and the Rig's instrument banner show, and no "replaces Drive/Amp/Cabinet" note does;
//  4. the app plays with the instrument without a fault, and stop and seek leave the slot ready;
//  5. the test plug-in's crash mode gives the "built-in kit plays instead" notice while playback goes on;
//  6. saving, closing and reopening keeps the slot an instrument, and it plays;
//  7. an audio export with the instrument is not silent, differs from the built-in kit's export, and carries the drum's
//     own signal (the drum is a square wave whose amplitude encodes the key and velocity, see `drum_amplitude`);
//  8. screenshots of the sound panel, the open select, the Rig banner and the crashed notice, in English, Estonian and
//     German, are written under .analysis/desktop-smoke/ (git-ignored) for a person to look at.
//
// Build with scripts/build-desktop-test.ps1, then, from the checkout root:
//   node tests/desktop/parity-vst-instrument.mjs
// or:
//   node tests/desktop/parity-vst-instrument.mjs --build=<absolute build.json>
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sha256 } from './score-layout-fixture.mjs';
import { assertSilentOutput } from './silent-output.mjs';
import { assertScoreLayoutListener } from './parity-score-layouts.mjs';
import { assertStringCountBuild, assertStringCountIdentity, assertStringCountPortFree, stringCountEnvironment } from './parity-string-count.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const samePath = (a, b) => a.replaceAll('\\', '/').toLowerCase() === b.replaceAll('\\', '/').toLowerCase();
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const sleep = ms => new Promise(accept => setTimeout(accept, ms));
const hashFile = path => sha256(readFileSync(path));

const EFFECT_CLASS_ID = '7ABB1A7E57E5701C8E5700000000A001';
const DRUM_CLASS_ID = '7ABB1A7E57E5701C8E5700000000A002';
const LANGUAGES = ['en', 'et', 'de'];

/** Both channels of a 16- or 24-bit stereo PCM WAV as numbers in -1..1, with the sample rate. */
function channels(bytes) {
  assert.equal(bytes.subarray(0, 4).toString(), 'RIFF');
  const rate = bytes.readUInt32LE(24), bits = bytes.readUInt16LE(34), width = bits / 8;
  const frames = bytes.readUInt32LE(40) / (2 * width);
  const out = [new Float64Array(frames), new Float64Array(frames)];
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < 2; c++) {
      const at = 44 + (i * 2 + c) * width;
      out[c][i] = bits === 16 ? bytes.readInt16LE(at) / 32768 : bytes.readIntLE(at, 3) / 8388608;
    }
  }
  return { samples: out, rate };
}

/** RMS and absolute peak of both channels over the whole file. */
function stats({ samples: [left, right] }) {
  let sum = 0, peak = 0, n = 0;
  for (const channel of [left, right]) {
    for (const v of channel) {
      assert.ok(Number.isFinite(v), 'sample is finite');
      sum += v * v;
      peak = Math.max(peak, Math.abs(v));
      n++;
    }
  }
  return { rms: Math.sqrt(sum / n), peak };
}



export async function runVstInstrumentParity({ buildPath } = {}) {
  assert.equal(process.platform, 'win32');
  assert.ok(samePath(realpathSync(process.cwd()), realpathSync(repository)), 'Use authoritative worktree');

  let packet = null;
  let ownedDirectory = resolve(repository, '.analysis/desktop-smoke');
  if (buildPath) {
    packet = JSON.parse(readFileSync(buildPath));
    ownedDirectory = assertStringCountBuild(packet);
  } else {
    const defaultExe = resolve(ownedDirectory, 'tabplayer.exe');
    assert.ok(existsSync(defaultExe), `Built test executable not found at ${defaultExe}. Run scripts/build-desktop-test.ps1 first.`);
    packet = { executable: defaultExe };
  }

  const { execFileSync } = await import('node:child_process');
  let identity = null, browser = null, page = null, failure = null;

  const ps = (script, extra = {}) => execFileSync('powershell.exe', [
    '-NoProfile', '-Command', `$ErrorActionPreference='Stop';${script}`
  ], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20000,
    env: {
      ...stringCountEnvironment(process.env),
      STRING_COUNT_EXE: packet.executable,
      STRING_COUNT_PID: String(identity?.pid ?? ''),
      STRING_COUNT_START: identity?.startTicks ?? '',
      ...extra
    }
  }).trim();

  const portRows = () => JSON.parse(ps(
    '$rows=@(Get-NetTCPConnection -State Listen -LocalPort 9223 -ErrorAction SilentlyContinue|ForEach-Object {@{pid=[int]$_.OwningProcess}});ConvertTo-Json -InputObject $rows -Compress'
  ));
  assertStringCountPortFree(portRows());

  const runDirectory = mkdtempSync(resolve(ownedDirectory, 'vst-instrument-'));
  const names = ['session', 'profile', 'app-data', 'input', 'export', 'results', 'shots'];
  const paths = Object.fromEntries(names.map(name => [name, resolve(runDirectory, name)]));
  for (const p of Object.values(paths)) mkdirSync(p, { recursive: true });

  // Test plug-in bundle layout: TestPlugin.vst3/Contents/x86_64-win/TestPlugin.vst3
  const bundleInner = resolve(paths.input, 'TestPlugin.vst3', 'Contents', 'x86_64-win');
  mkdirSync(bundleInner, { recursive: true });
  const candidateDlls = [
    resolve(ownedDirectory, 'tabplayer_test_plugin.dll'),
    resolve(repository, 'src-tauri/target/test-plugin/release/tabplayer_test_plugin.dll'),
  ];
  const sourceDll = candidateDlls.find(p => existsSync(p));
  assert.ok(sourceDll, `tabplayer_test_plugin.dll not found in: ${candidateDlls.join(', ')}`);
  const bundleBinary = resolve(bundleInner, 'TestPlugin.vst3');
  copyFileSync(sourceDll, bundleBinary);

  const files = { fixture: resolve(paths.input, 'vst-instrument.gp'), saved: resolve(paths.input, 'vst-instrument-saved') };

  const result = {
    format: 'TabPlayerVstInstrumentReceipt',
    version: 1,
    status: 'running',
    buildSha256: packet?.executable ? hashFile(packet.executable) : '',
    runDirectory,
    assertions: [],
    observations: {},
    screenshots: [],
    pageErrors: [],
    fallbacks: [],
    startedAtUtc: new Date().toISOString()
  };
  const step = (name, evidence) => { result.assertions.push({ name, time: new Date().toISOString(), evidence }); console.log(`PASS ${name}`); };
  const healthy = () => {
    assert.deepEqual(result.pageErrors, [], 'Page error');
    assert.deepEqual(result.fallbacks, [], 'Tauri transport fallback');
  };

  const ownedScript = '$p=Get-Process -Id $env:STRING_COUNT_PID -ErrorAction SilentlyContinue;if($null -ne $p){if(-not [string]::Equals($p.Path,$env:STRING_COUNT_EXE,[StringComparison]::OrdinalIgnoreCase) -or $p.StartTime.ToUniversalTime().Ticks.ToString() -cne $env:STRING_COUNT_START){throw "Captured process identity changed"}};';
  const inspect = () => {
    const actual = JSON.parse(ps(`${ownedScript}if($null -eq $p){'null'}else{@{pid=$p.Id;path=$p.Path;startTicks=$p.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress}`));
    if (actual) assertStringCountIdentity(identity, actual);
    return actual;
  };
  const owned = () => { healthy(); assert.ok(identity && inspect(), 'Owned process exited'); };
  const poll = async (read, predicate, label, ms = 30000) => {
    const until = performance.now() + ms;
    let value;
    do {
      value = await read();
      if (predicate(value)) return value;
      await sleep(50);
    } while (performance.now() < until);
    throw new Error(`Timed out: ${label}: ${JSON.stringify(value)}`);
  };

  const listeners = () => JSON.parse(ps(
    `${ownedScript}if($null -eq $p){throw 'Owned process exited'};$rows=@();foreach($port in @(Get-NetTCPConnection -State Listen -LocalPort 9223 -ErrorAction SilentlyContinue)){$chain=@();$cursor=[int]$port.OwningProcess;for($depth=0;$depth -lt 20 -and $cursor -gt 0;$depth++){$child=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$cursor);if($null -eq $child){break};$chain+=@{pid=[int]$child.ProcessId;parent=[int]$child.ParentProcessId;commandLine=$child.CommandLine};if([int]$child.ProcessId -eq $p.Id){break};$cursor=[int]$child.ParentProcessId};$rows+=@{owner=[int]$port.OwningProcess;chain=$chain}};ConvertTo-Json -InputObject @($rows) -Depth 6 -Compress`
  ));

  let ui;
  const invoke = async (command, args = {}) => {
    owned();
    const value = await page.evaluate(([cmd, a]) => window.__TAURI_INTERNALS__.invoke(cmd, a), [command, args]);
    healthy();
    return value;
  };
  const workspace = () => invoke('workspace_snapshot');
  const documentId = async () => (await workspace()).active.documentId;
  const record = async () => invoke('project_snapshot', { documentId: await documentId() });
  const edits = async () => (await record()).snapshot.project.edits;
  const soundEdits = async () => (await edits()).filter(e => e.type === 'setTrackSound');
  const native = () => poll(() => invoke('audio_status'), value => {
    assert.equal(value.error, null);
    return value.ready && value.generation === value.desiredGeneration;
  }, 'paused current native preparation');
  const idle = async () => { owned(); await ui.waitForWorkspaceIdle(page); healthy(); };
  const button = async name => { owned(); await ui.clickWorkstationButton(page, name); await idle(); };

  const launch = async (suffix, environment) => {
    assertStringCountPortFree(portRows());
    const identityPath = resolve(paths.results, `launch-identity${suffix}.json`);
    const sessionDir = resolve(runDirectory, `session${suffix}`);
    const profileDir = resolve(runDirectory, `profile${suffix}`);
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(profileDir, { recursive: true });
    const env = {
      ...stringCountEnvironment(process.env),
      TABPLAYER_DESKTOP_TEST: '1',
      TABPLAYER_TEST_SESSION_DIR: sessionDir,
      TABPLAYER_TEST_APP_DATA_DIR: paths['app-data'],
      TABPLAYER_TEST_EXPORT_DIR: paths.export,
      TABPLAYER_TEST_PLUGIN_BUNDLE: bundleBinary,
      WEBVIEW2_USER_DATA_FOLDER: profileDir,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9223',
      STRING_COUNT_EXE: packet.executable,
      STRING_COUNT_IDENTITY: identityPath,
      ...environment
    };
    const script = '$ErrorActionPreference="Stop";$p=Start-Process -FilePath $env:STRING_COUNT_EXE -WindowStyle Hidden -PassThru;$path=if($p.Path){$p.Path}else{$env:STRING_COUNT_EXE};$text=@{pid=$p.Id;path=$path;startTicks=$p.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress;[IO.File]::WriteAllText($env:STRING_COUNT_IDENTITY,$text);$text';
    identity = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 20000, env }).trim());
    assertStringCountIdentity(identity, json(identityPath));
    assert.ok(samePath(identity.path, packet.executable));
    owned();
    const before = await poll(listeners, rows => rows.length > 0, 'owned CDP listener');
    assertScoreLayoutListener(identity, profileDir, before);
    const { chromium } = await import('playwright');
    browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
    owned();
    assertScoreLayoutListener(identity, profileDir, listeners());
    page = browser.contexts()[0].pages()[0];
    // Refuse to go on if the app would play audibly: the output is silent in a desktop-test build unless TABPLAYER_TEST_SILENT_OUTPUT=0.
    await assertSilentOutput(page);
    page.setDefaultTimeout(30000);
    page.on('pageerror', error => result.pageErrors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'warning' && message.text().startsWith('IPC custom protocol failed')) result.fallbacks.push(message.text());
    });
    await page.locator('.app-shell').waitFor();
    const library = page.getByRole('dialog', { name: 'Library', exact: true });
    if (await library.count()) {
      await library.getByRole('heading', { name: 'Welcome to TabPlayer', exact: true }).waitFor();
      await library.getByRole('button', { name: 'Close', exact: true }).click();
      await library.waitFor({ state: 'hidden' });
    }
    await idle();
  };

  const quit = async () => {
    if (browser) await browser.close().catch(() => {});
    browser = null;
    const ownedPid = identity?.pid;
    if (identity && inspect()) {
      ps(`${ownedScript}if($null -ne $p){Stop-Process -Id $p.Id;if(-not $p.WaitForExit(5000)){throw 'Owned process did not exit'}}`);
    }
    // Stop only the helpers this run's app left behind (children of its process id), never another TabPlayer's.
    if (ownedPid) {
      try {
        execFileSync('powershell.exe', ['-NoProfile', '-Command',
          `Get-CimInstance Win32_Process -Filter "Name='tabplayer-plugin-host.exe'" | Where-Object { [int]$_.ParentProcessId -eq ${Number(ownedPid)} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
        ], { windowsHide: true });
      } catch {}
    }
    identity = null;
  };

  const exportWav = async name => {
    await ui.closePluginDialog(page);
    await ui.clickWorkspaceCommand(page, 'Export score', { waitForIdle: false });
    const dialog = page.getByRole('dialog', { name: 'Export score' });
    await dialog.getByLabel('Export format').selectOption('wav');
    await dialog.getByLabel('File name', { exact: true }).fill(name);
    await dialog.getByRole('button', { name: 'Export', exact: true }).click();
    const targetFile = resolve(paths.export, `${name}.wav`);
    const until = Date.now() + 120000;
    while (Date.now() < until && !existsSync(targetFile)) {
      const failed = dialog.getByRole('alert');
      if (await failed.count()) throw new Error(await failed.innerText());
      await sleep(200);
    }
    assert.ok(existsSync(targetFile), `${name}.wav was written`);
    await dialog.waitFor({ state: 'detached', timeout: 30000 }).catch(() => {});
    await idle();
    await sleep(300);
    return readFileSync(targetFile);
  };

  // The track's plug-in slot (and its drum map) lives in the modal "Plug-in" dialog, which toolbar clicks through
  // `clickWorkstationButton` close first; every check of the plug-in slot opens it again. The kit note is in the sound dialog.
  const soundPanel = () => page.locator('.plugin-dialog').getByRole('region', { name: 'Plug-in' });
  const openSound = async () => {
    await ui.openPluginDialog(page);
  };
  const kitNote = 'The kit and its mix apply to the built-in kit, which plays only when the plug-in is unavailable.';
  /** The kit note is in the sound dialog (with a Plug-in… route back), not in the Plug-in dialog; this looks there and reopens the Plug-in dialog. */
  const checkKitNote = async () => {
    await ui.closePluginDialog(page);
    const panel = await ui.openSoundDialog(page);
    await panel.getByText(kitNote).waitFor();
    assert.equal(await page.locator('.sound-dialog .sound-plugin-slot').count(), 0, 'the sound dialog holds no plug-in slot');
    assert.equal(await page.locator('.sound-dialog').getByText(kitNote).getByRole('button', { name: 'Plug-in…', exact: true }).count(), 1, 'the kit note offers a Plug-in… route');
    await ui.closeSoundDialog(page);
    await openSound();
  };
  const pluginPicker = () => page.locator('.sound-plugin-slot select');
  const selectTrack = async name => {
    await ui.closePluginDialog(page);
    await page.locator('.view-switch button[role="radio"]').nth(0).click().catch(() => {});
    await ui.selectWorkspaceTrack(page, name);
    await idle();
    await openSound();
  };
  /** The same, with nothing in it that is translated: for the Estonian and German pages, whose button names differ. */
  const selectDrumsAnyLanguage = async () => {
    await ui.closePluginDialog(page);
    // The selected track survives a reload; the mixer strip is only there when the mixer is shown.
    const strip = page.locator('button.track-channel-select[aria-pressed="false"]:has-text("2. Drums")').first();
    if (await strip.isVisible()) { await strip.click(); await idle(); }
    const open = page.locator('.sound-plugin-open');
    if (!await open.isVisible()) {
      const tabs = page.locator('[role="tab"]');
      for (let i = 0; i < await tabs.count() && !await open.isVisible(); i++) await tabs.nth(i).click().catch(() => {});
    }
    await open.click();
    await page.locator('.plugin-dialog').waitFor({ state: 'visible' });
    await idle();
  };
  const GUITAR = 'Track 1: Guitar', DRUMS = 'Track 2: Drums';

  /** Screenshots are written under shots/ and listed in the receipt; they are looked at by a person, not asserted on. */
  const shoot = async (name, target) => {
    const file = resolve(paths.shots, `${name}.png`);
    await (target ?? page).screenshot({ path: file });
    result.screenshots.push(file);
    return file;
  };
  const setLanguage = async language => {
    await page.evaluate(value => window.localStorage.setItem('tabplayer.language', value), language);
    await page.reload();
    await page.locator('.app-shell').waitFor();
    await idle();
    await sleep(400);
  };
  const inRig = async () => { await ui.closePluginDialog(page); await page.locator('.view-switch button[role="radio"]').nth(1).click(); await idle(); };
  const inEditor = async () => { await page.locator('.view-switch button[role="radio"]').nth(0).click(); await idle(); };

  /** Plays until the drum's slot is ready and the app rendered audio; returns the audio status. */
  const playUntilSound = async (label, minFrames = 4096) => {
    await ui.clickWorkstationButton(page, 'Play', { waitForIdle: false });
    return poll(() => invoke('audio_status'), s => {
      assert.equal(s.error, null, `${label}: audio error`);
      return s.playing && s.renderedFrames > minFrames && s.outputPeak > 0.001;
    }, `${label}: playing with sound`);
  };
  const drumStatus = async (doc, trackId) => (await invoke('plugin_status', { documentId: doc })).find(s => s.trackId === trackId);

  try {
    ui = await import('./workstation-commands.mjs');
    const { exporter, model, Settings } = await import('@coderline/alphatab');

    // A guitar track with rests and a drum track with kick and snare on every beat, 8 bars (16 s at 120 bpm).
    {
      const score = new model.Score();
      const barCount = 8;
      for (let i = 0; i < barCount; i++) {
        const master = new model.MasterBar();
        master.timeSignatureNumerator = 4; master.timeSignatureDenominator = 4;
        score.addMasterBar(master);
      }
      const guitar = new model.Track(), guitarStaff = new model.Staff();
      guitar.name = 'Guitar'; guitar.shortName = 'Gtr';
      guitar.playbackInfo.program = 25;
      guitarStaff.stringTuning.tunings = [64, 59, 55, 50, 45, 40];
      guitar.addStaff(guitarStaff); score.addTrack(guitar);
      const drums = new model.Track(), drumStaff = new model.Staff();
      drums.name = 'Drums'; drums.shortName = 'Dr';
      Object.assign(drums.playbackInfo, { program: 0, primaryChannel: 9, secondaryChannel: 9 });
      const articulations = [[36, 'Kick Drum', 7], [38, 'Snare', 3]];
      drums.percussionArticulations = articulations.map(([key, name, line]) => new model.InstrumentArticulation(name, line, key, model.MusicFontSymbol.NoteheadBlack, model.MusicFontSymbol.NoteheadHalf, model.MusicFontSymbol.NoteheadWhole, model.MusicFontSymbol.None, model.TechniqueSymbolPlacement.Above, key));
      drumStaff.isPercussion = true; drumStaff.showTablature = false; drumStaff.showStandardNotation = true;
      drums.addStaff(drumStaff); score.addTrack(drums);
      let id = 0;
      for (let index = 0; index < barCount; index++) {
        const gbar = new model.Bar(); gbar.id = id++; gbar.clef = model.Clef.G2; guitarStaff.addBar(gbar);
        const gvoice = new model.Voice(); gvoice.id = id++; gbar.addVoice(gvoice);
        const rest = new model.Beat(); rest.id = id++; rest.duration = model.Duration.Whole; rest.isEmpty = false; gvoice.addBeat(rest);
        const dbar = new model.Bar(); dbar.id = id++; dbar.clef = model.Clef.Neutral; drumStaff.addBar(dbar);
        const dvoice = new model.Voice(); dvoice.id = id++; dbar.addVoice(dvoice);
        for (let beatIndex = 0; beatIndex < 4; beatIndex++) {
          const beat = new model.Beat(); beat.id = id++; beat.duration = model.Duration.Quarter; beat.isEmpty = false; dvoice.addBeat(beat);
          const note = new model.Note(); note.id = id++;
          note.percussionArticulation = beatIndex % 2 === 0 ? 0 : 1;
          beat.addNote(note);
        }
      }
      score.finish(new Settings());
      writeFileSync(files.fixture, new exporter.Gp7Exporter().export(score, new Settings()), { flag: 'wx' });
    }

    // =========================================================================
    // Launch 1: library, selects, choose, undo/redo, play, stop, seek, crash, save
    // =========================================================================
    await launch('', { TABPLAYER_TEST_OPEN: files.fixture, TABPLAYER_TEST_SAVE: files.saved, TABPLAYER_TEST_PLUGIN_VIEW_NO_EDIT: '1' });
    await button('Open');
    await page.locator('[aria-label="Music notation"] svg').first().waitFor();
    await native();

    // The built-in kit's export is the baseline for the instrument's.
    const builtinBytes = await exportWav('builtin');
    const builtinWav = channels(builtinBytes);
    const builtinStats = stats(builtinWav);
    assert.ok(builtinStats.rms > 0.001, 'The built-in kit export is not silent');

    await selectTrack(GUITAR);

    // 1. Add the bundle: both classes reach the library, with their kinds.
    await page.getByRole('button', { name: 'Add plug-in…', exact: true }).click();
    await idle();
    const manage = soundPanel().locator('details.plugin-library-manage');
    await poll(async () => manage.count(), n => n === 1, 'library list appears');
    if (!await manage.evaluate(node => node.open)) await manage.locator('summary').click();
    const libraryRows = await poll(async () => (await manage.locator('li').allInnerTexts()).map(t => t.replace(/\s+/g, ' ').trim()), rows => rows.length >= 2, 'both classes listed');
    assert.ok(libraryRows.some(row => /TabPlayer Test Gain/.test(row) && /\beffect\b/.test(row)), `effect entry with its kind: ${libraryRows}`);
    assert.ok(libraryRows.some(row => /TabPlayer Test Drum/.test(row) && /\binstrument\b/.test(row)), `instrument entry with its kind: ${libraryRows}`);
    result.observations.libraryRows = libraryRows;
    step('1. The library lists the effect and the instrument with their kind labels', { libraryRows });

    // 2. The select on a guitar track lists effects only; on a drum track two groups.
    const optionNames = async () => pluginPicker().locator('option').allInnerTexts();
    const guitarOptions = await optionNames();
    assert.equal(await pluginPicker().locator('optgroup').count(), 0, 'A pitched track has no groups');
    assert.ok(guitarOptions.some(t => t.includes('TabPlayer Test Gain')), `the effect is offered on a guitar track: ${guitarOptions}`);
    assert.ok(!guitarOptions.some(t => t.includes('TabPlayer Test Drum')), `the instrument is not offered on a guitar track: ${guitarOptions}`);
    await selectTrack(DRUMS);
    const groups = await pluginPicker().locator('optgroup').evaluateAll(nodes => nodes.map(node => ({ label: node.label, options: [...node.querySelectorAll('option')].map(o => o.textContent) })));
    assert.deepEqual(groups.map(g => g.label), ['Instruments', 'Effects'], `groups on a drum track: ${JSON.stringify(groups)}`);
    assert.ok(groups[0].options.some(t => t.includes('TabPlayer Test Drum')) && !groups[0].options.some(t => t.includes('Test Gain')));
    assert.ok(groups[1].options.some(t => t.includes('TabPlayer Test Gain')) && !groups[1].options.some(t => t.includes('Test Drum')));
    step('2. Drum track select has Instruments and Effects groups; the guitar track only effects', { guitarOptions, groups });

    // Baseline live level of the built-in kit on the drum track.
    const builtinLive = await playUntilSound('built-in kit');
    await button('Stop');
    result.observations.builtinLivePeak = builtinLive.outputPeak;

    // 3. Choose the instrument.
    await openSound();
    const doc = await documentId();
    const editsBefore = (await edits()).length;
    const soundEditsBefore = (await soundEdits()).length;
    await pluginPicker().selectOption(DRUM_CLASS_ID);
    await idle();
    const chosen = await poll(async () => (await soundEdits()).at(-1)?.sound?.plugin, p => p?.classId === DRUM_CLASS_ID, 'instrument chosen on the drum track');
    assert.equal(chosen.kind, 'instrument', 'The slot holds an instrument');
    assert.equal(chosen.active, true);
    const drumTrackId = (await soundEdits()).at(-1).trackId;
    assert.equal((await edits()).length, editsBefore + 1, 'Choosing is one edit');
    assert.equal((await soundEdits()).length, soundEditsBefore + 1);

    await button('Undo');
    assert.equal((await edits()).length, editsBefore, 'Undo takes back the choice in one step');
    await openSound();
    assert.equal(await pluginPicker().inputValue(), '', 'After undo the select is back to the built-in kit');
    await button('Redo');
    assert.equal((await edits()).length, editsBefore + 1, 'Redo restores it');
    await openSound();
    await poll(() => pluginPicker().inputValue(), v => v === DRUM_CLASS_ID, 'select shows the instrument after redo');
    await pluginPicker().selectOption(DRUM_CLASS_ID);
    await idle();
    await sleep(300);
    assert.equal((await edits()).length, editsBefore + 1, 'Choosing the current instrument again records nothing');

    assert.equal(await soundPanel().getByLabel('Input trim', { exact: true }).count(), 0, 'The input trim is hidden for an instrument');
    await soundPanel().getByLabel('Output trim', { exact: true }).waitFor();
    await checkKitNote();
    // Layout pictures only (PLUGIN_DIALOG_SHOTS_ONLY=1): nothing here starts playback, so the test plug-in is never heard.
    if (process.env.PLUGIN_DIALOG_SHOTS_ONLY) {
      await ui.closePluginDialog(page);
      await selectTrack(GUITAR);
      await pluginPicker().selectOption(EFFECT_CLASS_ID);
      await idle();
      await ui.closePluginDialog(page);
      // The Information row's arrows choose the previous (guitar) or next (drums) track in every language.
      const openAny = async which => {
        await ui.closePluginDialog(page);
        const arrow = page.locator('.track-settings .track-actions button').nth(which === 'guitar' ? 0 : 1);
        if (await arrow.getAttribute('aria-disabled') !== 'true') { await arrow.click(); await idle(); }
        await page.locator('.sound-plugin-open').click();
        await page.locator('.plugin-dialog').waitFor({ state: 'visible' });
        await idle();
        await sleep(300);
        return page.locator('.plugin-dialog');
      };
      const cdp = await page.context().newCDPSession(page);
      for (const language of LANGUAGES) {
        if (language !== 'en') await setLanguage(language);
        let dialog = await openAny('guitar');
        await shoot(`plugin-dialog-guitar-effect-${language}`, dialog);
        await dialog.locator('details.plugin-library-manage').evaluate(node => { node.open = true; });
        await shoot(`plugin-dialog-guitar-library-${language}`, dialog);
        dialog = await openAny('drums');
        await shoot(`plugin-dialog-drums-instrument-${language}`, dialog);
        if (language === 'en') result.observations.pluginDialogGeometry = await dialog.locator('.plugin-panel, .plugin-panel > *, .plugin-slot-controls > *').evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return [node.tagName.toLowerCase() + '.' + node.className, Math.round(r.top), Math.round(r.height)]; }));
        await dialog.locator('details.plugin-library-manage').evaluate(node => { node.open = true; });
        await shoot(`plugin-dialog-drums-library-${language}`, dialog);
        await dialog.locator('details.plugin-library-manage').evaluate(node => { node.open = false; });
        // The drum map's Keys open at 1366x768: the dialog must stay inside the window and scroll inside itself.
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
        await sleep(300);
        await dialog.locator('details.drum-map-keys > summary').click();
        await dialog.locator('details.drum-map-keys [role="radio"]').nth(1).click(); // All sounds: a long list
        await sleep(300);
        const box = await dialog.boundingBox(), body = await dialog.locator('.tp-dialog-body').evaluate(node => ({ client: node.clientHeight, scroll: node.scrollHeight }));
        assert.ok(box.y >= 0 && box.y + box.height <= 768, `${language}: the dialog stays inside the 768px window: ${JSON.stringify(box)}`);
        assert.ok(body.scroll > body.client, `${language}: with Keys open the dialog body scrolls inside the dialog: ${JSON.stringify(body)}`);
        await shoot(`plugin-dialog-drums-keys-1366x768-${language}`);
        await cdp.send('Emulation.clearDeviceMetricsOverride');
        await ui.closePluginDialog(page);
      }
      await setLanguage('en');
      healthy();
      return result;
    }
    await ui.closePluginDialog(page);
    await inRig();
    const banners = await page.locator('.rig-replaced-banner').allInnerTexts();
    // The Rig keeps the kit note in the drum kit's "?" popover (and in the select's accessible description).
    await page.getByRole('button', { name: 'Which hits differ', exact: true }).click();
    const rigNotes = await page.locator('.rig-note').allInnerTexts();
    await page.keyboard.press('Escape');
    result.observations.rigBanners = banners;
    result.observations.rigNotes = rigNotes;
    assert.ok(banners.some(t => /This plug-in plays this track/.test(t)), `the instrument banner shows in the Rig: ${JSON.stringify({ banners, rigNotes })}`);
    assert.ok(rigNotes.some(t => t.includes('The kit and its mix apply')), `the kit note shows in the Rig: ${JSON.stringify(rigNotes)}`);
    assert.ok(!banners.some(t => /Drive, Amp and Cabinet/.test(t)), 'No "replaces Drive, Amp and Cabinet" note for an instrument');
    assert.equal(await page.getByText(/Drive, Amp and Cabinet are replaced/).count(), 0);
    await inEditor();
    await openSound();
    step('3. Choosing the instrument: one undo step, redo restores, same choice records nothing; trim, kit note and Rig banner', { editsBefore, banners, rigNotes });

    // 4. Play with the instrument; stop and seek leave the slot ready.
    const live = await playUntilSound('instrument');
    assert.ok(live.pluginDelayFrames > 0, `plug-in delay frames reported: ${live.pluginDelayFrames}`);
    // The meter keeps the last playback's peak until new audio arrives, so the first reading proves nothing. The drum's own
    // level (about 0.2, see step 7) is above anything the built-in kit reaches on this score (0.13 in its export).
    const drumLevel = await poll(() => invoke('audio_status'), s => s.playing && s.outputPeak > 0.19, 'the live peak reaches the drum level');
    assert.ok(builtinLive.outputPeak < 0.15, `The built-in kit stays under the drum's level: ${builtinLive.outputPeak}`);
    const playingStatus = await drumStatus(doc, drumTrackId);
    assert.equal(playingStatus?.status, 'ready', 'The instrument is ready while playing');
    await sleep(1500);
    const later = await invoke('audio_status');
    assert.ok(later.playing && !later.error && later.renderedFrames > live.renderedFrames, 'playback goes on without a fault');
    assert.equal((await drumStatus(doc, drumTrackId)).status, 'ready');
    await button('Stop');
    assert.equal((await drumStatus(doc, drumTrackId)).status, 'ready', 'Ready after stop');
    await ui.revealPlaybackControls(page);
    await page.getByLabel('Seek measure', { exact: true }).fill('5');
    await button('Seek');
    await ui.hidePlaybackControls(page);
    await poll(() => invoke('audio_status'), s => Math.abs(s.tick - 4 * 3840) < 1, 'seeked to bar 5');
    assert.equal((await drumStatus(doc, drumTrackId)).status, 'ready', 'Ready after seek');
    const afterSeek = await playUntilSound('after seek');
    assert.equal((await drumStatus(doc, drumTrackId)).status, 'ready');
    await button('Stop');
    await ui.revealPlaybackControls(page);
    await page.getByLabel('Seek measure', { exact: true }).fill('1');
    await button('Seek');
    await ui.hidePlaybackControls(page);
    step('4. Playing with the instrument: ready, no fault, stop and seek leave it ready', {
      builtinLivePeak: builtinLive.outputPeak,
      firstLivePeakReading: live.outputPeak,
      livePeakWithInstrument: drumLevel.outputPeak,
      pluginDelayFrames: live.pluginDelayFrames,
      renderedFramesFirst: live.renderedFrames,
      renderedFramesLater: later.renderedFrames,
      afterSeekPeak: afterSeek.outputPeak
    });

    // Screenshots of the working state, in each language.
    // 5. Crash mode (parameter 2 = mode, 1/8 = Crash). A restarted helper is back in Normal mode, so it is set again until
    // the retries are used up and the status stays `crashed`.
    await ui.clickWorkstationButton(page, 'Play', { waitForIdle: false });
    await poll(() => invoke('audio_status'), s => s.playing && s.renderedFrames > 2048, 'playing before the crash');
    const editsBeforeCrash = (await edits()).length;
    await poll(async () => {
      const s = await drumStatus(doc, drumTrackId);
      if (s?.status === 'ready') {
        await page.evaluate(([d, t]) => window.__TAURI_INTERNALS__.invoke('plugin_test_set_parameter', { documentId: d, trackId: t, id: 2, value: 0.125 }), [doc, drumTrackId]).catch(() => {});
      }
      return s?.status;
    }, s => s === 'crashed', 'the instrument crashed');
    const crashNotice = page.locator('.plugin-status-notice, .plugin-notice-item').first();
    await crashNotice.waitFor();
    const crashText = (await crashNotice.innerText()).replace(/\s+/g, ' ');
    assert.match(crashText, /crashed, so the built-in kit plays instead\. The document is unchanged\./);
    const crashPlay = await invoke('audio_status');
    const crashAfter = await poll(() => invoke('audio_status'), s => s.playing && !s.error && s.renderedFrames > crashPlay.renderedFrames + 2048 && s.outputPeak > 0.001, 'playback continues with the built-in kit');
    assert.equal((await edits()).length, editsBeforeCrash, 'The document is unchanged by the crash');
    result.observations.crashText = crashText;
    await shoot('crashed-notice-page-en');
    await openSound();
    await page.locator('.sound-plugin-slot').scrollIntoViewIfNeeded();
    await shoot('crashed-notice-en', page.locator('.sound-plugin-slot'));
    for (const language of ['et', 'de']) {
      await setLanguage(language);
      await selectDrumsAnyLanguage();
      const text = (await page.locator('.plugin-status-notice, .plugin-notice-item').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
      result.observations[`crashText-${language}`] = text;
      await shoot(`crashed-notice-${language}`, page.locator('.sound-plugin-slot'));
    }
    await setLanguage('en');
    await ui.clickWorkstationButton(page, 'Stop', { waitForIdle: false });
    await idle();
    await selectTrack(DRUMS);
    await soundPanel().getByRole('button', { name: 'Try again', exact: true }).click();
    await idle();
    await poll(async () => (await drumStatus(doc, drumTrackId))?.status, s => s === 'ready', 'Try again recovers the instrument');
    step('5. Crash mode: the notice says the built-in kit plays instead, playback continues, the document is unchanged, Try again recovers', { crashText, peakAfter: crashAfter.outputPeak });

    // Save.
    await button('Save');
    const savedPath = `${files.saved}.tabplayer`;
    assert.ok(existsSync(savedPath), 'The document was saved');
    healthy();
    await quit();

    // =========================================================================
    // Launch 2: reopen, play, export, screenshots
    // =========================================================================
    assertStringCountPortFree(portRows());
    await launch('-reopen', { TABPLAYER_TEST_OPEN: savedPath, TABPLAYER_TEST_SAVE: files.saved, TABPLAYER_TEST_PLUGIN_VIEW_NO_EDIT: '1' });
    await button('Open');
    await page.locator('[aria-label="Music notation"] svg').first().waitFor();
    await native();
    await selectTrack(DRUMS);
    const doc2 = await documentId();
    const reopened = await poll(async () => (await invoke('plugin_status', { documentId: doc2 })).find(s => s.trackId === drumTrackId), s => s?.status === 'ready', 'the reopened instrument is ready');
    assert.equal(await pluginPicker().inputValue(), DRUM_CLASS_ID, 'The reopened slot is the instrument');
    const reopenedSlot = (await soundEdits()).at(-1)?.sound?.plugin;
    assert.equal(reopenedSlot?.kind, 'instrument', 'The reopened slot is still an instrument');
    await checkKitNote();
    assert.equal(await soundPanel().getByLabel('Input trim', { exact: true }).count(), 0);
    const reopenedPlay = await playUntilSound('reopened instrument');
    assert.equal((await drumStatus(doc2, drumTrackId)).status, 'ready');
    await button('Stop');
    step('6. Save, close and reopen: the slot is still an instrument, ready, and plays', { status: reopened.status, peak: reopenedPlay.outputPeak, pluginDelayFrames: reopenedPlay.pluginDelayFrames });

    // 7. Export with the instrument.
    const instrumentBytes = await exportWav('instrument');
    const instrumentWav = channels(instrumentBytes);
    const instrumentStats = stats(instrumentWav);
    assert.ok(instrumentStats.rms > 0.001, `The instrument export is not silent (rms ${instrumentStats.rms})`);
    assert.notEqual(hashFile(resolve(paths.export, 'instrument.wav')), hashFile(resolve(paths.export, 'builtin.wav')), 'The instrument export differs from the built-in kit export');
    assert.equal(instrumentWav.samples[0].length, builtinWav.samples[0].length, 'Same frame count as the built-in export');
    // The drum's own signal: a square wave that starts on the exact first frame, and starts again on the exact frame of beat 2
    // (0.5 s at 120 bpm). The export's master stage scales the plug-in's output, so the key and velocity cannot be decoded
    // exactly; the amplitude of a snare (key 38) against a kick (key 36) is still (38 * 128 + v) / (36 * 128 + v), 1.04 to 1.08.
    const first = instrumentWav.samples[0][0];
    const beat2 = Math.round(instrumentWav.rate * 0.5);
    const beforeBeat2 = instrumentWav.samples[0][beat2 - 1];
    const atBeat2 = instrumentWav.samples[0][beat2];
    const snareToKick = atBeat2 / first;
    result.observations.firstSample = first;
    result.observations.beat2 = { frame: beat2, before: beforeBeat2, at: atBeat2, snareToKick };
    assert.ok(first > 0.05, `The first hit starts on the first frame: sample ${first}`);
    assert.ok(snareToKick > 1.03 && snareToKick < 1.09, `The snare on beat 2 is the drum's key 38 against the kick's 36: ratio ${snareToKick}`);
    // The drum holds a note until its NoteOff and a quarter note ends where the next one starts, so there is no silence between
    // the hits; the observation records the level of the last frames before beat 2.
    const gap = Array.from({ length: 64 }, (_, k) => instrumentWav.samples[0][beat2 - 1 - k]);
    result.observations.gapBeforeBeat2 = { min: Math.min(...gap.map(Math.abs)), max: Math.max(...gap.map(Math.abs)) };
    step('7. Export with the instrument: not silent, differs from the built-in kit, carries the drum signal', {
      frames: instrumentWav.samples[0].length,
      builtinFrames: builtinWav.samples[0].length,
      rms: instrumentStats.rms, peak: instrumentStats.peak,
      builtinRms: builtinStats.rms, builtinPeak: builtinStats.peak,
      firstSample: first, beat2: result.observations.beat2, gapBeforeBeat2: result.observations.gapBeforeBeat2
    });

    // 8. Screenshots: the sound panel, the open select with its groups, the Rig banner, per language.
    for (const language of LANGUAGES) {
      if (language !== 'en') await setLanguage(language);
      await selectDrumsAnyLanguage();
      await page.locator('.sound-plugin-slot').scrollIntoViewIfNeeded();
      await shoot(`sound-panel-${language}`);
      await shoot(`sound-panel-region-${language}`, page.locator('.sound-plugin-slot'));
      // A native select's popup is not in the page, so its list is shown by making the select a list box for the picture.
      await pluginPicker().evaluate(select => { select.size = select.options.length + select.querySelectorAll('optgroup').length; });
      await shoot(`select-open-${language}`, page.locator('.sound-plugin-slot'));
      await pluginPicker().evaluate(select => { select.removeAttribute('size'); });
      await inRig();
      await shoot(`rig-banner-${language}`);
      await page.getByRole('button', { name: 'Which hits differ', exact: true }).click();
      await shoot(`rig-kit-note-${language}`);
      await page.keyboard.press('Escape');
      await inEditor();
    }
    await setLanguage('en');
    healthy();
  } catch (error) {
    failure = error;
    result.error = { message: String(error), stack: error?.stack };
    if (page) {
      try { await page.screenshot({ path: resolve(paths.results, 'failure.png') }); } catch {}
    }
  } finally {
    try { await quit(); } catch (err) { failure ??= err; }
    result.status = failure ? 'failed' : 'passed';
    result.finishedAtUtc = new Date().toISOString();
    writeFileSync(resolve(paths.results, 'result.json'), JSON.stringify(result, null, 2), { flag: 'w' });
  }

  if (failure) throw failure;
  return result;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const buildArg = process.argv.slice(2).find(a => a.startsWith('--build='));
  const outcome = await runVstInstrumentParity({ buildPath: buildArg ? buildArg.slice(8) : undefined });
  console.log(JSON.stringify({ status: outcome.status, runDirectory: outcome.runDirectory, assertions: outcome.assertions.map(a => a.name), screenshots: outcome.screenshots }, null, 2));
}
