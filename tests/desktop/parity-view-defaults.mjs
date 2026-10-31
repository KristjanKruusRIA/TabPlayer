import {waitForWorkspaceIdle,clickWorkstationButton} from './workstation-commands.mjs';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { exporter,model,Settings } from '@coderline/alphatab';
import { directory,launch,connect,stop } from './harness.mjs';

// Default view: the current view (130%, all tracks) is captured, switched to vertical page and saved.
// The open score keeps its view; a new score starts in the saved one; reopening the open file keeps its own view.
const fixture=resolve(directory,'view-defaults-fixture.gp');
{
  const score=new model.Score();
  for(const name of ['Lead','Rhythm']){
    const track=new model.Track(),staff=new model.Staff();track.name=name;track.playbackInfo.program=25;staff.stringTuning.tunings=[64,59,55,50,45,40];track.addStaff(staff);score.addTrack(track);
  }
  for(let index=0;index<2;index++){score.addMasterBar(new model.MasterBar());for(const track of score.tracks){const bar=new model.Bar(),voice=new model.Voice(),beat=new model.Beat();bar.clef=model.Clef.G2;beat.duration=1;const note=new model.Note();note.string=1;note.fret=index;beat.addNote(note);voice.addBeat(beat);bar.addVoice(voice);track.staves[0].addBar(bar);}}
  score.finish(new Settings());writeFileSync(fixture,new exporter.Gp7Exporter().export(score,new Settings()));
}
const id=launch({TABPLAYER_TEST_OPEN:fixture});let browser,page;
try{
  browser=await connect();page=browser.contexts()[0].pages()[0];await waitForWorkspaceIdle(page);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const library=page.getByRole('dialog',{name:'Library',exact:true});await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});
  const idle=async()=>{await waitForWorkspaceIdle(page);assert.deepEqual(await page.getByRole('alert').allTextContents(),[]);};
  const button=async name=>{await clickWorkstationButton(page,name,{waitForIdle:false});await idle();};
  const control=label=>['Display mode','Displayed tracks','Default layout','Default zoom mode','Default tracks'].includes(label)?page.getByRole('combobox',{name:new RegExp(`^${label}`)}):page.getByLabel(label,{exact:true});
  const view=async()=>[await control('Display mode').inputValue(),await control('Zoom (%)').inputValue(),await control('Displayed tracks').inputValue()];
  const settled=async expected=>{await page.waitForFunction(async expected=>{const read=label=>[...document.querySelectorAll('label')].find(node=>node.firstChild?.textContent===label)?.querySelector('select,input')?.value;return JSON.stringify([read('Display mode'),read('Zoom (%)'),read('Displayed tracks')])===JSON.stringify(expected);},expected);};
  await button('Open');await page.locator('[aria-label="Music notation"] svg').first().waitFor();
  assert.deepEqual(await view(),['parchment','100','selected']);

  await control('Zoom (%)').fill('130');await control('Displayed tracks').selectOption('all');await settled(['parchment','130','all']);
  await page.locator('summary').filter({hasText:/^Default view$/}).first().evaluate(node=>{for(let item=node.parentElement;item;item=item.parentElement)if(item.tagName==='DETAILS')item.open=true;});
  await page.getByRole('button',{name:'Use current view',exact:true}).click();
  assert.deepEqual([await control('Default layout').inputValue(),await control('Default zoom (%)').inputValue(),await control('Default tracks').inputValue()],['parchment','130','all']);
  await control('Default layout').selectOption('verticalPage');
  await page.getByRole('button',{name:'Save default view',exact:true}).click();
  await page.getByText('Saved. Scores opened or created from now on start in this view.',{exact:true}).waitFor();
  assert.deepEqual(JSON.parse(await page.evaluate(()=>localStorage.getItem('tabplayer.viewDefaults'))),{layout:'verticalPage',zoomMode:'manual',zoom:130,tracks:'all'});
  assert.deepEqual(await view(),['parchment','130','all'],'Saving a default leaves the open score view alone.');

  await button('New');await page.waitForFunction(()=>document.querySelector('.statusbar')?.textContent?.startsWith('New score'));
  await settled(['verticalPage','130','all']);

  await button('Open');await settled(['parchment','130','all']);
  await page.waitForFunction(async()=>{const status=await window.__TAURI_INTERNALS__.invoke('audio_status');if(status.error)throw new Error(status.error);return status.ready;},undefined,{timeout:20000});
  assert.deepEqual(errors,[]);
  console.log('view defaults: current view captured and saved as vertical page; open score kept its view, New started in the default, reopening kept the file view.');
}catch(error){if(page)await page.screenshot({path:resolve('.analysis/parity/view-defaults-failure.png')}).catch(()=>{});throw error;}
finally{if(browser)await browser.close().catch(()=>{});stop(id);}
