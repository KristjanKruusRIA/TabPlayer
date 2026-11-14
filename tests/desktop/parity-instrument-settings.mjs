import { waitForWorkspaceIdle,clickWorkstationButton } from './workstation-commands.mjs';
import assert from 'node:assert/strict';
import { existsSync,mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { exporter,model,Settings } from '@coderline/alphatab';
import { directory,launch,connect,stop } from './harness.mjs';

// The instrument view options live in the app's native settings and the keyboard panel in the document's view:
// both come back after the app is restarted with a fresh WebView profile (so an empty localStorage). The app
// runs with its own data and session folders, never the user's.
const stamp=Date.now(),session=resolve(directory,`instrument-settings-session-${stamp}`),appData=resolve(directory,`instrument-settings-data-${stamp}`);
mkdirSync(session,{recursive:true});mkdirSync(appData,{recursive:true});
const fixture=resolve(directory,'instrument-settings-fixture.gp');
{
  const score=new model.Score(),track=new model.Track(),staff=new model.Staff();
  track.name='Guitar';track.playbackInfo.program=25;staff.stringTuning.tunings=[64,59,55,50,45,40];track.addStaff(staff);score.addTrack(track);
  score.addMasterBar(new model.MasterBar());const bar=new model.Bar(),voice=new model.Voice();
  for(const fret of [0,1,2,3]){const value=new model.Beat();value.duration=4;const note=new model.Note();note.string=1;note.fret=fret;value.addNote(note);voice.addBeat(value);}
  bar.addVoice(voice);staff.addBar(bar);score.finish(new Settings());writeFileSync(fixture,new exporter.Gp7Exporter().export(score,new Settings()));
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let id=null,browser=null,page=null;const result={profiles:[],fresh:[],checks:[]};
const check=(name,value)=>{result.checks.push({name,value});console.log(`${value?'ok':'FAIL'}: ${name}`);assert.ok(value,name);};
async function start({restore}){
  const profile=resolve(directory,`instrument-settings-profile-${Date.now()}`);const fresh=!existsSync(profile)&&!result.profiles.includes(profile);result.profiles.push(profile);result.fresh.push(fresh);
  id=launch({TABPLAYER_TEST_OPEN:fixture,TABPLAYER_TEST_SESSION_DIR:session,TABPLAYER_TEST_APP_DATA_DIR:appData,WEBVIEW2_USER_DATA_FOLDER:profile});
  browser=await connect();page=browser.contexts()[0].pages()[0];page.setDefaultTimeout(30000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));result.errors=errors;
  if(restore){const dialog=page.getByRole('dialog',{name:'Recover unsaved work?',exact:true});await dialog.waitFor({timeout:30000});await dialog.getByRole('button',{name:'Restore',exact:true}).click();}
  else{await waitForWorkspaceIdle(page);const library=page.getByRole('dialog',{name:'Library',exact:true});await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});}
  await waitForWorkspaceIdle(page);
}
async function end(){const owned=browser,pid=id;browser=null;page=null;id=null;try{if(owned)await owned.close();}finally{if(pid!==null)stop(pid);}await sleep(1500);}
try{
  await start({restore:false});
  await clickWorkstationButton(page,'Open',{waitForIdle:false});await waitForWorkspaceIdle(page);await page.locator('[aria-label="Music notation"] svg').first().waitFor();
  await clickWorkstationButton(page,'Show instrument');
  const view=page.getByRole('region',{name:'Instrument view'});
  await view.getByRole('checkbox',{name:'Left-handed'}).check();
  await view.getByRole('combobox',{name:'Show'}).selectOption('bar');
  const settingsFile=resolve(appData,'app-settings.json');
  const deadline=Date.now()+15000;let stored=null;
  while(Date.now()<deadline&&!stored){try{const value=JSON.parse(readFileSync(settingsFile,'utf8'));if(value.instrumentView?.leftHanded===true&&value.instrumentView?.focus==='bar')stored=value;}catch{}if(!stored)await sleep(200);}
  check('native settings file holds the choices',!!stored);result.settings=stored;
  await page.getByRole('navigation',{name:/views/i}).getByRole('button',{name:'Keyboard',exact:true}).click();
  await page.getByRole('region',{name:'Keyboard panel'}).waitFor();
  // Wait for the recovery checkpoint to hold the keyboard panel in this document's view.
  const manifest=resolve(session,'recovery-v1','manifest.json');let holds=false;const until=Date.now()+30000;
  while(Date.now()<until&&!holds){try{const m=JSON.parse(readFileSync(manifest,'utf8')),env=JSON.parse(readFileSync(resolve(session,'recovery-v1',`checkpoint-${m.current.generation}.json`),'utf8'));holds=env.documents.some(d=>d.view?.keyboardVisible===true&&d.view?.instrumentVisible===false);}catch{}if(!holds)await sleep(500);}
  check('recovery checkpoint holds the keyboard panel for the document',holds);
  await end();

  // A new WebView profile: nothing in localStorage. The app and its data folder are the same.
  await start({restore:true});
  check('the second run started with a WebView profile folder that did not exist before',result.fresh.length===2&&result.fresh.every(Boolean)&&result.profiles[0]!==result.profiles[1]);
  const keyboardPanel=page.getByRole('region',{name:'Keyboard panel'});await keyboardPanel.waitFor();check('the keyboard panel is back for the restored document, and it is the only dock panel',await keyboardPanel.isVisible()&&await page.getByRole('region',{name:'Instrument view'}).count()===0);
  await page.getByRole('navigation',{name:/views/i}).getByRole('button',{name:'Instrument',exact:true}).click();
  const again=page.getByRole('region',{name:'Instrument view'});await again.waitFor();
  const left=again.getByRole('checkbox',{name:'Left-handed'});
  const deadline2=Date.now()+10000;while(Date.now()<deadline2&&!(await left.isChecked()))await sleep(200);
  check('left-handed is still set after the restart with a fresh profile',await left.isChecked());
  check('Show focus is still the selected bar',(await again.getByRole('combobox',{name:'Show'}).inputValue())==='bar');
  check('the browser copy was refilled from the native settings',await page.evaluate(()=>JSON.parse(localStorage.getItem('tabplayer.instrumentView')??'{}').leftHanded===true));
  check('no page errors',result.errors.length===0);
  writeFileSync(resolve(directory,'instrument-settings-result.json'),JSON.stringify(result,null,2));
  console.log('Instrument settings passed');
}finally{try{await end();}catch{}}
