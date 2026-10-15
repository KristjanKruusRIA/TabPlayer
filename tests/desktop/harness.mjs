import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
export const directory=resolve('.analysis/desktop-smoke');
const executable=resolve(directory,'tabplayer.exe');
export function launch(environment={}) {
  const sessionDirectory=environment.TABPLAYER_TEST_SESSION_DIR ?? process.env.TABPLAYER_TEST_SESSION_DIR ?? mkdtempSync(resolve(directory,'session-'));
  return Number(execFileSync('powershell.exe',['-NoProfile','-Command','$app=Start-Process -FilePath $env:TABPLAYER_SMOKE_EXE -WindowStyle Hidden -PassThru; $app.Id'],{
    encoding:'utf8',env:{...process.env,...environment,TABPLAYER_SMOKE_EXE:executable,TABPLAYER_DESKTOP_TEST:'1',TABPLAYER_TEST_SESSION_DIR:sessionDirectory,WEBVIEW2_USER_DATA_FOLDER:resolve(directory,`profile-${Date.now()}`),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9223'}
  }).trim());
}
export function stop(id) {
  execFileSync('powershell.exe',['-NoProfile','-Command','$p=Get-Process -Id $env:TABPLAYER_SMOKE_PID -ErrorAction Stop; if($p.Path -ne $env:TABPLAYER_SMOKE_EXE){throw "Unexpected test process"}; Stop-Process -Id $p.Id; $null=$p.WaitForExit(5000)'],{env:{...process.env,TABPLAYER_SMOKE_PID:String(id),TABPLAYER_SMOKE_EXE:executable}});
}
export async function connect() {
  for(let attempt=0;attempt<100;attempt++) {
    try{return await chromium.connectOverCDP('http://127.0.0.1:9223');}catch{await new Promise(r=>setTimeout(r,100));}
  }throw new Error('Isolated test webview did not start.');
}
