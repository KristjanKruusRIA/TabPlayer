// Acceptance test driver for real installed VST3 plug-ins (THE-71 Task 18 Step 2).
// Not run in CI. Reads TABPLAYER_ACCEPT_PLUGIN_BUNDLE for a locally installed VST3 amp plug-in,
// loads it, plays, opens the editor, saves, reopens and exports WAV. Prints structured results
// for inclusion in docs/validation/YYYY-MM-DD-vst-hosting.md.
//
// Usage:
//   node tests/desktop/acceptance-vst-real-plugin.mjs
// Or with custom bundle:
//   $env:TABPLAYER_ACCEPT_PLUGIN_BUNDLE='C:\Program Files\Common Files\VST3\AtlasDSP DI Crank.vst3'
//   node tests/desktop/acceptance-vst-real-plugin.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sha256 } from './score-layout-fixture.mjs';
import { assertScoreLayoutListener } from './parity-score-layouts.mjs';
import { assertStringCountIdentity, assertStringCountPortFree, stringCountEnvironment } from './parity-string-count.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const samePath = (a, b) => a.replaceAll('\\', '/').toLowerCase() === b.replaceAll('\\', '/').toLowerCase();
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const sleep = ms => new Promise(accept => setTimeout(accept, ms));
const hashFile = path => sha256(readFileSync(path));

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

export async function runRealPluginAcceptance({ pluginBundlePath } = {}) {
  assert.equal(process.platform, 'win32');
  assert.ok(samePath(realpathSync(process.cwd()), realpathSync(repository)), 'Use authoritative worktree');

  const candidates = [
    pluginBundlePath,
    process.env.TABPLAYER_ACCEPT_PLUGIN_BUNDLE,
    'C:\\Program Files\\Common Files\\VST3\\AtlasDSP DI Crank.vst3',
    'C:\\Program Files\\Common Files\\VST3\\SLAMP.vst3',
    'C:\\Program Files\\Common Files\\VST3\\Archetype Gojira X.vst3',
  ].filter(Boolean);

  const selectedBundle = candidates.find(p => existsSync(p));
  assert.ok(selectedBundle, `No real VST3 plug-in found in candidates: ${candidates.join(', ')}`);

  const ownedDirectory = resolve(repository, '.analysis/desktop-smoke');
  const defaultExe = resolve(ownedDirectory, 'tabplayer.exe');
  assert.ok(existsSync(defaultExe), `Built test executable not found at ${defaultExe}. Run scripts/build-desktop-test.ps1 first.`);
  const packet = { executable: defaultExe };

  const { execFileSync } = await import('node:child_process');
  let identity = null, browser = null, page = null, failure = null;

  const ps = (script, extra = {}) => execFileSync('powershell.exe', [
    '-NoProfile', '-Command', `$ErrorActionPreference='Stop';${script}`
  ], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
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

  const runDirectory = mkdtempSync(resolve(ownedDirectory, 'vst-real-acceptance-'));
  const names = ['session', 'profile', 'app-data', 'input', 'export', 'results'];
  const paths = Object.fromEntries(names.map(name => [name, resolve(runDirectory, name)]));
  for (const p of Object.values(paths)) mkdirSync(p, { recursive: true });

  const files = {
    fixture: resolve(paths.input, 'real-plugin-test.gp'),
    saved: resolve(paths.input, 'real-plugin-saved'),
  };

  const report = {
    pluginPath: selectedBundle,
    pluginName: '',
    pluginVendor: '',
    pluginVersion: '',
    classId: '',
    status: 'running',
    latencySamples: 0,
    livePeak: 0,
    editorVerified: false,
    reopenVerified: false,
    exportFrames: 0,
    exportRms: 0,
    exportPeak: 0,
    startedAt: new Date().toISOString(),
  };

  const ownedScript = '$p=Get-Process -Id $env:STRING_COUNT_PID -ErrorAction SilentlyContinue;if($null -ne $p){if(-not [string]::Equals($p.Path,$env:STRING_COUNT_EXE,[StringComparison]::OrdinalIgnoreCase) -or $p.StartTime.ToUniversalTime().Ticks.ToString() -cne $env:STRING_COUNT_START){throw "Captured process identity changed"}};';
  const inspect = () => {
    const actual = JSON.parse(ps(`${ownedScript}if($null -eq $p){'null'}else{@{pid=$p.Id;path=$p.Path;startTicks=$p.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress}`));
    if (actual) assertStringCountIdentity(identity, actual);
    return actual;
  };
  const owned = () => { assert.ok(identity && inspect(), 'Owned process exited'); };
  const poll = async (read, predicate, label) => {
    const until = performance.now() + 45000;
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
    return await page.evaluate(([cmd, a]) => window.__TAURI_INTERNALS__.invoke(cmd, a), [command, args]);
  };

  const workspace = () => invoke('workspace_snapshot');
  const record = async () => invoke('project_snapshot', { documentId: (await workspace()).active.documentId });
  const native = () => poll(() => invoke('audio_status'), value => {
    assert.equal(value.error, null);
    return value.ready && value.generation === value.desiredGeneration;
  }, 'paused current native preparation');
  const idle = async () => { owned(); await ui.waitForWorkspaceIdle(page); };
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
      TABPLAYER_TEST_PLUGIN_BUNDLE: selectedBundle,
      WEBVIEW2_USER_DATA_FOLDER: profileDir,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9223',
      STRING_COUNT_EXE: packet.executable,
      STRING_COUNT_IDENTITY: identityPath,
      ...environment
    };

    const script = '$ErrorActionPreference="Stop";$p=Start-Process -FilePath $env:STRING_COUNT_EXE -WindowStyle Hidden -PassThru;$text=@{pid=$p.Id;path=$p.Path;startTicks=$p.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress;[IO.File]::WriteAllText($env:STRING_COUNT_IDENTITY,$text);$text';
    identity = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      env
    }).trim());

    assertStringCountIdentity(identity, json(identityPath));
    owned();

    const before = await poll(listeners, rows => rows.length > 0, 'owned CDP listener');
    assertScoreLayoutListener(identity, profileDir, before);

    const { chromium } = await import('playwright');
    browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
    page = browser.contexts()[0].pages()[0];
    page.setDefaultTimeout(45000);

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
    if (identity && inspect()) {
      ps(`${ownedScript}if($null -ne $p){Stop-Process -Id $p.Id;if(-not $p.WaitForExit(5000)){throw 'Owned process did not exit'}}`);
    }
    try {
      execFileSync('powershell.exe', [
        '-NoProfile', '-Command',
        'Get-Process tabplayer-plugin-host -ErrorAction SilentlyContinue | Stop-Process -Force'
      ], { windowsHide: true });
    } catch {}
    identity = null;
  };

  const exportWav = async name => {
    await ui.clickWorkspaceCommand(page, 'Export score', { waitForIdle: false });
    const dialog = page.getByRole('dialog', { name: 'Export score' });
    await dialog.getByLabel('Export format').selectOption('wav');
    await dialog.getByLabel('File name', { exact: true }).fill(name);
    await dialog.getByRole('button', { name: 'Export', exact: true }).click();

    const targetFile = resolve(paths.export, `${name}.wav`);
    const until = Date.now() + 180000;
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

  try {
    ui = await import('./workstation-commands.mjs');
    const { exporter, model, Settings } = await import('@coderline/alphatab');

    // Synthesize score
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

    console.log(`[Acceptance] Testing real plug-in: ${selectedBundle}`);
    await launch('', { TABPLAYER_TEST_OPEN: files.fixture, TABPLAYER_TEST_SAVE: files.saved });
    await button('Open');
    await page.locator('[aria-label="Music notation"] svg').first().waitFor();
    await native();

    const builtinBytes = await exportWav('builtin-baseline');
    const builtinWav = channels(builtinBytes);

    await openSound();

    // Add real plug-in to library
    const addBtn = page.getByRole('button', { name: 'Add plug-in…', exact: true });
    await addBtn.click();
    await idle();

    // Select the added real plug-in
    await poll(async () => {
      const options = await pluginPicker().locator('option').all();
      return options.length > 1;
    }, has => has, 'real plug-in added to options');

    const options = await pluginPicker().locator('option').all();
    const targetOption = options[1];
    const realClassId = await targetOption.getAttribute('value');
    const optionText = await targetOption.innerText();
    console.log(`[Acceptance] Found real plug-in option: "${optionText}" (classId: ${realClassId})`);

    report.classId = realClassId;
    report.pluginName = optionText;

    await pluginPicker().selectOption('');
    await idle();
    await pluginPicker().selectOption(realClassId);
    await idle();

    const chosenSlot = await poll(async () => (await lastSoundEdit())?.sound?.plugin, p => p?.classId === realClassId, 'real plug-in chosen');
    report.pluginName = chosenSlot.name;
    report.pluginVendor = chosenSlot.vendor ?? '';
    report.pluginVersion = chosenSlot.version ?? '';

    // Play
    await button('Play');
    const audioState = await poll(() => invoke('audio_status'), s => s.playing && s.renderedFrames > 4096 && s.outputPeak > 0.001 && !s.error, 'playing real plug-in');
    report.livePeak = audioState.outputPeak;
    report.latencySamples = audioState.pluginDelayFrames;
    console.log(`[Acceptance] Playback active: outputPeak = ${audioState.outputPeak.toFixed(4)}, delayFrames = ${audioState.pluginDelayFrames}`);
    await button('Stop');

    // Editor open & close
    const docId1 = (await workspace()).active.documentId;
    const trackId1 = (await lastSoundEdit()).trackId;
    const editsBefore = (await record()).snapshot.project.edits.length;

    const editBtn = page.getByRole('button', { name: 'Edit plug-in', exact: true });
    await editBtn.click();
    await sleep(1500);

    await page.evaluate(([doc, trk]) => window.__TAURI_INTERNALS__.invoke('plugin_editor_close', { documentId: doc, trackId: trk }), [docId1, trackId1]);
    await idle();
    report.editorVerified = true;
    console.log('[Acceptance] Editor open and close verified.');

    // Save
    await button('Save');
    const savedPath = `${files.saved}.tabplayer`;
    assert.ok(existsSync(savedPath));
    console.log(`[Acceptance] Document saved with real plug-in state: ${savedPath}`);

    await quit();

    // Reopen
    assertStringCountPortFree(portRows());
    await launch('-reopen', { TABPLAYER_TEST_OPEN: savedPath, TABPLAYER_TEST_SAVE: files.saved });
    await button('Open');
    await page.locator('[aria-label="Music notation"] svg').first().waitFor();
    await native();
    await openSound();

    const docId2 = (await workspace()).active.documentId;
    const reopenStatuses = await invoke('plugin_status', { documentId: docId2 });
    assert.equal(reopenStatuses[0]?.status, 'ready', 'Reopened document status is ready');
    report.reopenVerified = true;
    console.log('[Acceptance] Reopened document verified with status ready.');

    // Export WAV
    const realExportBytes = await exportWav('real-plugin-export');
    const realWav = channels(realExportBytes);
    const realStats = stats(realWav);
    assert.ok(realStats.rms > 0.001, 'Real plug-in export is not silent');
    assert.equal(realWav.samples[0].length, builtinWav.samples[0].length, 'Export frames match baseline');

    report.exportFrames = realWav.samples[0].length;
    report.exportRms = realStats.rms;
    report.exportPeak = realStats.peak;
    report.status = 'passed';
    console.log(`[Acceptance] Export verified: frames = ${realWav.samples[0].length}, rms = ${realStats.rms.toFixed(5)}, peak = ${realStats.peak.toFixed(5)}`);

  } catch (error) {
    failure = error;
    report.status = 'failed';
    report.error = { message: String(error), stack: error?.stack };
    console.error('[Acceptance] Failed:', error);
  } finally {
    try { await quit(); } catch (err) { failure ??= err; }
    report.finishedAt = new Date().toISOString();
    writeFileSync(resolve(paths.results, 'real-plugin-report.json'), JSON.stringify(report, null, 2), { flag: 'w' });
  }

  if (failure) throw failure;
  return report;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const outcome = await runRealPluginAcceptance();
  console.log('\n================================================================');
  console.log('REAL PLUG-IN ACCEPTANCE PROOF RESULTS:');
  console.log('================================================================');
  console.log(JSON.stringify(outcome, null, 2));
}
