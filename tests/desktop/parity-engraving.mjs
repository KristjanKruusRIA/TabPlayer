import {waitForWorkspaceIdle,clickWorkstationButton,revealPlaybackControls,hidePlaybackControls} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {copyFileSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {importer,midi,Settings} from '@coderline/alphatab';
import {unzipSync} from 'fflate';
import {directory,launch,connect,stop} from './harness.mjs';
import {buildEngravingFixture,fixturePath} from './engraving-fixture.mjs';

await buildEngravingFixture();
const saved=resolve(directory,'gp8-engraving.tabplayer'),exported=resolve(directory,'gp8-engraving.gp'),pdf=`${exported}.pdf`;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),sourceHash=hash(readFileSync(fixturePath)),result={sourceHash};
const closeWelcome=async page=>{const library=page.getByRole('dialog',{name:'Library',exact:true});await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});};
let id=launch({TABPLAYER_TEST_OPEN:fixturePath,TABPLAYER_TEST_SAVE:saved,TABPLAYER_TEST_EXPORT:exported}),browser,page;
try{
  browser=await connect();page=browser.contexts()[0].pages()[0];await waitForWorkspaceIdle(page);await closeWelcome(page);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const snapshot=()=>readActiveDocument(page);
  const status=()=>page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('audio_status'));
  const waitStatus=async predicate=>{const deadline=Date.now()+15000;while(Date.now()<deadline){const value=await status();if(predicate(value))return value;await page.waitForTimeout(25);}throw new Error(`Audio status timeout: ${JSON.stringify(await status())}`);};
  const idle=async()=>{await waitForWorkspaceIdle(page);assert.deepEqual(await page.getByRole('alert').allTextContents(),[]);};
  const button=async name=>{await clickWorkstationButton(page,name,{waitForIdle:false});await idle();};
  const details=async name=>{await page.locator('summary').filter({hasText:new RegExp(`^${name}$`)}).first().evaluate(node=>{node.parentElement.open=true;});};
  const fill=(name,value)=>page.getByLabel(name,{exact:true}).fill(String(value));
  const combo=name=>page.getByRole('combobox',{name:new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?:\\s|$)`)});
  const choose=async(name,value)=>{const radioGroup=page.getByRole('radiogroup',{name});if(await radioGroup.count()){const map={'document':'Document notation','ScoreTab':'Score and tab','Score':'Score','Tab':'Tab'};await radioGroup.getByRole('radio',{name:map[value]||value,exact:true}).click();}else await combo(name).selectOption(value);};
  const musical=bytes=>{const score=importer.ScoreLoader.loadScoreFromBytes(bytes,new Settings()),file=new midi.MidiFile();new midi.MidiFileGenerator(score,new Settings(),new midi.AlphaSynthMidiFileHandler(file)).generate();return file.tracks.flatMap(track=>track.events).filter(event=>event instanceof midi.NoteOnEvent||event instanceof midi.NoteOffEvent).map(event=>({type:event.constructor.name,track:event.track,tick:event.tick,pitch:event.noteKey,velocity:event.noteVelocity??null}));};
  await button('Open');await waitStatus(value=>value.ready&&!value.error);await page.locator('[aria-label="Music notation"] svg').first().waitFor();
  await button('Export GP');const baselineGp=readFileSync(exported),baselineMusic=musical(baselineGp),baseline=await snapshot();
  await choose('Displayed tracks','all');await fill('Zoom (%)',127.5);assert.deepEqual((await snapshot()).project,baseline.project);
  await details('Visible tracks');await page.getByLabel('Show track 2: Grand Piano',{exact:true}).uncheck();await button('Track 2: Grand Piano');await page.getByRole('status').filter({hasText:'Grand Piano is hidden in score.'}).waitFor();
  await choose('Displayed tracks','all');await button('Track 1: Guitar6');assert.deepEqual((await snapshot()).project,baseline.project);
  await button('Presentation');await details('Engraving');await details('Stylesheet');await details('Staff profiles');
  // The fixture repeats measure 1, so Play from the score cursor needs a performed occurrence chosen first.
  await revealPlaybackControls(page);await details('Selected playback');await page.getByRole('combobox',{name:'Cursor occurrence',exact:true}).selectOption({label:'Measure 1, occurrence 1'});await hidePlaybackControls(page);
  await button('Play');const playing=await waitStatus(value=>value.playing&&value.tick>0),generation=playing.generation;assert.ok(Number.isInteger(generation)&&generation>0);
  await choose('Hide dynamics','true');await choose('Single track names','allSystems');await choose('Multiple track names','allSystems');await choose('Guitar6 notation profile','standardTab');await fill('System spacing (%)',125);await button('Apply engraving');
  const afterStyle=await status();assert.equal(afterStyle.generation,generation);assert.equal(afterStyle.playing,true);assert.ok(afterStyle.tick>=playing.tick);result.presentationKeepsNativeGeneration=generation;
  await details('Page layout');for(const [name,value]of [['Width (mm)',250],['Height (mm)',350],['Top margin (mm)',12],['Right margin (mm)',22],['Bottom margin (mm)',32],['Left margin (mm)',42],['Scale (%)',75]])await fill(name,value);
  await choose('PDF notation','document');await button('Apply page layout');assert.equal((await status()).generation,generation);await button('Stop');
  const authored=await snapshot();assert.deepEqual(authored.project.edits.map(edit=>edit.type),['setEngraving','setPageLayout']);
  await button('Undo');assert.equal((await snapshot()).project.edits.length,1);await button('Redo');assert.deepEqual((await snapshot()).project,authored.project);
  await button('Show instrument');
  for(const width of [960,1280,1600]){await page.setViewportSize({width,height:960});await page.waitForTimeout(150);assert.equal(await page.locator('.workstation-left').count(),1);assert.equal(await page.locator('.inspector').count(),1);await page.screenshot({path:resolve('.analysis/parity',`engraving-desktop-${width}.png`)});}
  await button('Export GP');const finalGp=readFileSync(exported);assert.deepEqual(musical(finalGp),baselineMusic);
  const beforeArchive=unzipSync(baselineGp),afterArchive=unzipSync(finalGp);for(const [name,bytes]of Object.entries(beforeArchive))if(name!=='Content/score.gpif')assert.equal(hash(afterArchive[name]),hash(bytes),`Untouched GP sibling ${name}`);
  result.unchangedMidiEvents=baselineMusic.length;result.sourceArchiveSiblingsPreserved=true;
  for(const variant of ['portrait','landscape']){
    if(variant==='landscape'){await fill('Width (mm)',350);await fill('Height (mm)',250);await choose('PDF notation','Score');await button('Apply page layout');}
    await clickWorkstationButton(page,'Export score',{waitForIdle:false});const dialog=page.getByRole('dialog',{name:'Export score'});await dialog.waitFor({state:'visible'});await dialog.getByLabel('Export format').selectOption('pdf');await dialog.getByRole('button',{name:'Export',exact:true}).click();await dialog.waitFor({state:'hidden',timeout:30000});await idle();
    const bytes=readFileSync(pdf);assert.equal(bytes.subarray(0,5).toString(),'%PDF-');copyFileSync(pdf,resolve('.analysis/parity',`engraving-${variant}.pdf`));result[`${variant}PdfBytes`]=bytes.length;
  }
  await button('Save');const stored=await snapshot();assert.equal(stored.dirty,false);assert.deepEqual(errors,[]);
  await browser.close();browser=null;stop(id);id=launch({TABPLAYER_TEST_OPEN:saved});browser=await connect();page=browser.contexts()[0].pages()[0];await waitForWorkspaceIdle(page);await closeWelcome(page);await button('Open');
  assert.deepEqual((await snapshot()).project,stored.project);assert.equal(await combo('Displayed tracks').inputValue(),'selected');assert.equal(await page.getByLabel('Zoom (%)',{exact:true}).inputValue(),'100');result.nativeRestartHistoryAndSessionReset=true;
  assert.equal(hash(readFileSync(fixturePath)),sourceHash);writeFileSync(resolve('.analysis/parity/native-engraving-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){if(page)await page.screenshot({path:resolve('.analysis/parity/native-engraving-failure.png')});throw error;}
finally{if(browser)await browser.close();stop(id);}
