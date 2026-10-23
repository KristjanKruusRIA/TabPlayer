import {waitForWorkspaceIdle,clickWorkstationButton} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { importer,Settings } from '@coderline/alphatab';
import { launch,connect,stop } from './harness.mjs';

// ASCII tab import: File > Import ASCII tab… takes pasted drop-D tab with a title, explains what it read,
// and opens it as a new untitled GP-based tab with the named tuning, spacing rhythm and techniques.
// The imported score is editable and undoable; importing the same text again opens another tab.
const tab=['Title: Desktop riff','Tempo: 100','',
  'e|----------------|----------------|',
  'B|----------------|----------------|',
  'G|----------------|----------------|',
  'D|----------------|5h7-------------|',
  'A|----------------|----------------|',
  'D|0---0---3---5---|----------------|'].join('\n');
const id=launch({});let browser,page;
try{
  browser=await connect();page=browser.contexts()[0].pages()[0];await waitForWorkspaceIdle(page);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const library=page.getByRole('dialog',{name:'Library',exact:true});await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});
  const tabs=async()=>(await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('workspace_snapshot'))).documents.length;
  const before=await tabs();
  const importTab=async()=>{
    await clickWorkstationButton(page,'Import ASCII tab…',{waitForIdle:false});
    const dialog=page.getByRole('dialog',{name:'Import ASCII tab',exact:true}),area=dialog.getByRole('textbox',{name:'ASCII tab'});
    assert.equal(await area.evaluate(node=>node===document.activeElement),true,'The tab field takes focus.');
    await area.fill('not a tab');
    await dialog.getByRole('status').filter({hasText:'No tab lines were found'}).waitFor();
    assert.equal(await dialog.getByRole('button',{name:'Import',exact:true}).isDisabled(),true);
    await area.fill(tab);
    await dialog.getByRole('status').filter({hasText:/^2 measures, 6 strings tuned D A D G B E\.$/}).waitFor();
    // The dialog is modal: Tab stays inside it and the Ctrl+N shortcut does nothing.
    for(let press=0;press<4;press++)await page.keyboard.press('Shift+Tab');
    assert.equal(await dialog.evaluate(node=>node.contains(document.activeElement)),true,'Focus stays in the dialog.');
    const open=await tabs();await page.keyboard.press('Control+n');await waitForWorkspaceIdle(page);
    assert.equal(await tabs(),open);assert.equal(await area.inputValue(),tab);
    await dialog.getByRole('button',{name:'Import',exact:true}).click();
    await dialog.waitFor({state:'detached'});await waitForWorkspaceIdle(page);
    assert.deepEqual(await page.getByRole('alert').allTextContents(),[]);
  };
  await importTab();
  assert.equal(await tabs(),before+1);
  const imported=await readActiveDocument(page);
  assert.equal(imported.path,null,'The import is an untitled document.');
  assert.equal(imported.project.base.kind,'file');assert.equal(imported.project.base.filename,'Imported tab.gp');
  const score=importer.ScoreLoader.loadScoreFromBytes(Buffer.from(imported.project.base.bytesBase64,'base64'),new Settings());
  assert.equal(score.title,'Desktop riff');assert.equal(score.tempo,100);
  assert.deepEqual(score.tracks[0].staves[0].tuning,[64,59,55,50,45,38]);
  const beats=bar=>score.tracks[0].staves[0].bars[bar].voices[0].beats.map(beat=>[beat.duration,beat.notes.map(note=>`${note.string}:${note.fret}${note.isHammerPullOrigin?'h':''}`).join(' ')]);
  assert.deepEqual(beats(0),[[4,'1:0'],[4,'1:0'],[4,'1:3'],[4,'1:5']]);
  // The 7 sounds until the bar fills: a dotted half, then an eighth rest.
  assert.deepEqual(beats(1),[[8,'3:5h'],[2,'3:7'],[8,'']]);
  assert.equal(score.tracks[0].staves[0].bars[1].voices[0].beats[1].dots,1);
  await page.locator('[aria-label="Music notation"] svg').first().waitFor();
  // The import is an ordinary editable score.
  await page.getByRole('region',{name:'Score workspace'}).focus();await page.keyboard.press('Control+Shift+P');
  const palette=page.getByRole('dialog',{name:'Commands',exact:true});await palette.getByRole('combobox',{name:'Command'}).fill('fret 2');await page.keyboard.press('Enter');
  await palette.waitFor({state:'detached'});await waitForWorkspaceIdle(page);
  assert.deepEqual((await readActiveDocument(page)).project.edits.map(edit=>[edit.type,edit.fret]),[['setNote',2]]);
  await importTab();
  assert.equal(await tabs(),before+2,'The same name imports into another new tab.');
  assert.deepEqual((await readActiveDocument(page)).project.edits,[]);
  assert.deepEqual(errors,[]);
  console.log('ASCII import: pasted drop-D tab opened as an untitled, editable score with tuning, rhythm and hammer-on; a repeat import opened another tab.');
}catch(error){if(page)await page.screenshot({path:resolve('.analysis/parity/ascii-import-failure.png')}).catch(()=>{});throw error;}
finally{if(browser)await browser.close().catch(()=>{});stop(id);}
