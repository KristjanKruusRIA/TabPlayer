import {waitForWorkspaceIdle,clickWorkstationButton,clickWorkspaceCommand,revealLeftTask} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import { mkdir,readdir,readFile,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { exporter,model,Settings } from '@coderline/alphatab';
import { directory,launch,connect,stop } from './harness.mjs';

// Modulation effects: the Sound task's Vibrato, Phaser, Flanger and Tremolo blocks are recorded as track-sound
// edits, change the exported WAV against a dry render (tremolo as a measured 4 Hz level modulation), play live
// without errors, and Undo restores the dry sound.
const fixture=resolve(directory,'modulation-fixture.gp');
{
  const score=new model.Score(),track=new model.Track(),staff=new model.Staff();
  track.name='Guitar';track.playbackInfo.program=25;staff.stringTuning.tunings=[64,59,55,50,45,40];track.addStaff(staff);score.addTrack(track);
  // Sustained whole notes, so level and pitch modulation are measurable.
  for(const fret of [0,2]){score.addMasterBar(new model.MasterBar());const bar=new model.Bar(),voice=new model.Voice(),beat=new model.Beat();beat.duration=model.Duration.Whole;const note=new model.Note();note.string=5;note.fret=fret;beat.addNote(note);voice.addBeat(beat);bar.addVoice(voice);staff.addBar(bar);}
  score.finish(new Settings());await writeFile(fixture,new exporter.Gp7Exporter().export(score,new Settings()));
}
/** The left channel of a 16- or 24-bit stereo PCM WAV as numbers in -1..1. */
function leftChannel(bytes){
  assert.equal(bytes.subarray(0,4).toString(),'RIFF');const bits=bytes.readUInt16LE(34),width=bits/8,frames=bytes.readUInt32LE(40)/(2*width),out=new Float64Array(frames);
  for(let i=0;i<frames;i++){const at=44+i*2*width;out[i]=bits===16?bytes.readInt16LE(at)/32768:bytes.readIntLE(at,3)/8388608;}
  return out;
}
/** How strongly the level swings at `hz`, relative to its local average, over the first sustained note. */
function levelModulation(samples,hz){
  const size=480,levels=[];for(let at=24000;at+size<=96000;at+=size){let sum=0;for(let i=at;i<at+size;i++)sum+=samples[i]*samples[i];levels.push(Math.sqrt(sum/size));}
  const smooth=levels.map((_,i)=>{const near=levels.slice(Math.max(0,i-12),i+13);return near.reduce((a,b)=>a+b,0)/near.length;});
  let re=0,im=0;levels.forEach((level,i)=>{const v=level/smooth[i]-1,phase=2*Math.PI*hz*i*size/48000;re+=v*Math.cos(phase);im-=v*Math.sin(phase);});
  return 2*Math.hypot(re,im)/levels.length;
}
const difference=(a,b)=>{let sum=0,ref=0;for(let i=0;i<Math.min(a.length,b.length);i++){sum+=(a[i]-b[i])**2;ref+=a[i]**2;}return Math.sqrt(sum/ref);};
const folder=join(directory,`export-${Date.now()}-modulation`);await mkdir(folder,{recursive:true});
const id=launch({TABPLAYER_TEST_OPEN:fixture,TABPLAYER_TEST_EXPORT_DIR:folder});let browser;
try{
  browser=await connect();const page=browser.contexts()[0].pages()[0];await waitForWorkspaceIdle(page);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const library=page.getByRole('dialog',{name:'Library',exact:true});await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});
  const button=async name=>{await clickWorkstationButton(page,name,{waitForIdle:false});await waitForWorkspaceIdle(page);assert.deepEqual(await page.getByRole('alert').allTextContents(),[]);};
  const status=()=>page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('audio_status'));
  const waitStatus=async predicate=>{const deadline=Date.now()+20000;let last;while(Date.now()<deadline){last=await status();if(predicate(last))return last;await page.waitForTimeout(50);}throw new Error(`Native status timed out: ${JSON.stringify(last)}`);};
  await button('Open');await waitStatus(s=>s.ready&&!s.error&&s.generation===s.desiredGeneration);
  const exportWav=async name=>{
    await clickWorkspaceCommand(page,'Export score',{waitForIdle:false});
    const dialog=page.getByRole('dialog',{name:'Export score'});await dialog.getByLabel('Export format').selectOption('wav');
    await dialog.getByLabel('File name',{exact:true}).fill(name);await dialog.getByRole('button',{name:'Export',exact:true}).click();
    const deadline=Date.now()+120000;let file;
    while(Date.now()<deadline&&!(file=(await readdir(folder)).find(entry=>entry===`${name}.wav`))){
      const failure=dialog.getByRole('alert');if(await failure.count())throw new Error(await failure.innerText());await new Promise(r=>setTimeout(r,200));
    }
    assert.ok(file,`${name}.wav was written`);await dialog.waitFor({state:'detached',timeout:30000}).catch(()=>{});await waitForWorkspaceIdle(page);
    await new Promise(r=>setTimeout(r,300));return leftChannel(await readFile(join(folder,file)));
  };
  const dry=await exportWav('dry');
  await revealLeftTask(page,'Sound');const panel=page.getByRole('region',{name:'Track sound'});
  const block=async(name,enabled,values={})=>{
    const details=panel.locator('details.sound-block').filter({has:page.locator('.sound-block-name',{hasText:new RegExp(`^${name}$`)})});
    if(!await details.evaluate(node=>node.open))await details.locator('summary').click();
    for(const [label,value] of Object.entries(values)){const field=panel.getByLabel(`${name.toLowerCase()} ${label}`,{exact:true});await field.fill(String(value));await field.blur();await waitForWorkspaceIdle(page);}
    const box=panel.getByLabel(`Enable ${name.toLowerCase()}`,{exact:true});if(await box.isChecked()!==enabled){await box.click();await waitForWorkspaceIdle(page);await page.waitForFunction(([name,on])=>document.querySelector(`[aria-label="Enable ${name}"]`)?.checked===on,[name.toLowerCase(),enabled]);}
  };
  const results={};
  await block('Tremolo',true,{'Rate (Hz)':4,'Depth':0.9});
  const tremolo=await exportWav('tremolo');
  results.tremolo={dry:levelModulation(dry,4),wet:levelModulation(tremolo,4)};
  assert.ok(results.tremolo.dry<0.08,`dry level swing ${results.tremolo.dry}`);assert.ok(results.tremolo.wet>0.4,`tremolo level swing ${results.tremolo.wet}`);
  await block('Tremolo',false);
  for(const [name,values] of [['Vibrato',{'Depth (cents)':60}],['Phaser',{'Depth':1,'Mix':0.5}],['Flanger',{'Depth (ms)':3,'Mix':0.5}]]){
    await block(name,true,values);const wet=await exportWav(name.toLowerCase());results[name.toLowerCase()]=difference(dry,wet);
    assert.ok(results[name.toLowerCase()]>0.2,`${name} changes the render: ${results[name.toLowerCase()]}`);
    await block(name,false);
  }
  // Each control change is one recorded sound edit; the last ones enable and disable the flanger.
  const sounds=(await readActiveDocument(page)).project.edits.filter(edit=>edit.type==='setTrackSound');
  assert.ok(sounds.length>=12,`${sounds.length} sound edits`);
  assert.deepEqual([sounds.at(-2).sound.effects.flanger.enabled,sounds.at(-1).sound.effects.flanger.enabled],[true,false]);
  assert.equal(sounds.find(edit=>edit.sound.effects.tremolo.enabled).sound.effects.tremolo.depth,0.9);
  // The effect plays live, and Undo walks back to the enabled flanger.
  await block('Flanger',true);await button('Play');await waitStatus(s=>s.playing&&s.renderedFrames>4096&&s.outputPeak>.001&&!s.error);await button('Stop');
  await button('Undo');assert.equal(await panel.getByLabel('Enable flanger',{exact:true}).isChecked(),false);
  assert.deepEqual(errors,[]);
  await writeFile(join(directory,'modulation-effects-result.json'),JSON.stringify(results,null,2));
  console.log('Modulation effects passed:',JSON.stringify(results));
}finally{try{if(browser)await browser.close();}finally{stop(id);}}
