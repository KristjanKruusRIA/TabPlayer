import {waitForWorkspaceIdle,clickWorkstationButton} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import { readFileSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { exporter,importer,model,Settings } from '@coderline/alphatab';
import { directory,launch,connect,stop } from './harness.mjs';

// New score defaults: saved author details fill a new score as non-undoable baseline metadata that
// survives GP export, while the opened file keeps its own details.
const fixture=resolve(directory,'author-defaults-fixture.gp'),exported=resolve(directory,'gp8-author-defaults'),gp=`${exported}.gp`;
{
  const score=new model.Score(),track=new model.Track(),staff=new model.Staff();score.artist='Fixture Artist';score.tab='Fixture Tab';
  track.name='Guitar';track.playbackInfo.program=25;staff.stringTuning.tunings=[64,59,55,50,45,40];track.addStaff(staff);score.addTrack(track);
  score.addMasterBar(new model.MasterBar());const bar=new model.Bar(),voice=new model.Voice(),beat=new model.Beat();bar.clef=model.Clef.G2;beat.duration=1;beat.isEmpty=false;voice.addBeat(beat);bar.addVoice(voice);staff.addBar(bar);
  score.finish(new Settings());writeFileSync(fixture,new exporter.Gp7Exporter().export(score,new Settings()));
}
const defaults={'Default artist':'The Band','Default lyrics author':'Ann Lyric','Default music author':'Ben Tune','Default transcriber':'Cy Transcriber','Default copyright':'© 2026 The Band'};
const id=launch({TABPLAYER_TEST_OPEN:fixture,TABPLAYER_TEST_EXPORT:exported});let browser,page;
try{
  browser=await connect();page=browser.contexts()[0].pages()[0];await waitForWorkspaceIdle(page);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const library=page.getByRole('dialog',{name:'Library',exact:true});await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});
  const idle=async()=>{await waitForWorkspaceIdle(page);assert.deepEqual(await page.getByRole('alert').allTextContents(),[]);};
  const button=async name=>{await clickWorkstationButton(page,name,{waitForIdle:false});await idle();};
  const details=name=>page.locator('summary').filter({hasText:name}).first().evaluate(node=>{for(let item=node.parentElement;item;item=item.parentElement)if(item.tagName==='DETAILS')item.open=true;});
  const value=label=>page.getByLabel(label,{exact:true}).inputValue();
  await button('Open');await page.locator('[aria-label="Music notation"] svg').first().waitFor();

  await details('New score defaults');
  for(const [label,text] of Object.entries(defaults))await page.getByLabel(label,{exact:true}).fill(text);
  await page.getByRole('button',{name:'Save defaults',exact:true}).click();
  await page.getByText('Saved. Scores you create with New start with these details.',{exact:true}).waitFor();
  assert.deepEqual(JSON.parse(await page.evaluate(()=>localStorage.getItem('tabplayer.authorDefaults'))),{artist:'The Band',words:'Ann Lyric',music:'Ben Tune',tab:'Cy Transcriber',copyright:'© 2026 The Band'});
  await details('Song metadata');await details('Score information');
  assert.equal(await value('Transcriber'),'Fixture Tab','Saving defaults leaves the open score alone.');assert.equal(await value('Artist'),'Fixture Artist');
  assert.equal((await readActiveDocument(page)).project.edits.length,0);

  await button('New');await page.waitForFunction(()=>document.querySelector('.statusbar')?.textContent?.startsWith('New score'));
  await details('Song metadata');await details('Score information');
  await page.waitForFunction(()=>[...document.querySelectorAll('label')].some(label=>label.textContent.startsWith('Transcriber')&&label.querySelector('input')?.value==='Cy Transcriber'));
  assert.deepEqual([await value('Artist'),await value('Lyrics author'),await value('Music author'),await value('Copyright'),await value('Title')],['The Band','Ann Lyric','Ben Tune','© 2026 The Band','Untitled']);
  const project=(await readActiveDocument(page)).project;
  assert.deepEqual(project.edits,[],'Defaults are not an undo step.');
  assert.deepEqual(project.baselineEdits.map(edit=>[edit.type,edit.fields.tab]),[['setScoreMetadata','Cy Transcriber']]);
  assert.equal(project.base.artist,'The Band');
  assert.equal(await page.getByRole('button',{name:'Undo',exact:true}).first().isDisabled(),true);

  await button('Export GP');
  const reopened=importer.ScoreLoader.loadScoreFromBytes(readFileSync(gp),new Settings());
  assert.deepEqual([reopened.artist,reopened.words,reopened.music,reopened.tab,reopened.copyright],['The Band','Ann Lyric','Ben Tune','Cy Transcriber','© 2026 The Band']);
  assert.deepEqual(errors,[]);
  console.log('author defaults: saved defaults fill a new score as baseline metadata, survive GP export, and leave the opened file alone.');
}catch(error){if(page)await page.screenshot({path:resolve('.analysis/parity/author-defaults-failure.png')}).catch(()=>{});throw error;}
finally{if(browser)await browser.close().catch(()=>{});stop(id);}
