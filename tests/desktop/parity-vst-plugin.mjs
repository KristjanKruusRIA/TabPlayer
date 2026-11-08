// VST3 plug-in desktop acceptance: a user adds a VST3 plug-in to their library and chooses it on a track;
// audio playback runs with the plug-in active and non-zero delay compensation; opening and closing the plug-in's
// editor window adds exactly one undo step; undo and redo revert and restore the plug-in state; saving and reopening
// restores the plug-in and state; a plug-in crash triggers a fallback to the built-in tone and shows a crashed notice
// without mutating the document, and "Try again" recovers; hang mode makes the Rust side report `hung` through
// plugin_status, kills the helper, keeps audio_status and plugin_status answering quickly and keeps the built-in tone
// playing; clearing consent gives a needsConsent notice and "Allow" recovers; removing the plug-in from the library gives
// a missing notice without mutating the document; and offline WAV export with the plug-in at a gain of 0.5 differs from
// the built-in export by exactly that gain, with the same frame count and the same alignment.
//
// The test plug-in at its default settings is an exact pass-through (its export is byte-identical to the built-in one),
// so an export proof is only meaningful after a parameter that changes the sound has been set. Step 9 sets the gain.
// The editor sessions run with TABPLAYER_TEST_PLUGIN_VIEW_NO_EDIT=1, so a session that changes nothing records no edit.
//
// Build with scripts/build-desktop-test.ps1 (or tests/desktop/string-count-build.mjs), then:
//   node tests/desktop/parity-vst-plugin.mjs
// or:
//   node tests/desktop/parity-vst-plugin.mjs --run --build=<absolute build.json>
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sha256 } from './score-layout-fixture.mjs';
import { assertScoreLayoutListener } from './parity-score-layouts.mjs';
import { assertStringCountBuild, assertStringCountIdentity, assertStringCountPortFree, stringCountEnvironment } from './parity-string-count.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const samePath = (a, b) => a.replaceAll('\\', '/').toLowerCase() === b.replaceAll('\\', '/').toLowerCase();
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const sleep = ms => new Promise(accept => setTimeout(accept, ms));
const hashFile = path => sha256(readFileSync(path));

const TEST_CLASS_ID = '7ABB1A7E57E5701C8E5700000000A001';

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

/** Computes RMS energy and absolute peak over the middle duration of audio. */
function stats({ samples: [left, right], rate }, from = 0.3, to = 1.4) {
  let sum = 0, peak = 0, n = 0;
  const a = Math.round(rate * from), b = Math.round(rate * to);
  for (let i = a; i < b; i++) {
    for (const v of [left[i], right[i]]) {
      assert.ok(Number.isFinite(v), 'sample is finite');
      sum += v * v;
      peak = Math.max(peak, Math.abs(v));
      n++;
    }
  }
  return { rms: Math.sqrt(sum / n), peak };
}

export async function runVstPluginParity({ buildPath } = {}) {
  assert.equal(process.platform, 'win32');
  assert.ok(samePath(realpathSync(process.cwd()), realpathSync(repository)), 'Use authoritative worktree');

  let packet = null;
  let ownedDirectory = resolve(repository, '.analysis/desktop-smoke');
  if (buildPath) {
    const packetBytes = readFileSync(buildPath);
    packet = JSON.parse(packetBytes);
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

  const runDirectory = mkdtempSync(resolve(ownedDirectory, 'vst-plugin-'));
  const names = ['session', 'profile', 'app-data', 'input', 'export', 'results'];
  const paths = Object.fromEntries(names.map(name => [name, resolve(runDirectory, name)]));
  for (const p of Object.values(paths)) mkdirSync(p, { recursive: true });

  // Prepare test plugin bundle layout: TestGain.vst3/Contents/x86_64-win/TestGain.vst3
  const bundleDir = resolve(paths.input, 'TestGain.vst3');
  const bundleInner = resolve(bundleDir, 'Contents', 'x86_64-win');
  mkdirSync(bundleInner, { recursive: true });

  const candidateDlls = [
    resolve(ownedDirectory, 'tabplayer_test_plugin.dll'),
    resolve(repository, 'src-tauri/target/release/tabplayer_test_plugin.dll'),
    resolve(repository, '.analysis/desktop-smoke/tabplayer_test_plugin.dll'),
  ];
  const sourceDll = candidateDlls.find(p => existsSync(p));
  assert.ok(sourceDll, `tabplayer_test_plugin.dll not found in candidate locations: ${candidateDlls.join(', ')}`);
  const bundleBinary = resolve(bundleInner, 'TestGain.vst3');
  copyFileSync(sourceDll, bundleBinary);

  const files = {
    fixture: resolve(paths.input, 'vst-test.gp'),
    saved: resolve(paths.input, 'vst-saved'),
  };

  const result = {
    format: 'TabPlayerVstPluginReceipt',
    version: 1,
    status: 'running',
    buildPath: buildPath ?? 'direct',
    buildSha256: packet?.executable ? hashFile(packet.executable) : '',
    build: packet,
    runDirectory,
    bundleBinary,
    assertions: [],
    pageErrors: [],
    fallbacks: [],
    startedAtUtc: new Date().toISOString()
  };

  const step = (name, evidence) => result.assertions.push({ name, time: new Date().toISOString(), evidence });
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
  const poll = async (read, predicate, label) => {
    const until = performance.now() + 30000;
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

  /** The helper processes that are children of the owned app. Other TabPlayer instances' helpers are never touched. */
  const helperRows = () => JSON.parse(ps(
    `${ownedScript}if($null -eq $p){'[]'}else{$rows=@(Get-CimInstance Win32_Process -Filter "Name='tabplayer-plugin-host.exe'"|Where-Object {[int]$_.ParentProcessId -eq $p.Id}|ForEach-Object {@{pid=[int]$_.ProcessId}});ConvertTo-Json -InputObject $rows -Compress}`
  ));
  /** How many of the owned app's helpers own a visible top-level window (the vendor editor). */
  const helperWindows = () => Number(ps(
    `${ownedScript}$n=0;if($null -ne $p){foreach($c in @(Get-CimInstance Win32_Process -Filter "Name='tabplayer-plugin-host.exe'"|Where-Object {[int]$_.ParentProcessId -eq $p.Id})){$h=Get-Process -Id $c.ProcessId -ErrorAction SilentlyContinue;if($null -ne $h -and $h.MainWindowHandle -ne 0){$n++}}};$n`
  ));

  let ui;
  const invoke = async (command, args = {}) => {
    owned();
    const value = await page.evaluate(([cmd, a]) => window.__TAURI_INTERNALS__.invoke(cmd, a), [command, args]);
    healthy();
    return value;
  };

  const workspace = () => invoke('workspace_snapshot');
  const record = async () => invoke('project_snapshot', { documentId: (await workspace()).active.documentId });
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
    identity = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20000,
      env
    }).trim());

    console.log(`[launch${suffix}] identity:`, identity);
    console.log(`[launch${suffix}] json(identityPath):`, json(identityPath));
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
    page.setDefaultTimeout(30000);
    page.on('pageerror', error => result.pageErrors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'warning' && message.text().startsWith('IPC custom protocol failed')) {
        result.fallbacks.push(message.text());
      }
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
    if (browser) await browser.close();
    browser = null;
    const ownedPid = identity?.pid;
    if (identity && inspect()) {
      ps(`${ownedScript}if($null -ne $p){Stop-Process -Id $p.Id;if(-not $p.WaitForExit(5000)){throw 'Owned process did not exit'}}`);
    }
    // Stop only the helpers this run's app left behind (children of its process id), never another TabPlayer's.
    if (ownedPid) {
      try {
        execFileSync('powershell.exe', [
          '-NoProfile', '-Command',
          `Get-CimInstance Win32_Process -Filter "Name='tabplayer-plugin-host.exe'" | Where-Object { [int]$_.ParentProcessId -eq ${Number(ownedPid)} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
        ], { windowsHide: true });
      } catch {}
    }
    identity = null;
  };

  const exportWav = async name => {
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

  const openSound = async () => {
    await ui.revealLeftTask(page, 'Sound');
    const panel = page.getByRole('region', { name: 'Track sound' });
    const slotDetails = panel.locator('details.sound-plugin-slot');
    if (!await slotDetails.evaluate(node => node.open)) {
      await slotDetails.locator('summary').click();
    }
  };

  const pluginPicker = () => page.locator('.sound-plugin-slot select');
  const lastSoundEdit = async () => (await record()).snapshot.project.edits.filter(e => e.type === 'setTrackSound').at(-1);

  /** Opens the editor, proves a helper-owned window exists, sets the gain through the test hook, closes it and waits for the one edit. */
  const changeGainThroughEditor = async (documentId, trackId, gain) => {
    const before = (await record()).snapshot.project.edits.length;
    await page.getByRole('button', { name: 'Edit plug-in', exact: true }).click();
    await poll(async () => helperWindows(), n => n >= 1, 'helper-owned editor window exists');
    await invoke('plugin_test_set_parameter', { documentId, trackId, id: 0, value: gain });
    await invoke('plugin_editor_close', { documentId, trackId });
    await idle();
    await poll(async () => (await record()).snapshot.project.edits.length, n => n === before + 1, 'the gain change recorded exactly one edit');
    await poll(async () => helperWindows(), n => n === 0, 'editor window closed');
  };

  try {
    ui = await import('./workstation-commands.mjs');
    const { exporter, model, Settings } = await import('@coderline/alphatab');

    // Synthesize score: 2 bars of whole notes on E2 / E3
    {
      const score = new model.Score(), track = new model.Track(), staff = new model.Staff();
      track.name = 'Guitar';
      track.playbackInfo.program = 25;
      staff.stringTuning.tunings = [64, 59, 55, 50, 45, 40];
      track.addStaff(staff);
      score.addTrack(track);
      for (let index = 0; index < 2; index++) {
        score.addMasterBar(new model.MasterBar());
        const bar = new model.Bar(), voice = new model.Voice(), beat = new model.Beat();
        beat.duration = model.Duration.Whole;
        if (index === 0) {
          for (const [string, fret] of [[1, 0], [3, 2]]) {
            const note = new model.Note();
            note.string = string;
            note.fret = fret;
            beat.addNote(note);
          }
        }
        voice.addBeat(beat);
        bar.addVoice(voice);
        staff.addBar(bar);
      }
      score.finish(new Settings());
      writeFileSync(files.fixture, new exporter.Gp7Exporter().export(score, new Settings()), { flag: 'wx' });
    }

    // =========================================================================
    // Launch 1: Add plug-in, choose on track, play, open/close editor, undo/redo, save
    // =========================================================================
    await launch('', { TABPLAYER_TEST_OPEN: files.fixture, TABPLAYER_TEST_SAVE: files.saved, TABPLAYER_TEST_PLUGIN_VIEW_NO_EDIT: '1' });
    await button('Open');
    await page.locator('[aria-label="Music notation"] svg').first().waitFor();
    await native();

    // Baseline built-in export before adding plug-in
    const builtinWavBytes = await exportWav('builtin');
    const builtinWav = channels(builtinWavBytes);
    const builtinStats = stats(builtinWav);
    assert.ok(builtinStats.rms > 0.001, 'Baseline built-in export is not silent');

    await openSound();

    // 1. Add the plug-in and choose it on a track
    const addBtn = page.getByRole('button', { name: 'Add plug-in…', exact: true });
    await addBtn.click();
    await idle();

    // Wait for the plug-in to be added to the dropdown options
    await poll(async () => {
      const texts = await pluginPicker().locator('option').allTextContents();
      return texts.some(t => t.includes('TabPlayer Test Gain') || t.includes('TestGain'));
    }, has => has, 'plug-in added to library dropdown');

    // Choose it on the track
    await pluginPicker().selectOption('');
    await idle();
    await pluginPicker().selectOption(TEST_CLASS_ID);
    await idle();

    const chosenSlot = await poll(async () => (await lastSoundEdit())?.sound?.plugin, p => p?.classId === TEST_CLASS_ID, 'plug-in chosen on track');
    assert.equal(chosenSlot.classId, TEST_CLASS_ID);
    assert.equal(chosenSlot.active, true);

    // Verify Drive, Amp and Cabinet replaced banner in rig
    await page.locator('.view-switch button[role="radio"]').nth(1).click();
    await idle();
    const replacedBanner = page.locator('.rig-replaced-banner');
    await poll(async () => await replacedBanner.count(), c => c >= 1, 'replaced banner rendered in Sound view');
    assert.ok(await replacedBanner.count() >= 1, 'Replaced banner rendered in Rig');
    await page.locator('.view-switch button[role="radio"]').nth(0).click();
    await idle();
    await openSound();
    step('1. Add plug-in and choose on track', { classId: TEST_CLASS_ID });

    // 2. Play, and check that the status is ready and pluginDelayFrames > 0
    await button('Play');
    const playingState = await poll(() => invoke('audio_status'), s => s.playing && s.renderedFrames > 4096 && s.outputPeak > 0.001 && !s.error && s.pluginDelayFrames > 0, 'playing with plugin delay frames');
    assert.ok(playingState.pluginDelayFrames > 0, `Expected pluginDelayFrames > 0, got ${playingState.pluginDelayFrames}`);
    const docId1 = (await workspace()).active.documentId;
    const initialStatuses = await invoke('plugin_status', { documentId: docId1 });
    assert.equal(initialStatuses[0]?.status, 'ready', 'Initial playback status is ready');
    await button('Stop');
    step('2. Play with ready status and pluginDelayFrames > 0', { pluginDelayFrames: playingState.pluginDelayFrames, peak: playingState.outputPeak });

    // 3. Editor sessions. A session that changes nothing records nothing; one that changes the gain records one undo step.
    const editsBeforeEditor = (await record()).snapshot.project.edits.length;
    const trackId1 = (await lastSoundEdit()).trackId;
    const editBtn = page.getByRole('button', { name: 'Edit plug-in', exact: true });
    await editBtn.click();
    const editorWindows = await poll(async () => helperWindows(), n => n >= 1, 'helper-owned editor window exists');
    await invoke('plugin_editor_close', { documentId: docId1, trackId: trackId1 });
    await idle();
    await sleep(500);
    assert.equal((await record()).snapshot.project.edits.length, editsBeforeEditor, 'Open then close without a change records no edit');
    await poll(async () => helperWindows(), n => n === 0, 'editor window closed');

    await changeGainThroughEditor(docId1, trackId1, 0.5);
    assert.equal((await record()).snapshot.project.edits.length, editsBeforeEditor + 1);
    step('3. Open and close editor adds exactly one undo step', { editsBefore: editsBeforeEditor, editsAfter: editsBeforeEditor + 1, noChangeSessionAddedEdits: 0, editorWindows });

    // 4. Undo and redo, then save and reopen
    await button('Undo');
    assert.equal((await record()).snapshot.project.edits.length, editsBeforeEditor, 'Undo reverts editor edit');
    await button('Redo');
    assert.equal((await record()).snapshot.project.edits.length, editsBeforeEditor + 1, 'Redo reapplies editor edit');

    await button('Save');
    const savedPath = `${files.saved}.tabplayer`;
    assert.ok(existsSync(savedPath), 'Saved document file exists');
    const savedProject = JSON.parse(readFileSync(savedPath));
    assert.ok(Object.keys(savedProject.assets).length > 0, 'Saved project contains plugin state asset');

    healthy();
    await quit();

    // Reopen saved document
    assertStringCountPortFree(portRows());
    await launch('-reopen', { TABPLAYER_TEST_OPEN: savedPath, TABPLAYER_TEST_SAVE: files.saved });
    await button('Open');
    await page.locator('[aria-label="Music notation"] svg').first().waitFor();
    await native();
    await openSound();

    const docId2 = (await workspace()).active.documentId;
    const reopenedStatuses = await invoke('plugin_status', { documentId: docId2 });
    assert.equal(reopenedStatuses[0]?.status, 'ready', 'Reopened document status is ready');
    step('4. Undo, redo, save and reopen verified', { savedPath });

    // 5. Use plugin_test_set_parameter to set crash mode, check crashed notice, built-in tone, unchanged doc, then "Try again" gives ready
    const editsBeforeCrash = (await record()).snapshot.project.edits.length;
    const trackId2 = reopenedStatuses[0]?.trackId ?? (await lastSoundEdit()).trackId;
    console.log('BEFORE STEP 5: docId2=', docId2, 'trackId2=', trackId2, 'reopenedStatuses=', reopenedStatuses);
    console.log('BEFORE STEP 5: audio_status=', await invoke('audio_status'));

    // Start playback first so audio is actively streaming through the plug-in
    await ui.clickWorkstationButton(page, 'Play', { waitForIdle: false });
    await poll(() => invoke('audio_status'), s => s.playing && s.renderedFrames > 2048, 'playing before crash');

    // Trigger crash via parameter 2 (Mode = 1.0 / 8.0 = 0.125 = TestMode::Crash).
    // TabPlayer automatically restarts crashed helpers up to MAX_CRASH_RETRIES (3) times per session,
    // so re-trigger crash if relaunched until retries are exhausted and status latches 'crashed'.
    await poll(async () => {
      const s = await invoke('plugin_status', { documentId: docId2 });
      if (s[0]?.status === 'ready') {
        await page.evaluate(([doc, trk]) => window.__TAURI_INTERNALS__.invoke('plugin_test_set_parameter', {
          documentId: doc,
          trackId: trk,
          id: 2,
          value: 0.125
        }), [docId2, trackId2]).catch(() => {});
      }
      return s[0]?.status;
    }, st => st === 'crashed', 'plugin status became crashed');

    // Verify crashed notice in UI
    const crashNotice = page.locator('.plugin-status-notice, .plugin-notice-item').first();
    await crashNotice.waitFor();
    assert.match(await crashNotice.innerText(), /crashed.*built-in tone plays instead.*document is unchanged/i);

    // Verify output peak stays above zero (built-in fallback tone plays)
    const crashAudio = await poll(() => invoke('audio_status'), s => s.playing && s.outputPeak > 0.001, 'playing with built-in fallback tone');
    assert.ok(crashAudio.outputPeak > 0.001, `Built-in fallback peak is ${crashAudio.outputPeak}`);

    // Verify document edits remain unchanged
    assert.equal((await record()).snapshot.project.edits.length, editsBeforeCrash, 'Document is unchanged after crash');
    await button('Stop');

    // Click "Try again" to recover
    const retryBtn = page.getByRole('button', { name: 'Try again', exact: true }).first();
    await retryBtn.click();
    await idle();
    await poll(async () => {
      const s = await invoke('plugin_status', { documentId: docId2 });
      return s[0]?.status;
    }, st => st === 'ready', 'status recovered to ready after retry');
    step('5. Crash mode shows crashed notice, built-in tone, unchanged doc, and retry gives ready', { peak: crashAudio.outputPeak });

    // 6. Hang mode, through the Rust side: plugin_status turns `hung`, the helper is killed, both commands keep answering
    // quickly while it happens, and the built-in tone keeps playing.
    await ui.clickWorkstationButton(page, 'Play', { waitForIdle: false });
    const beforeHang = await poll(() => invoke('audio_status'), s => s.playing && s.renderedFrames > 4096, 'playing before hang');
    const helpersBeforeHang = (await helperRows()).map(row => row.pid);
    assert.ok(helpersBeforeHang.length >= 1, 'a helper runs for the plug-in before the hang');

    // Parameter 2 is Mode; 2.0 / 8.0 = 0.25 selects TestMode::Hang
    await invoke('plugin_test_set_parameter', { documentId: docId2, trackId: trackId2, id: 2, value: 0.25 });

    const hangStart = performance.now();
    let slowestCoreAnswerMs = 0;
    const hungStatuses = await poll(async () => {
      const began = performance.now();
      const statuses = await invoke('plugin_status', { documentId: docId2 });
      await invoke('audio_status');
      slowestCoreAnswerMs = Math.max(slowestCoreAnswerMs, (performance.now() - began) / 2);
      return statuses;
    }, statuses => statuses[0]?.status === 'hung', 'plugin status became hung');
    const hungAfterMs = performance.now() - hangStart;
    assert.equal(hungStatuses[0].status, 'hung');
    assert.ok(hungAfterMs < 10000, `The Rust side reported hung after ${hungAfterMs.toFixed(0)} ms`);
    assert.ok(slowestCoreAnswerMs < 200, `plugin_status and audio_status answered in ${slowestCoreAnswerMs.toFixed(1)} ms while the plug-in hung`);

    const killed = await poll(async () => (await helperRows()).map(row => row.pid), pids => !helpersBeforeHang.some(pid => pids.includes(pid)), 'the hung helper was killed');
    const afterHang = await poll(() => invoke('audio_status'), s => s.playing && s.renderedFrames > beforeHang.renderedFrames + 2048 && s.outputPeak > 0.001 && !s.error, 'built-in tone keeps playing after the hang');
    assert.match(await page.locator('.plugin-status-notice, .plugin-notice-item').first().innerText(), /stopped responding.*built-in tone plays instead/i);
    await button('Stop');
    step('6. Hang mode: Rust reports hung, helper killed, commands stay quick, built-in tone keeps playing', {
      hungAfterMs,
      slowestCoreAnswerMs,
      helperPidsBefore: helpersBeforeHang,
      helperPidsAfter: killed,
      renderedFramesBefore: beforeHang.renderedFrames,
      renderedFramesAfter: afterHang.renderedFrames,
      outputPeakAfter: afterHang.outputPeak
    });

    // 7. Clear the consent file and reopen, check the needsConsent notice, allow, and check ready
    healthy();
    await quit();

    const consentFile = resolve(paths['app-data'], 'plugins', 'consent.json');
    if (existsSync(consentFile)) {
      writeFileSync(consentFile, '{}');
    }

    assertStringCountPortFree(portRows());
    await launch('-consent', { TABPLAYER_TEST_OPEN: savedPath, TABPLAYER_TEST_SAVE: files.saved });
    await button('Open');
    await page.locator('[aria-label="Music notation"] svg').first().waitFor();
    await native();
    await openSound();

    const docId3 = (await workspace()).active.documentId;
    await poll(async () => {
      const s = await invoke('plugin_status', { documentId: docId3 });
      return s[0]?.status;
    }, st => st === 'needsConsent', 'status is needsConsent');

    const consentNotice = page.locator('.plugin-status-notice, .plugin-notice-item').first();
    await consentNotice.waitFor();
    assert.match(await consentNotice.innerText(), /needs your permission.*built-in tone plays instead/i);

    const allowBtn = page.getByRole('button', { name: 'Allow plug-ins', exact: true }).first();
    await allowBtn.click();
    await idle();
    await poll(async () => {
      const s = await invoke('plugin_status', { documentId: docId3 });
      return s[0]?.status;
    }, st => st === 'ready', 'status is ready after granting consent');
    step('7. Clear consent file gives needsConsent notice and allow gives ready', {});

    // 8. Remove the library entry and reopen, and check the missing notice with an unchanged document
    const editsBeforeRemove = (await record()).snapshot.project.edits.length;
    const removeBtn = page.locator('.sound-plugin-slot').getByRole('button', { name: 'Remove from library', exact: true }).first();
    await removeBtn.click();
    await idle();

    healthy();
    await quit();

    assertStringCountPortFree(portRows());
    await launch('-missing', { TABPLAYER_TEST_OPEN: savedPath, TABPLAYER_TEST_SAVE: files.saved });
    await button('Open');
    await page.locator('[aria-label="Music notation"] svg').first().waitFor();
    await native();
    await openSound();

    const docId4 = (await workspace()).active.documentId;
    await poll(async () => {
      const s = await invoke('plugin_status', { documentId: docId4 });
      return s[0]?.status;
    }, st => st === 'missing', 'status is missing');

    const missingNotice = page.locator('.plugin-status-notice, .plugin-notice-item').first();
    await missingNotice.waitFor();
    assert.match(await missingNotice.innerText(), /is not installed.*built-in tone plays instead.*document is unchanged/i);
    assert.equal((await record()).snapshot.project.edits.length, editsBeforeRemove, 'Document remains unchanged when plug-in is missing');
    step('8. Remove library entry and reopen gives missing notice and unchanged document', {});

    // 9. Export WAV, and check that it is not silent and has the same frame count as a built-in-only export
    // Re-add plug-in to library and select to restore ready status
    const reAddBtn = page.locator('.sound-plugin-slot').getByRole('button', { name: 'Add plug-in…', exact: true }).first();
    await reAddBtn.click();
    await idle();

    await poll(async () => {
      const texts = await pluginPicker().locator('option').allTextContents();
      return texts.some(t => t.includes('TabPlayer Test Gain') || t.includes('TestGain'));
    }, has => has, 'plug-in re-added to library dropdown');

    await pluginPicker().selectOption('');
    await idle();
    await pluginPicker().selectOption(TEST_CLASS_ID);
    await idle();

    await poll(async () => {
      const s = await invoke('plugin_status', { documentId: docId4 });
      return s[0]?.status;
    }, st => st === 'ready', 'status is ready after re-adding to library');

    // The test plug-in at its defaults is an exact pass-through, so set a gain that changes the sound before exporting.
    const exportTrackId = (await invoke('plugin_status', { documentId: docId4 }))[0].trackId;
    const gain = 0.5;
    await changeGainThroughEditor(docId4, exportTrackId, gain);

    const pluginExportBytes = await exportWav('with-plugin');
    const pluginWav = channels(pluginExportBytes);
    const pluginStats = stats(pluginWav);
    assert.ok(pluginStats.rms > 0.001, 'Plug-in export is not silent');
    assert.equal(pluginWav.samples[0].length, builtinWav.samples[0].length, `Plug-in export frame count (${pluginWav.samples[0].length}) matches built-in export (${builtinWav.samples[0].length})`);
    assert.notEqual(hashFile(resolve(paths.export, 'with-plugin.wav')), hashFile(resolve(paths.export, 'builtin.wav')), 'The plug-in export differs from the built-in export');
    const rmsRatio = pluginStats.rms / builtinStats.rms;
    assert.ok(Math.abs(rmsRatio - gain) < 0.05, `Export level is the built-in level times the gain: ratio ${rmsRatio.toFixed(4)}, expected ${gain}`);
    // Sample by sample over the stats window: the plug-in export is the built-in export times the gain, which also proves the
    // plug-in's delay was trimmed to the frame (a shifted copy would not match).
    let worstError = 0;
    const from = Math.round(builtinWav.rate * 0.3), to = Math.round(builtinWav.rate * 1.4);
    for (let c = 0; c < 2; c++) {
      for (let i = from; i < to; i++) {
        worstError = Math.max(worstError, Math.abs(pluginWav.samples[c][i] - gain * builtinWav.samples[c][i]));
      }
    }
    assert.ok(worstError < 0.01, `Plug-in export equals gain times the built-in export; worst sample error ${worstError}`);
    step('9. Export WAV with gain 0.5 differs from the built-in export by that gain, with the same frame count and alignment', {
      frames: pluginWav.samples[0].length,
      builtinFrames: builtinWav.samples[0].length,
      gain,
      rms: pluginStats.rms,
      peak: pluginStats.peak,
      builtinRms: builtinStats.rms,
      builtinPeak: builtinStats.peak,
      rmsRatio,
      worstSampleError: worstError
    });

    healthy();
  } catch (error) {
    failure = error;
    result.error = { message: String(error), stack: error?.stack };
    if (page) {
      try {
        await page.screenshot({ path: resolve(paths.results, 'failure.png') });
      } catch {}
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
  const buildPath = buildArg ? buildArg.slice(8) : undefined;
  const outcome = await runVstPluginParity({ buildPath });
  console.log(JSON.stringify({
    status: outcome.status,
    runDirectory: outcome.runDirectory,
    assertions: outcome.assertions.map(a => a.name)
  }, null, 2));
}
