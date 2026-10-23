import {waitForWorkspaceIdle,clickWorkstationButton,clickWorkspaceCommand,revealLeftTask} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import { mkdir,readdir,readFile,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { exporter,model,Settings } from '@coderline/alphatab';
import { directory,launch,connect,stop } from './harness.mjs';

// Pitch effects: the Sound task's Octaver and Pitch shift blocks are recorded as track-sound edits; an exported
// WAV moves the dry render's strongest pitch up an octave with +12 semitones and adds the octave below with the
// octaver; both play live without errors, and Undo restores the previous setting.
const fixture=resolve(directory,'pitch-fixture.gp');
{
  const score=new model.Score(),track=new model.Track(),staff=new model.Staff();
  track.name='Guitar';track.playbackInfo.program=25;staff.stringTuning.tunings=[64,59,55,50,45,40];track.addStaff(staff);score.addTrack(track);
  for(const fret of [0,2]){score.addMasterBar(new model.MasterBar());const bar=new model.Bar(),voice=new model.Voice(),beat=new model.Beat();beat.duration=model.Duration.Whole;const note=new model.Note();note.string=5;note.fret=fret;beat.addNote(note);voice.addBeat(beat);bar.addVoice(voice);staff.addBar(bar);}
  score.finish(new Settings());await writeFile(fixture,new exporter.Gp7Exporter().export(score,new Settings()));
}
/** The left channel of a 16- or 24-bit stereo PCM WAV as numbers in -1..1, with its sample rate. */
function leftChannel(bytes){
  assert.equal(bytes.subarray(0,4).toString(),'RIFF');const rate=bytes.readUInt32LE(24),bits=bytes.readUInt16LE(34),width=bits/8,frames=bytes.readUInt32LE(40)/(2*width),out=new Float64Array(frames);
  for(let i=0;i<frames;i++){const at=44+i*2*width;out[i]=bits===16?bytes.readInt16LE(at)/32768:bytes.readIntLE(at,3)/8388608;}
  return {samples:out,rate};
}
/** Power within half a semitone of `hz` over the first sustained note, summed from Goertzel bins. */
function power({samples,rate},hz){
  const from=Math.round(rate*0.5),to=Math.round(rate*1.5),n=to-from;let sum=0;
  for(let f=hz*2**(-0.5/12);f<hz*2**(0.5/12);f+=rate/n){const k=2*Math.cos(2*Math.PI*f/rate);let s1=0,s2=0;for(let i=from;i<to;i++){const s0=samples[i]+k*s1-s2;s2=s1;s1=s0;}sum+=(s1*s1+s2*s2-k*s1*s2)/(n*n);}
  return sum;
}
/** RMS level over the first sustained note. */
const level=({samples,rate})=>{let sum=0;const from=Math.round(rate*0.5),to=Math.round(rate*1.5);for(let i=from;i<to;i++)sum+=samples[i]**2;return Math.sqrt(sum/(to-from));};
/** The equal-tempered semitone from about 55 Hz to 880 Hz that carries the most power. */
const strongest=render=>Array.from({length:49},(_,k)=>55*2**(k/12)).reduce((best,hz)=>{const p=power(render,hz);return p>best.p?{hz,p}:best;},{hz:0,p:-1}).hz;
const folder=join(directory,`export-${Date.now()}-pitch`);await mkdir(folder,{recursive:true});
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
  const dry=await exportWav('dry'),pitch=strongest(dry);
  await revealLeftTask(page,'Sound');const panel=page.getByRole('region',{name:'Track sound'});
  const block=async(name,label,enabled,values={})=>{
    const details=panel.locator('details.sound-block').filter({has:page.locator('.sound-block-name',{hasText:new RegExp(`^${name}$`)})});
    if(!await details.evaluate(node=>node.open))await details.locator('summary').click();
    for(const [field,value] of Object.entries(values)){const input=panel.getByLabel(`${label} ${field}`,{exact:true});await input.fill(String(value));await input.blur();await waitForWorkspaceIdle(page);}
    const box=panel.getByLabel(`Enable ${label}`,{exact:true});if(await box.isChecked()!==enabled){await box.click();await waitForWorkspaceIdle(page);await page.waitForFunction(([label,on])=>document.querySelector(`[aria-label="Enable ${label}"]`)?.checked===on,[label,enabled]);}
  };
  // How much the octave above (or below) carries relative to the dry render's strongest pitch.
  const above=render=>power(render,pitch*2)/power(render,pitch),below=render=>power(render,pitch/2)/power(render,pitch);
  await block('Pitch shift','pitch',true,{Semitones:12});
  const up=await exportWav('up-octave');
  await block('Pitch shift','pitch',false);
  // Switched off at its default +12, the pitch shift is back to defaults, so it is not written at all.
  assert.equal((await readActiveDocument(page)).project.edits.filter(edit=>edit.type==='setTrackSound').at(-1).sound.effects.pitch,undefined);
  await block('Octaver','octaver',true,{'Octave down':1,Direct:0});
  const down=await exportWav('octave-down');
  await block('Octaver','octaver',false);
  // Transpose the score up a fourth: the shift still adds an octave, at the same level, from the new pitch.
  const workspace=page.getByRole('region',{name:'Score workspace'});await workspace.focus();await page.keyboard.press('Control+a');
  for(let step=0;step<5;step++)await button('Up semitone');
  const dryT=await exportWav('dry-transposed'),pitchT=strongest(dryT);
  await block('Pitch shift','pitch',true);
  const upT=await exportWav('up-octave-transposed');
  const aboveT=render=>power(render,pitchT*2)/power(render,pitchT);
  const results={pitch,pitchT,dryAbove:above(dry),upAbove:above(up),dryBelow:below(dry),downBelow:below(down),dryAboveT:aboveT(dryT),upAboveT:aboveT(upT),levelDb:20*Math.log10(level(up)/level(dry)),levelDbT:20*Math.log10(level(upT)/level(dryT))};
  assert.ok(Math.abs(12*Math.log2(pitchT/pitch)-5)<0.5,`the score moved up a fourth: ${JSON.stringify(results)}`);
  assert.ok(results.upAboveT>results.dryAboveT*10,`+12 still adds the octave after transposing: ${JSON.stringify(results)}`);
  assert.ok(Math.abs(results.levelDb-results.levelDbT)<2,`the shifted level does not depend on transposition: ${JSON.stringify(results)}`);
  assert.ok(results.upAbove>results.dryAbove*10,`+12 moves the pitch up an octave: ${JSON.stringify(results)}`);
  assert.ok(results.downBelow>results.dryBelow*10,`the octaver adds the octave below: ${JSON.stringify(results)}`);
  // The panel recorded the interval and the octaver levels as sound edits.
  const sounds=(await readActiveDocument(page)).project.edits.filter(edit=>edit.type==='setTrackSound');
  const final=sounds.at(-1).sound.effects;
  assert.deepEqual([final.pitch.enabled,final.pitch.semitones,final.octaver.octaveDown,final.octaver.direct,final.octaver.enabled],[true,12,1,0,false]);
  await button('Play');await waitStatus(s=>s.playing&&s.renderedFrames>4096&&s.outputPeak>.001&&!s.error);await button('Stop');
  await button('Undo');assert.equal(await panel.getByLabel('Enable pitch',{exact:true}).isChecked(),false);
  assert.deepEqual(errors,[]);
  await writeFile(join(directory,'pitch-effects-result.json'),JSON.stringify(results,null,2));
  console.log('Pitch effects passed:',JSON.stringify(results));
}finally{try{if(browser)await browser.close();}finally{stop(id);}}
