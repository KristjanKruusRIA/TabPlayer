// Drum map desktop acceptance (THE-219): a drum track's map decides which key its hosted instrument and its MIDI port are sent.
// Through the real interface over CDP, with the synthetic test plug-in's drum ("TabPlayer Test Drum", whose output level encodes the
// key it received, see `drum_amplitude`) and the desktop-test build's recording MIDI port, it checks that
//  1. the Drum map row shows on a drum track with the instrument, and not on a guitar track or a drum track with neither an
//     instrument nor a port;
//  2. the select lists General MIDI and the layouts ("not yet checked"), choosing one is one undo step, choosing the current one
//     records nothing, and the status and disclaimer lines show;
//  3. the Keys editor lists the sounds of the track, a change is one edit with a Changed marker and a count, the same value records
//     nothing, row reset and Reset all are one edit each, an empty key says No sound, candidates set the key, Tab goes through the
//     fields in visual order, focus stays on the field after a commit and Escape closes only the Keys section;
//  4. the sound: an audio export decodes the drum's level to the new key for a moved row and to their own keys for the others, a silent
//     row is absent, General MIDI equals the no-map export, and a row edited during playback keeps playing without a fault or a new plan;
//  5. MIDI out: the keys that arrive are the mapped ones and a map edit during playback sends only the NoteOff of the key let go;
//  6. a map is exported to a file and imported on another drum track, importing it again records nothing, an invalid file shows the
//     translated error and changes nothing (the native dialogs are driven through UI Automation);
//  7. the map survives save, close and reopen and is kept by a duplicated track;
//  8. screenshots in English, Estonian and German are written under .analysis/desktop-smoke/ (git-ignored) for a person to look at.
//
// Build with scripts/build-desktop-test.ps1, then, from the checkout root:
//   node tests/desktop/parity-drum-map.mjs
// or:
//   node tests/desktop/parity-drum-map.mjs --build=<absolute build.json>
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

const DRUM_CLASS_ID = '7ABB1A7E57E5701C8E5700000000A002';
const TEST_PORT = 'Test MIDI output';
const LANGUAGES = ['en', 'et', 'de'];
/** The test score's sounds, in beat order of every bar: key, and the beat each plays on. Tempo 60, so a beat is a second. */
const PATTERN = [36, 38, 42, 38];
const BARS = 4;
const TEMPO = 60;
const GUITAR = 'Track 1: Guitar', DRUMS = 'Track 2: Drums', DRUMS_B = 'Track 3: Drums B';

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
/** The mean absolute level of the left channel in the middle of every beat: what the drum's square wave is at that hit. */
function beatLevels(wav, beats) {
  const beat = wav.rate * 60 / TEMPO, out = [];
  for (let i = 0; i < beats; i++) {
    let sum = 0, n = 0;
    for (let f = Math.round(i * beat + beat * 0.3); f < Math.round(i * beat + beat * 0.7); f++) { sum += Math.abs(wav.samples[0][f]); n++; }
    out.push(sum / n);
  }
  return out;
}
/**
 * The master stage scales the drum's output, so the level of a hit is s * (key * 128 + velocity) / 16384 with s and the velocity unknown.
 * The kick (36) and the first snare (38) of a map that leaves them alone are two known points: their difference is s * 256 / 16384.
 */
function calibrate(levels) {
  const scale = (levels[1] - levels[0]) * 64;
  assert.ok(scale > 0.3 && scale < 1.2, `the master scale is plausible: ${scale}`);
  const velocity = levels[0] * 16384 / scale - 36 * 128;
  assert.ok(velocity > 0 && velocity < 128, `the velocity is plausible: ${velocity}`);
  return level => (level * 16384 / scale - velocity) / 128;
}
/** The key each beat played, or null where the beat is silent. */
function decodeKeys(levels, keyOf) {
  return levels.map(level => level < 0.003 ? null : Math.round(keyOf(level)));
}
const expected = (beats, rows = {}) => Array.from({ length: beats }, (_, i) => {
  const base = PATTERN[i % PATTERN.length];
  return base in rows ? rows[base] : base;
});

export async function runDrumMapParity({ buildPath } = {}) {
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

  const ps = (script, extra = {}, timeout = 20000) => execFileSync('powershell.exe', [
    '-NoProfile', '-Command', `$ErrorActionPreference='Stop';${script}`
  ], {
    encoding: 'utf8',
    windowsHide: true,
    timeout,
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

  const runDirectory = mkdtempSync(resolve(ownedDirectory, 'drum-map-'));
  const names = ['session', 'profile', 'app-data', 'input', 'export', 'results', 'shots', 'maps'];
  const paths = Object.fromEntries(names.map(name => [name, resolve(runDirectory, name)]));
  for (const p of Object.values(paths)) mkdirSync(p, { recursive: true });

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

  const files = { fixture: resolve(paths.input, 'drum-map.gp'), saved: resolve(paths.input, 'drum-map-saved') };

  const result = {
    format: 'TabPlayerDrumMapReceipt',
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
      await sleep(40);
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
  const editCount = async () => (await edits()).length;
  const mixEdits = async () => (await edits()).filter(e => e.type === 'setTrackMix');
  /** The drum map the latest mix edit of a track left, or undefined (no map). */
  const mapOf = async trackId => (await mixEdits()).filter(e => e.trackId === trackId).at(-1)?.mix?.drumMap;
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
      TABPLAYER_MIDI_OUT_TEST: '1',
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
    await closeSound();
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

  /** Escape closes the open Keys section first (its own rule), then the dialog, so it is pressed until the dialog is gone. */
  const closeSound = async () => {
    const dialog = page.locator('.plugin-dialog');
    for (let i = 0; i < 3 && await dialog.isVisible(); i++) { await page.keyboard.press('Escape'); await sleep(150); }
    await dialog.waitFor({ state: 'hidden' });
    await ui.waitForWorkspaceIdle(page);
  };

  // ---- Panels ----------------------------------------------------------------------------------------------------------------
  // The plug-in slot and the drum map are in the Plug-in dialog (the sound dialog holds neither).
  const soundPanel = () => page.locator('.plugin-dialog').getByRole('region', { name: 'Plug-in' });
  const openSound = async () => {
    where = 'dialog';
    await ui.openPluginDialog(page);
  };
  const pluginPicker = () => page.locator('.sound-plugin-slot select');
  const selectTrack = async name => {
    await closeSound();
    await page.locator('.view-switch button[role="radio"]').nth(0).click().catch(() => {});
    await ui.selectWorkspaceTrack(page, name);
    await idle();
    await openSound();
  };
  /** The Track tab's MIDI out panel, opened, with the track selected. */
  const midiPanel = async name => {
    where = 'midi';
    await closeSound();
    await ui.selectWorkspaceTrack(page, name);
    await idle();
    await ui.revealInspectorTab(page, 'Track');
    const panel = page.locator('details.midi-out-more');
    await panel.evaluate(node => { node.open = true; });
    return panel;
  };
  const selectAnyLanguage = async ordinal => {
    where = 'dialog';
    await closeSound();
    const strip = page.locator(`button.track-channel-select[aria-pressed="false"]:has-text("${ordinal}. Drums")`).first();
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
  /** Which panel section() means: the sound dialog's Drum map row or the MIDI out panel's. */
  let where = 'dialog';
  const section = () => page.locator(where === 'dialog' ? '.plugin-dialog .drum-map' : 'details.midi-out-more .drum-map').first();
  const mapSelect = () => section().locator('select');
  const keysDetails = () => section().locator('details.drum-map-keys');
  const openKeys = async view => {
    const d = keysDetails();
    if (!await d.evaluate(node => node.open)) {
      await d.locator(':scope > summary').scrollIntoViewIfNeeded();
      await sleep(300);
      await d.locator(':scope > summary').click({ timeout: 8000 }).catch(async () => { await d.evaluate(node => { node.open = true; }); });
    }
    // The view names are translated, so the first radio is "In this track" and the second "All sounds" in every language.
    if (view) await section().locator('[role="radio"]').nth(view === 'In this track' ? 0 : 1).click();
  };
  /** The rows shown: sound name, the key field's text, the Changed marker, and the note text. */
  const rows = () => section().locator('li.drum-map-row').evaluateAll(nodes => nodes.map(node => ({
    sound: node.querySelector('.drum-map-sound')?.textContent ?? '',
    key: node.querySelector('input')?.value ?? '',
    label: node.querySelector('input')?.getAttribute('aria-label') ?? '',
    changed: node.hasAttribute('data-changed'),
    changedText: node.querySelector('.drum-map-changed')?.textContent ?? '',
    note: node.querySelector('.drum-map-note')?.textContent ?? ''
  })));
  const rowInput = keyText => section().locator('li.drum-map-row').filter({ has: page.locator(`input[value="${keyText}"]`) }).locator('input');
  /** Types a key into the field of the row whose key is `from` now, and commits it with Enter. */
  const setKey = async (from, to) => {
    const input = section().locator('li.drum-map-row input').nth(await section().locator('li.drum-map-row input').evaluateAll((nodes, v) => nodes.findIndex(n => n.value === v), String(from)));
    await input.fill(String(to));
    await input.press('Enter');
    await idle();
  };
  /** Reset all lives in the Keys section, which a freshly opened dialog has closed. */
  const resetAll = async () => { await openKeys(); await section().getByRole('button', { name: 'Reset all to preset', exact: true }).click(); await idle(); };
  const statusLines = () => section().locator('p').allInnerTexts();
  const heldNotes = log => {
    const held = new Map();
    for (const entry of log) {
      const kind = entry.bytes[0] & 0xf0, key = `${entry.bytes[0] & 0x0f}:${entry.bytes[1]}`;
      if (kind === 0x90 && entry.bytes[2] > 0) held.set(key, (held.get(key) ?? 0) + 1);
      else if (kind === 0x80 || kind === 0x90) held.set(key, Math.max(0, (held.get(key) ?? 0) - 1));
    }
    return [...held].filter(([, n]) => n > 0);
  };

  const shoot = async (name, target) => {
    const file = resolve(paths.shots, `${name}.png`);
    try {
      await (target ?? page).screenshot({ path: file, timeout: 8000 });
    } catch (error) {
      // An element that never holds still cannot be shot by element; report how it moves, then shoot its page area instead.
      const box = target ? await target.evaluate(async node => { const out = []; for (let i = 0; i < 6; i++) { const r = node.getBoundingClientRect(); out.push([Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]); await new Promise(a => setTimeout(a, 150)); } return out; }) : null;
      result.observations[`unstable-${name}`] = box;
      console.log(`UNSTABLE ${name}: ${JSON.stringify(box)}`);
      const rect = target ? await target.boundingBox() : null;
      await page.screenshot({ path: file, clip: rect ?? undefined });
    }
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

  /** Drives the native file dialog the app opened (the system common dialog is a window of the app's own process): types the path and accepts. */
  const driveDialog = async path => ps(`
Add-Type @"
using System;using System.Collections.Generic;using System.Runtime.InteropServices;using System.Text;
public static class Dlg{
  delegate bool EnumProc(IntPtr h,IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p,IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr w,EnumProc p,IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h,StringBuilder s,int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr h,uint m,IntPtr w,string l);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
  static string Cls(IntPtr h){var s=new StringBuilder(256);GetClassName(h,s,256);return s.ToString();}
  public static IntPtr Find(uint pid){IntPtr found=IntPtr.Zero;EnumWindows((h,l)=>{uint p;GetWindowThreadProcessId(h,out p);if(p==pid&&Cls(h)=="#32770"&&IsWindowVisible(h)){found=h;return false;}return true;},IntPtr.Zero);return found;}
  public static IntPtr Edit(IntPtr dlg){IntPtr found=IntPtr.Zero;EnumChildWindows(dlg,(h,l)=>{if(Cls(h)=="Edit"&&IsWindowVisible(h)){found=h;return false;}return true;},IntPtr.Zero);return found;}
  public static string Tree(IntPtr dlg){var o=new List<string>();EnumChildWindows(dlg,(h,l)=>{o.Add(Cls(h));return true;},IntPtr.Zero);return string.Join(",",o);}
  public static void Set(IntPtr edit,string text){SendMessage(edit,0xC,IntPtr.Zero,text);}
  public static void Ok(IntPtr dlg){PostMessage(dlg,0x111,(IntPtr)1,IntPtr.Zero);}
}
"@
$deadline=(Get-Date).AddSeconds(25);$done=$false;$tree=''
while(-not $done -and (Get-Date) -lt $deadline){
  Start-Sleep -Milliseconds 250
  $dlg=[Dlg]::Find([uint32]$env:STRING_COUNT_PID)
  if($dlg -eq [IntPtr]::Zero){continue}
  $edit=[Dlg]::Edit($dlg)
  if($edit -eq [IntPtr]::Zero){$tree=[Dlg]::Tree($dlg);continue}
  [Dlg]::Set($edit,$env:DIALOG_PATH)
  Start-Sleep -Milliseconds 200
  [Dlg]::Ok($dlg)
  $done=$true
}
if(-not $done){throw ('No file dialog appeared; children: '+$tree)}
'ok'`, { DIALOG_PATH: path }, 45000);

  const ensureFile = async (button, file) => {
    await button.click();
    await driveDialog(file);
    await poll(async () => existsSync(file), v => v, `${file} written`, 15000);
  };

  try {
    ui = await import('./workstation-commands.mjs');
    const { exporter, model, Settings } = await import('@coderline/alphatab');

    // A guitar track of rests and two drum tracks that play kick, snare, closed hi-hat and snare on the beats, 4 bars at 60 bpm.
    {
      const score = new model.Score();
      for (let i = 0; i < BARS; i++) {
        const master = new model.MasterBar();
        if (i === 0) {
          const tempo = new model.Automation();
          tempo.type = model.AutomationType.Tempo; tempo.value = TEMPO; tempo.isLinear = false;
          master.tempoAutomations.push(tempo);
        }
        master.timeSignatureNumerator = 4; master.timeSignatureDenominator = 4;
        score.addMasterBar(master);
      }
      const guitar = new model.Track(), guitarStaff = new model.Staff();
      guitar.name = 'Guitar'; guitar.shortName = 'Gtr';
      guitar.playbackInfo.program = 25;
      guitarStaff.stringTuning.tunings = [64, 59, 55, 50, 45, 40];
      guitar.addStaff(guitarStaff); score.addTrack(guitar);
      const makeDrums = (name, short) => {
        const drums = new model.Track(), staff = new model.Staff();
        drums.name = name; drums.shortName = short;
        Object.assign(drums.playbackInfo, { program: 0, primaryChannel: 9, secondaryChannel: 9 });
        const articulations = [[36, 'Kick Drum', 7], [38, 'Snare', 3], [42, 'Hi-Hat (closed)', -1]];
        drums.percussionArticulations = articulations.map(([key, label, line]) => new model.InstrumentArticulation(label, line, key, model.MusicFontSymbol.NoteheadBlack, model.MusicFontSymbol.NoteheadHalf, model.MusicFontSymbol.NoteheadWhole, model.MusicFontSymbol.None, model.TechniqueSymbolPlacement.Above, key));
        staff.isPercussion = true; staff.showTablature = false; staff.showStandardNotation = true;
        drums.addStaff(staff); score.addTrack(drums);
        return staff;
      };
      const staffA = makeDrums('Drums', 'Dr'), staffB = makeDrums('Drums B', 'DrB');
      const articulationOf = { 36: 0, 38: 1, 42: 2 };
      let id = 0;
      for (let index = 0; index < BARS; index++) {
        const gbar = new model.Bar(); gbar.id = id++; gbar.clef = model.Clef.G2; guitarStaff.addBar(gbar);
        const gvoice = new model.Voice(); gvoice.id = id++; gbar.addVoice(gvoice);
        const rest = new model.Beat(); rest.id = id++; rest.duration = model.Duration.Whole; rest.isEmpty = false; gvoice.addBeat(rest);
        for (const staff of [staffA, staffB]) {
          const dbar = new model.Bar(); dbar.id = id++; dbar.clef = model.Clef.Neutral; staff.addBar(dbar);
          const dvoice = new model.Voice(); dvoice.id = id++; dbar.addVoice(dvoice);
          for (const key of PATTERN) {
            const beat = new model.Beat(); beat.id = id++; beat.duration = model.Duration.Quarter; beat.isEmpty = false; dvoice.addBeat(beat);
            const note = new model.Note(); note.id = id++;
            note.percussionArticulation = articulationOf[key];
            beat.addNote(note);
          }
        }
      }
      score.finish(new Settings());
      writeFileSync(files.fixture, new exporter.Gp7Exporter().export(score, new Settings()), { flag: 'wx' });
    }

    // =========================================================================
    // Launch 1
    // =========================================================================
    await launch('', { TABPLAYER_TEST_OPEN: files.fixture, TABPLAYER_TEST_SAVE: files.saved, TABPLAYER_TEST_PLUGIN_VIEW_NO_EDIT: '1' });
    await button('Open');
    await page.locator('[aria-label="Music notation"] svg').first().waitFor();
    await native();
    const doc = await documentId();
    const beats = BARS * PATTERN.length;

    // Mute Track 3 (Drums B) before setTrackSound builds the hosted-instrument renderer so its built-in kit starts at zero gain (no ramp leak on Play in 4b).
    await ui.revealDock(page, 'Mixer');
    const drumsBMute = page.getByRole('region', { name: /^Channel 3: / }).getByRole('checkbox', { name: 'Mute', exact: true });
    await drumsBMute.click();
    await poll(() => drumsBMute.isChecked(), Boolean, 'Drums B muted');
    await idle();

    // Put the instrument on the first drum track (the effect/instrument library is added through the panel).
    await selectTrack(GUITAR);
    await page.getByRole('button', { name: 'Add plug-in…', exact: true }).click();
    await idle();
    await poll(async () => soundPanel().locator('details.plugin-library-manage').count(), n => n === 1, 'library list appears');

    // 1. Where the row shows.
    const hasRow = async () => section().isVisible().catch(() => false);
    assert.equal(await page.locator('.plugin-dialog .drum-map').count(), 0, 'no Drum map row on a guitar track');
    await selectTrack(DRUMS);
    assert.equal(await page.locator('.plugin-dialog .drum-map').count(), 0, 'no Drum map row on a drum track with no instrument');
    const midiBeforeRoute = await midiPanel(DRUMS);
    assert.equal(await page.locator('details.midi-out-more .drum-map').count(), 0, 'no Drum map row on a drum track with no MIDI port');
    await selectTrack(DRUMS);
    const editsBeforeChoose = await editCount();
    await pluginPicker().selectOption(DRUM_CLASS_ID);
    await idle();
    await poll(async () => page.locator('.plugin-dialog .drum-map').count(), n => n === 1, 'the Drum map row appears with the instrument');
    const order = await soundPanel().evaluate(node => {
      const slot = node.querySelector('.sound-plugin-slot'), map = node.querySelector('.drum-map');
      return Boolean(slot.compareDocumentPosition(map) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    assert.ok(order, 'the Drum map row follows the plug-in slot');
    const drumTrackId = (await edits()).filter(e => e.type === 'setTrackSound').at(-1).trackId;
    await selectTrack(GUITAR);
    assert.equal(await page.locator('.plugin-dialog .drum-map').count(), 0, 'still none on the guitar track');
    await selectTrack(DRUMS);
    step('1. The Drum map row shows after the plug-in slot of a drum track with the instrument, not on a guitar track, not on a drum track with neither instrument nor port', { drumTrackId });

    // 2. The select, the status, one undo step.
    const options = await mapSelect().locator('option').allInnerTexts();
    assert.ok(options[0].startsWith('General MIDI'), `General MIDI first: ${options}`);
    const layouts = options.slice(1);
    assert.equal(layouts.length, 12, `twelve layouts: ${layouts}`);
    const unverifiedLayouts = layouts.filter(text => text.endsWith('— not yet checked'));
    const verifiedLayouts = layouts.filter(text => !text.endsWith('— not yet checked'));
    assert.equal(verifiedLayouts.length, 4, `four verified layouts: ${layouts}`);
    assert.equal(unverifiedLayouts.length, 8, `eight unverified layouts: ${layouts}`);
    const lines0 = await statusLines();
    assert.ok(lines0.some(text => /General MIDI keys, as the built-in kit plays them\./.test(text)), `GM source line: ${lines0}`);
    assert.ok(lines0.some(text => /not affiliated/.test(text)), `disclaimer line: ${lines0}`);
    const before = await editCount();
    const gmValue = await mapSelect().inputValue();
    const layoutId = await mapSelect().locator('option').nth(1).getAttribute('value');
    await mapSelect().selectOption(layoutId);
    await idle();
    assert.equal(await editCount(), before + 1, 'Choosing a layout is one edit');
    const lines1 = await statusLines();
    assert.ok(lines1.some(text => /Checked on 2026-11-27\./.test(text)), `verified status: ${lines1}`);
    result.observations.layoutStatus = lines1;
    await button('Undo');
    await openSound();
    assert.equal(await editCount(), before, 'Undo takes the choice back in one step');
    assert.equal(await mapSelect().inputValue(), gmValue, 'the select is back to General MIDI');
    await button('Redo');
    await openSound();
    assert.equal(await mapSelect().inputValue(), layoutId, 'Redo restores the layout');
    await mapSelect().selectOption(layoutId);
    await idle(); await sleep(300);
    assert.equal(await editCount(), before + 1, 'Choosing the current layout records nothing');
    const unverifiedId = await mapSelect().locator('option').nth(2).getAttribute('value');
    await mapSelect().selectOption(unverifiedId);
    await idle();
    assert.equal(await editCount(), before + 2, 'Choosing an unverified layout is one edit');
    const lines2 = await statusLines();
    assert.ok(lines2.some(text => /have not been checked against the library\. If a sound plays wrong/.test(text)), `unverified status: ${lines2}`);
    assert.equal(await section().locator('details.drum-map-source > summary').count(), 1, 'the unverified layout\'s own source sits in a disclosure');
    result.observations.unverifiedLayoutStatus = lines2;
    await mapSelect().selectOption('gm');
    await idle();
    assert.equal(await editCount(), before + 3, 'Going back to General MIDI is one edit');
    assert.equal(await mapOf(drumTrackId), undefined, 'General MIDI with no changes is written as no map');
    step('2. The select lists General MIDI and twelve layouts (four verified, eight marked not yet checked); choosing is one undo step; the current one records nothing; verified/unverified status and disclaimer show', { options, lines1, lines2 });

    // 3. The Keys editor.
    await openKeys('In this track');
    const used = await rows();
    assert.deepEqual(used.map(r => r.key).sort(), ['36', '38', '42'], `the sounds of the test score: ${JSON.stringify(used)}`);
    assert.equal(used.length, 3, 'exactly the sounds the score uses');
    result.observations.usedRows = used;
    const countLine = () => section().locator('[role="status"]').innerText();
    const b0 = await editCount();
    await setKey(38, 52);
    assert.equal(await editCount(), b0 + 1, 'Changing one key is one edit');
    let after = await rows();
    const snareRow = after.find(r => r.key === '52');
    assert.ok(snareRow?.changed && snareRow.changedText === 'Changed', `the row shows Changed: ${JSON.stringify(after)}`);
    assert.equal(after.filter(r => r.changed).length, 1);
    assert.match(await countLine(), /1 key changed\./);
    // The same value records nothing.
    await setKey(52, 52); await sleep(200);
    assert.equal(await editCount(), b0 + 1, 'Committing the same value records nothing');
    // Per-row reset.
    await section().getByRole('button', { name: /^Reset .* to the layout$/ }).click(); await idle();
    assert.equal(await editCount(), b0 + 2, 'Row reset is one edit');
    assert.equal((await rows()).filter(r => r.changed).length, 0);
    assert.equal(await mapOf(drumTrackId), undefined, 'after the row reset the track has no map again');
    // Reset all.
    await setKey(38, 52); await setKey(36, 40);
    assert.match(await countLine(), /2 keys changed\./);
    const b1 = await editCount();
    await resetAll();
    assert.equal(await editCount(), b1 + 1, 'Reset all is one edit');
    assert.equal((await rows()).filter(r => r.changed).length, 0);
    // An empty key says No sound.
    await setKey(42, '');
    after = await rows();
    const none = after.find(r => r.key === '');
    assert.ok(none?.changed && /No sound/.test(none.note), `an empty key says No sound: ${JSON.stringify(after)}`);
    assert.match(await countLine(), /1 sound in this track has no key in this map\./);
    await resetAll();
    // Candidates on a library layout set the key.
    await mapSelect().selectOption(layoutId); await idle();
    const candidateGroup = section().locator('.drum-map-candidates').first();
    const candidateCount = await section().locator('.drum-map-candidates').count();
    result.observations.candidateGroups = candidateCount;
    if (candidateCount > 0) {
      const b2 = await editCount();
      const first = section().locator('.drum-map-candidates button[aria-pressed="false"]').first();
      const wanted = (await first.innerText()).trim();
      await first.click(); await idle();
      assert.equal(await editCount(), b2 + 1, 'A candidate button is one edit');
      assert.equal(await section().locator('li.drum-map-row input').evaluateAll((nodes, v) => nodes.some(n => n.value === v), wanted), true, 'the candidate key is in the field');
    } else {
      result.observations.candidateNote = 'the chosen layout has no candidates for the sounds this track uses';
    }
    await resetAll().catch(() => {});
    await mapSelect().selectOption('gm'); await idle();
    // Keyboard: the fields are reached in the order they are drawn, focus stays on the field after a commit, Escape closes only Keys.
    await openKeys('In this track');
    const inputs = section().locator('li.drum-map-row input');
    const boxes = await inputs.evaluateAll(nodes => nodes.map(n => { const b = n.getBoundingClientRect(); return { y: b.y, x: b.x, value: n.value }; }));
    assert.ok(boxes.every((b, i) => i === 0 || b.y > boxes[i - 1].y - 1), `the key fields are drawn top to bottom: ${JSON.stringify(boxes)}`);
    await inputs.first().focus();
    const tabbed = [];
    const stops = [];
    for (let i = 0; i < boxes.length * 3 && tabbed.length < boxes.length; i++) {
      const at = await page.evaluate(() => ({ tag: document.activeElement?.tagName, value: document.activeElement?.value ?? null, text: (document.activeElement?.textContent ?? '').slice(0, 20) }));
      stops.push(at.tag === 'INPUT' ? `input ${at.value}` : `${at.tag} ${at.text}`);
      if (at.tag === 'INPUT') tabbed.push(at.value);
      await page.keyboard.press('Tab');
    }
    result.observations.tabStops = stops;
    assert.deepEqual(tabbed, boxes.map(b => b.value), 'Tab goes through the key fields in the order they are drawn');
    const second = inputs.nth(1);
    await second.focus(); await second.fill('60'); await second.press('Enter'); await idle();
    const focused = await page.evaluate(() => ({ tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label'), value: document.activeElement?.value }));
    assert.equal(focused.tag, 'INPUT', `focus stays on the field after a commit: ${JSON.stringify(focused)}`);
    assert.equal(focused.value, '60');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.plugin-dialog').isVisible(), true, 'Escape inside Keys does not close the Plug-in dialog');
    assert.equal(await keysDetails().evaluate(node => node.open), false, 'Escape closes the Keys section');
    await openKeys('In this track');
    await resetAll();
    step('3. Keys editor: the track\'s three sounds; one edit per change; same value records nothing; row reset and Reset all; No sound; candidates; Tab order; focus stays; Escape closes only Keys', { used, tabbed, candidateGroups: candidateCount });

    // 4. Sound: the export decodes the keys.
    await closeSound();
    const noMapWav = channels(await exportWav('nomap'));
    const levels0 = beatLevels(noMapWav, beats);
    const keyOf = calibrate(levels0);
    const keys0 = decodeKeys(levels0, keyOf);
    assert.deepEqual(keys0, expected(beats), `the unmapped export plays the plan's own keys: ${JSON.stringify(keys0)}`);
    await openSound(); await openKeys('In this track');
    await setKey(38, 52);
    await closeSound();
    const movedWav = channels(await exportWav('moved'));
    const keysMoved = decodeKeys(beatLevels(movedWav, beats), keyOf);
    assert.deepEqual(keysMoved, expected(beats, { 38: 52 }), `snare moved to 52, the others on their own keys: ${JSON.stringify(keysMoved)}`);
    await openSound(); await openKeys('In this track');
    await setKey(52, '');
    await closeSound();
    const silentWav = channels(await exportWav('silent'));
    const keysSilent = decodeKeys(beatLevels(silentWav, beats), keyOf);
    assert.deepEqual(keysSilent, expected(beats, { 38: null }), `the snare is absent: ${JSON.stringify(keysSilent)}`);
    await openSound();
    await resetAll();
    await closeSound();
    const gmBytes = await exportWav('gm-again');
    assert.equal(hashFile(resolve(paths.export, 'gm-again.wav')), hashFile(resolve(paths.export, 'nomap.wav')), 'with General MIDI the export equals the no-map export');
    result.observations.exportKeys = { unmapped: keys0, moved: keysMoved, silent: keysSilent, scale: 'calibrated from the first kick and snare' };
    step('4a. Export: a moved row decodes to its new key, the others to their own, a silent row is absent, General MIDI equals the no-map export', { keys0, keysMoved, keysSilent });

    // Edit a row during playback (Drums B is muted so outputPeak reflects only Track 2's hosted test drum).
    await closeSound();
    const status0 = await invoke('audio_status');
    result.observations.audioStatusKeys = Object.keys(status0);
    await ui.clickWorkstationButton(page, 'Play', { waitForIdle: false });
    const playing0 = await poll(() => invoke('audio_status'), s => { assert.equal(s.error, null); return s.playing && s.seconds > 0.1 && s.outputPeak > 0.001; }, 'playing');
    const generationBefore = playing0.generation, desiredBefore = playing0.desiredGeneration;
    const framesBefore = playing0.renderedFrames;
    const snareLevelBefore = await (async () => { let peak = 0; const until = Date.now() + 2200; while (Date.now() < until) { peak = Math.max(peak, (await invoke('audio_status')).outputPeak); await sleep(50); } return peak; })();
    result.observations.liveEditBefore = { status0Peak: status0.outputPeak, playing0Peak: playing0.outputPeak, snareLevelBefore };
    const editsDuring = await editCount();
    await openSound(); await openKeys('In this track');
    await setKey(38, 127);
    await closeSound();
    const statusAfter = await invoke('audio_status');
    assert.equal(await editCount(), editsDuring + 1);
    assert.ok(statusAfter.playing && !statusAfter.error, 'playback goes on after the edit');
    assert.equal(statusAfter.generation, generationBefore, 'no new plan was prepared for the map edit');
    assert.equal(statusAfter.desiredGeneration, desiredBefore);
    // The next snare is the drum at key 127, much louder than anything played before. The meter keeps the last playback's peak, so
    // the level must exceed everything the first seconds of this playback reached.
    const louder = await poll(() => invoke('audio_status'), s => s.playing && s.outputPeak > snareLevelBefore * 1.4, `the following hits use the new key (before=${snareLevelBefore})`, 6000);
    const plugin = (await invoke('plugin_status', { documentId: doc })).find(s => s.trackId === drumTrackId);
    assert.equal(plugin.status, 'ready', 'the instrument stays ready');
    assert.ok(louder.renderedFrames > framesBefore, 'rendering went on');
    await ui.clickWorkstationButton(page, 'Stop', { waitForIdle: false });
    await poll(() => invoke('audio_status'), s => !s.playing, 'stopped');
    result.observations.liveEdit = { peakBefore: snareLevelBefore, peakAfter: louder.outputPeak, generation: [generationBefore, statusAfter.generation], desired: [desiredBefore, statusAfter.desiredGeneration] };
    await idle();
    await openSound();
    await resetAll();
    await closeSound();
    await ui.revealDock(page, 'Mixer');
    await drumsBMute.click();
    await poll(() => drumsBMute.isChecked(), v => !v, 'Drums B unmuted');
    await idle();
    step('4b. A row edited during playback: playback continues, no fault, the instrument stays ready, the plan generation is unchanged (no new plan; the renderer is rebuilt only for a new plan), and the following hits are louder (key 127)', result.observations.liveEdit);

    // 5. MIDI out.
    {
      const ports = (await invoke('midi_out_ports')).map(port => port.name);
      assert.ok(ports.includes(TEST_PORT), `the test port is listed: ${ports}`);
      const panel = await midiPanel(DRUMS_B);
      await panel.getByLabel('Output').selectOption(TEST_PORT);
      await idle();
      await poll(async () => page.locator('details.midi-out-more .drum-map').count(), n => n === 1, 'the Drum map row shows once a port is chosen');
      await openKeys('In this track');
      await setKey(38, 52);
      // The test port's log is emptied by every read, so what is read is kept here.
      const all = [];
      const drain = async () => { const chunk = await invoke('midi_out_test_log'); all.push(...chunk); return chunk; };
      const isOn = e => (e.bytes[0] & 0xf0) === 0x90 && e.bytes[2] > 0;
      const isOff = e => (e.bytes[0] & 0xf0) === 0x80 || ((e.bytes[0] & 0xf0) === 0x90 && e.bytes[2] === 0);
      await drain();
      all.length = 0;
      await ui.clickWorkstationButton(page, 'Play', { waitForIdle: false });
      await poll(() => invoke('audio_status'), s => s.playing, 'playing to the port');
      await poll(async () => { await drain(); return all; }, l => l.some(e => isOn(e) && e.bytes[1] === 52), 'the mapped snare arrives');
      // The map edit: snare 52 -> 53 while its note is held. Only the key let go gets a NoteOff.
      await openKeys();
      await drain();
      const mark = all.length;
      await setKey(52, 53);
      await sleep(250);
      await drain();
      const afterEdit = all.slice(mark);
      const programChanges = afterEdit.filter(e => (e.bytes[0] & 0xf0) === 0xc0 || (e.bytes[0] & 0xf0) === 0xb0);
      const struck = afterEdit.filter(isOn), released = afterEdit.filter(isOff);
      result.observations.midiEdit = { afterEdit: afterEdit.map(e => e.bytes) };
      assert.deepEqual(programChanges, [], 'no program change or controller is sent at a map edit');
      // A note struck inside the window is only the score's own next hit: it lies on the beat grid (a second apart) of the first snare.
      const grid = all.find(e => isOn(e) && e.bytes[1] === 52).unixMs;
      assert.ok(struck.every(e => { const off = (e.unixMs - grid) % 1000; return Math.min(off, 1000 - off) < 30; }), `nothing is struck again at a map edit, only the score's own hits: ${JSON.stringify(struck)}`);
      assert.ok(released.every(e => e.bytes[1] === 52), `only the changed key's NoteOff goes out: ${JSON.stringify(afterEdit.map(e => e.bytes))}`);
      assert.equal(released.length, 1, `the held key 52 is let go once (the edit came while it was held): ${JSON.stringify(afterEdit.map(e => e.bytes))}`);
      await poll(async () => { await drain(); return all; }, l => l.some(e => isOn(e) && e.bytes[1] === 53), 'the next snare uses the new key', 8000);
      await ui.clickWorkstationButton(page, 'Stop', { waitForIdle: false });
      await poll(() => invoke('audio_status'), s => !s.playing, 'stopped');
      await sleep(400);
      await drain();
      const log = all;
      const noteOns = log.filter(isOn);
      const onKeys = [...new Set(noteOns.map(e => e.bytes[1]))].sort((a, b) => a - b);
      assert.ok(onKeys.every(k => [36, 42, 52, 53].includes(k)), `the keys that arrived are the mapped ones: ${onKeys}`);
      assert.ok(!noteOns.some(e => e.bytes[1] === 38), 'the unmapped snare key never arrives');
      assert.ok(noteOns.every(e => (e.bytes[0] & 0x0f) === 9), 'all on channel 10');
      assert.deepEqual(heldNotes(log), [], 'no note is left sounding after Stop');
      const depth = new Map();
      let worst = 0;
      for (const e of log) {
        const k = `${e.bytes[0] & 0x0f}:${e.bytes[1]}`, kind = e.bytes[0] & 0xf0;
        if (kind === 0x90 && e.bytes[2] > 0) { depth.set(k, (depth.get(k) ?? 0) + 1); worst = Math.max(worst, depth.get(k)); }
        else if (kind === 0x80 || kind === 0x90) depth.set(k, Math.max(0, (depth.get(k) ?? 0) - 1));
      }
      assert.equal(worst, 1, 'no key was struck twice without being let go in between');
      result.observations.midiKeys = onKeys;
      step('5. MIDI out: the keys that arrive are the mapped ones on channel 10; a map edit during playback sends only the NoteOff of the key let go, no program change, nothing struck again; the next hit uses the new key', result.observations.midiEdit);
    }

    // 6. Export and import of a map file.
    {
      // Drums B has snare 52 -> 53 now; Drums A has no map. Export Drums B's map, import it on Drums A.
      await closeSound();
      await midiPanel(DRUMS_B);
      const mapFile = resolve(paths.maps, 'exported.tabplayer-drum-map.json');
      await ensureFile(section().getByRole('button', { name: 'Export…', exact: true }), mapFile);
      const exported = json(mapFile);
      assert.equal(exported.format, 'tabplayer-drum-map');
      result.observations.exportedFile = { keys: Object.keys(exported), rows: exported.keys?.length };
      assert.ok(Array.isArray(exported.keys) && exported.keys.some(([id, key]) => id === 38 && key === 53), 'the file holds the track\'s snare at 53');
      assert.equal(exported.keys.length, 94, 'every sound is written as resolved');
      // Import onto the first drum track (instrument).
      await selectTrack(DRUMS);
      await openKeys('In this track');
      const e0 = await editCount();
      await section().getByRole('button', { name: 'Import…', exact: true }).click();
      await driveDialog(mapFile);
      await poll(async () => editCount(), n => n === e0 + 1, 'the import is one edit');
      await idle();
      const imported = await mapOf(drumTrackId);
      assert.deepEqual(imported?.keys, [[38, 53]], `the second track ends with the same map as the first: ${JSON.stringify(imported)}`);
      assert.equal((await rows()).find(r => r.key === '53')?.changed, true);
      // Again: nothing recorded.
      await section().getByRole('button', { name: 'Import…', exact: true }).click();
      await driveDialog(mapFile);
      await sleep(800); await idle();
      assert.equal(await editCount(), e0 + 1, 'importing the same file again records nothing');
      // An invalid file.
      const bad = resolve(paths.maps, 'bad.tabplayer-drum-map.json');
      writeFileSync(bad, JSON.stringify({ format: 'tabplayer-drum-map', version: 1, name: 'Bad', keys: [[99999, 5]] }));
      await section().getByRole('button', { name: 'Import…', exact: true }).click();
      await driveDialog(bad);
      const alert = section().getByRole('alert');
      await alert.waitFor();
      const alertText = (await alert.innerText()).replace(/\s+/g, ' ');
      assert.match(alertText, /^The drum map was not imported: /);
      assert.equal(await editCount(), e0 + 1, 'a refused file changes nothing');
      result.observations.importError = alertText;
      await shoot('import-error-en', section());
      step('6. Export wrote the full map file; import on another drum track gives the same map in one edit; importing again records nothing; an invalid file shows the translated error and changes nothing', { alertText, exported: result.observations.exportedFile });
    }

    // 7a. Duplicate keeps the map.
    {
      await selectTrack(DRUMS);
      const before = (await workspace()).active.documentId;
      await closeSound();
      await button('Duplicate track');
      await ui.revealDock(page, 'Mixer');
      const trackNames = await page.locator('button[aria-label^="Track "]').evaluateAll(nodes => nodes.map(n => n.getAttribute('aria-label')));
      result.observations.tracksAfterDuplicate = trackNames;
      assert.equal(trackNames.length, 4, `the duplicate adds a track: ${trackNames}`);
      const copyName = trackNames.find(n => !['Track 1: Guitar', 'Track 2: Drums', 'Track 3: Drums B'].includes(n)) ?? trackNames[3];
      await selectTrack(copyName);
      await poll(async () => page.locator('.plugin-dialog .drum-map').count(), n => n === 1, `the copy "${copyName}" has the Drum map row (it kept the instrument)`);
      await openKeys('In this track');
      const copyRows = await rows();
      assert.equal(copyRows.find(r => r.changed)?.key, '53', `the copy keeps the map: ${JSON.stringify(copyRows)}`);
      result.observations.mixesWithMap = { copyName, copyRows: copyRows.map(r => [r.sound, r.key, r.changed]) };      step('7a. Duplicate track: the copy keeps the map', result.observations.mixesWithMap);
    }

    // Save.
    await closeSound();
    await button('Save');
    const savedPath = `${files.saved}.tabplayer`;
    assert.ok(existsSync(savedPath), 'The document was saved');
    healthy();
    await quit();

    // =========================================================================
    // Launch 2: reopen, the map is there and applies; screenshots
    // =========================================================================
    assertStringCountPortFree(portRows());
    await launch('-reopen', { TABPLAYER_TEST_OPEN: savedPath, TABPLAYER_TEST_SAVE: files.saved, TABPLAYER_TEST_PLUGIN_VIEW_NO_EDIT: '1' });
    await button('Open');
    await page.locator('[aria-label="Music notation"] svg').first().waitFor();
    await native();
    await selectTrack(DRUMS);
    await poll(async () => (await invoke('plugin_status', { documentId: await documentId() })).find(s => s.trackId === drumTrackId)?.status, s => s === 'ready', 'the reopened instrument is ready');
    await openKeys('In this track');
    const reopened = await rows();
    assert.equal(reopened.find(r => r.changed)?.key, '53', `the map is still there: ${JSON.stringify(reopened)}`);
    // And it still applies: export and decode (the guitar/drums A track plays snare as 53).
    await closeSound();
    const reopenWav = channels(await exportWav('reopened'));
    const keysReopened = decodeKeys(beatLevels(reopenWav, beats).map(level => level / 2), keyOf); // two drum tracks (the original and its copy) play the same hits, so every level is twice one track's
    assert.deepEqual(keysReopened, expected(beats, { 38: 53 }), `the reopened export plays the snare as 53 on both the track and its copy: ${JSON.stringify(keysReopened)}`);
    result.observations.reopenedKeys = keysReopened;
    step('7b. Save, close, reopen: the map is still there and the export plays it', { reopened: reopened.map(r => [r.sound, r.key, r.changed]), keysReopened });

    // 8. Screenshots in three languages.
    const trackLabel = { en: 'Drums' };
    for (const language of LANGUAGES) {
      if (language !== 'en') await setLanguage(language);
      await selectAnyLanguage(2);
      await page.locator('.plugin-dialog .drum-map').scrollIntoViewIfNeeded();
      await openKeys();
      await section().scrollIntoViewIfNeeded();
      await shoot(`plugin-dialog-keys-${language}`);
      await shoot(`drum-map-in-track-${language}`, section());
      // All sounds, with the percussion groups open.
      await section().getByRole('radio', { name: /^(All sounds|Kõik helid|Alle Klänge)/ }).click().catch(async () => { await section().locator('[role="radio"]').nth(1).click(); });
      await section().locator('details.drum-map-group').evaluateAll(nodes => nodes.forEach(n => { n.open = true; }));
      await shoot(`drum-map-all-sounds-${language}`, section());
      await section().locator('[role="radio"]').nth(0).click();
      const layout = await mapSelect().locator('option').nth(1).getAttribute('value');
      await mapSelect().selectOption(layout); await idle();
      await section().locator('details.drum-map-keys > summary').scrollIntoViewIfNeeded();
      await shoot(`drum-map-layout-candidates-${language}`, section());
      await mapSelect().selectOption('gm'); await idle();
      // MIDI out panel with the map row.
      await closeSound();
      await page.locator('.view-switch button[role="radio"]').nth(0).click().catch(() => {});
      const strip = page.locator('button.track-channel-select:has-text("3. Drums B")').first();
      if (await strip.isVisible()) { await strip.click(); await idle(); }
      await ui.revealInspectorTab(page, 'Track').catch(() => {});
      await page.locator('details.midi-out-more').evaluate(node => { node.open = true; });
      const out = page.locator('details.midi-out-more');
      await out.locator('select').first().selectOption(TEST_PORT).catch(() => {});
      await idle();
      await shoot(`midi-out-map-${language}`, out);
      where = 'midi';
      await openKeys('In this track');
      // The inspector scrolls, so the rows are brought into view and the whole window is shot.
      await section().locator('.drum-map-footer').scrollIntoViewIfNeeded();
      await shoot(`midi-out-keys-${language}`, out);
      await page.screenshot({ path: resolve(paths.shots, `midi-out-keys-page-${language}.png`) });
      result.screenshots.push(resolve(paths.shots, `midi-out-keys-page-${language}.png`));
      if (language !== 'en') {
        // The import error in this language.
        const bad = resolve(paths.maps, 'bad.tabplayer-drum-map.json');
        await out.getByRole('button', { name: /^(Import|Impordi|Importieren)/ }).click();
        await driveDialog(bad);
        await out.getByRole('alert').waitFor();
        await shoot(`import-error-${language}`, out.locator('.drum-map'));
      }
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
  const outcome = await runDrumMapParity({ buildPath: buildArg ? buildArg.slice(8) : undefined });
  console.log(JSON.stringify({ status: outcome.status, runDirectory: outcome.runDirectory, assertions: outcome.assertions.map(a => a.name), screenshots: outcome.screenshots }, null, 2));
}
