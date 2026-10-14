import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const browser=await chromium.connectOverCDP('http://127.0.0.1:9222');
const page=browser.contexts()[0].pages()[0];
const idle=()=>page.waitForFunction(()=>!document.querySelector('nav button').disabled);
const snapshot=()=>page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('project_snapshot'));
try {
  await page.getByLabel('Fret',{exact:true}).fill('7');await page.getByRole('button',{name:'Set note',exact:true}).click();await idle();
  await page.getByRole('button',{name:'Add track',exact:true}).click();await idle();
  await page.getByRole('button',{name:'Track 2: Bass',exact:true}).click();
  await page.getByLabel('Fret',{exact:true}).fill('3');await page.getByRole('button',{name:'Set note',exact:true}).click();await idle();
  await page.getByRole('button',{name:'Track 1: Guitar',exact:true}).click();
  await page.getByLabel('Beat',{exact:true}).fill('2');
  const note=page.getByText('7',{exact:true});await note.waitFor();await note.click();
  assert.equal(await page.getByLabel('Beat',{exact:true}).inputValue(),'1');
  assert.equal(await page.getByLabel('Fret',{exact:true}).inputValue(),'7');
  assert.equal((await snapshot()).project.edits.length,3);
  await page.screenshot({path:'.analysis/editor-two-tracks.png'});
  console.log('Native editor: two tracks, fret entry, real rendered note selection, native command history passed.');
} finally {await browser.close();}
