import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const browser=await chromium.connectOverCDP('http://127.0.0.1:9222');
const page=browser.contexts()[0].pages()[0];
const processId=execFileSync('powershell.exe',['-NoProfile','-Command','(Get-Process tabplayer | Where-Object MainWindowTitle -eq TabPlayer | Select-Object -First 1).Id'],{encoding:'utf8'}).trim();
const snapshot=()=>page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('project_snapshot'));
try {
  const before=await snapshot();
  for(const label of ['Open','Save']) {
    await page.getByRole('button',{name:label,exact:true}).click();
    const result=execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File','tests/desktop/cancel-dialog.ps1','-AppProcessId',processId],{encoding:'utf8'});
    await page.getByRole('button',{name:label,exact:true}).waitFor({state:'visible'});
    await page.waitForFunction(()=>!document.querySelector('button').disabled);
    assert.deepEqual(await snapshot(),before);
    console.log(label, result.trim(), 'snapshot unchanged');
  }
  assert.ok(await page.locator('svg').count()>0);
} finally { await browser.close(); }
