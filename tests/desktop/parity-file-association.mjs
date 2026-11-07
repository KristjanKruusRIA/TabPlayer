import {waitForWorkspaceIdle} from './workstation-commands.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { exporter,model,Settings } from '@coderline/alphatab';
import { directory,launch,connect,stop } from './harness.mjs';

// File association (W13): TabPlayer opens the score files named on its command line, as a double-click on an associated
// file does when the app is closed. A second launch with a file, as a double-click does when the app is already open,
// hands the file to the running app and exits.
const folder=join(directory,`launch-${Date.now()}`);await mkdir(folder,{recursive:true});
async function score(title,file){
  const score=new model.Score(),track=new model.Track(),staff=new model.Staff();
  score.title=title;track.name='Guitar';staff.stringTuning.tunings=[64,59,55,50,45,40];track.addStaff(staff);score.addTrack(track);
  score.addMasterBar(new model.MasterBar());const bar=new model.Bar(),voice=new model.Voice(),beat=new model.Beat();beat.duration=model.Duration.Whole;
  const note=new model.Note();note.string=1;note.fret=3;beat.addNote(note);voice.addBeat(beat);bar.addVoice(voice);staff.addBar(bar);
  score.finish(new Settings());const path=join(folder,file);await writeFile(path,new exporter.Gp7Exporter().export(score,new Settings()));return path;
}
// A space in the name checks that the path is passed as one argument.
const first=await score('Launch First','launch first.gp'),second=await score('Launch Second','launch-second.gp');
const id=launch({},[first]);let browser;
try{
  browser=await connect();const page=browser.contexts()[0].pages()[0];await waitForWorkspaceIdle(page);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  // Each open document, named by the file it was opened from.
  const titles=async()=>(await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('workspace_snapshot'))).documents.map(document=>{const base=document.snapshot.project.base;return base.kind==='file'?base.filename.split(/[\\/]/).at(-1):base.kind;});
  const waitFor=async(predicate,what)=>{const deadline=Date.now()+30000;let last;while(Date.now()<deadline){last=await titles();if(predicate(last))return last;await page.waitForTimeout(100);}throw new Error(`${what} timed out: ${JSON.stringify(last)}`);};
  const opened=await waitFor(list=>list.includes('launch first.gp'),'The launch file opening');
  // The second launch must exit by itself, leaving its file to the running app.
  const exit=await new Promise((done,fail)=>{
    const child=spawn(resolve(directory,'tabplayer.exe'),[second],{stdio:'ignore',env:{...process.env,TABPLAYER_DESKTOP_TEST:'1'}});
    const timer=setTimeout(()=>{child.kill();fail(new Error('The second launch kept running'));},15000);
    child.on('exit',code=>{clearTimeout(timer);done(code);});child.on('error',fail);
  });
  const both=await waitFor(list=>list.includes('launch-second.gp'),'The second launch file opening');
  assert.equal(both.filter(title=>title==='launch first.gp').length,1,'the first file is open once');
  assert.deepEqual(await page.getByRole('alert').allTextContents(),[]);
  assert.deepEqual(errors,[]);
  const result={openedAtLaunch:opened,afterSecondLaunch:both,secondLaunchExit:exit};
  await writeFile(join(directory,'file-association-result.json'),JSON.stringify(result,null,2));
  console.log('File association passed:',JSON.stringify(result));
}finally{try{if(browser)await browser.close();}finally{stop(id);}}
