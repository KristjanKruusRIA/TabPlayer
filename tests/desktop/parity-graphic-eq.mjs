import {waitForWorkspaceIdle,clickWorkstationButton,clickWorkspaceCommand,revealLeftTask} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import { mkdir,readdir,readFile,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { exporter,model,Settings } from '@coderline/alphatab';
import { directory,launch,connect,stop } from './harness.mjs';

// Graphic EQ: the Sound task's Graphic EQ block, after the EQ, records its ten bands and its level as track-sound edits.
// In exported WAVs of a low chord, lifting the 1 kHz band lifts that octave and leaves the others, cutting the 125 Hz
// band cuts that octave, and the level scales the whole sound. It plays live without errors, and Undo restores the
// previous level.
const fixture=resolve(directory,'graphic-eq-fixture.gp');
{
  const score=new model.Score(),track=new model.Track(),staff=new model.Staff();
  track.name='Guitar';track.playbackInfo.program=25;staff.stringTuning.tunings=[64,59,55,50,45,40];track.addStaff(staff);score.addTrack(track);
  // A sustained E2 and E3 together, then a bar of rest.
  for(let index=0;index<2;index++){
    score.addMasterBar(new model.MasterBar());const bar=new model.Bar(),voice=new model.Voice(),beat=new model.Beat();beat.duration=model.Duration.Whole;
    if(index===0)for(const [string,fret] of [[1,0],[3,2]]){const note=new model.Note();note.string=string;note.fret=fret;beat.addNote(note);}
    voice.addBeat(beat);bar.addVoice(voice);staff.addBar(bar);
  }
  score.finish(new Settings());await writeFile(fixture,new exporter.Gp7Exporter().export(score,new Settings()));
}
/** Both channels of a 16- or 24-bit stereo PCM WAV as numbers in -1..1, with the sample rate. */
function channels(bytes){
  assert.equal(bytes.subarray(0,4).toString(),'RIFF');const rate=bytes.readUInt32LE(24),bits=bytes.readUInt16LE(34),width=bits/8,frames=bytes.readUInt32LE(40)/(2*width),out=[new Float64Array(frames),new Float64Array(frames)];
  for(let i=0;i<frames;i++)for(let c=0;c<2;c++){const at=44+(i*2+c)*width;out[c][i]=bits===16?bytes.readInt16LE(at)/32768:bytes.readIntLE(at,3)/8388608;}
  return {samples:out,rate};
}
const span=(rate,from,to)=>[Math.round(rate*from),Math.round(rate*to)];
/** RMS of both channels between two times in seconds. */
const rms=({samples,rate},from,to)=>{const [a,b]=span(rate,from,to);let sum=0;for(const channel of samples)for(let i=a;i<b;i++)sum+=channel[i]**2;return Math.sqrt(sum/(2*(b-a)));};
/** The mid channel's power spectrum between two times in seconds, averaged over Hann-windowed 4096-frame FFTs. */
function spectrum({samples:[l,r],rate},from,to){
  const size=4096,[a,b]=span(rate,from,to),power=new Float64Array(size/2);
  for(let start=a;start+size<=b;start+=size/2){
    const re=new Float64Array(size),im=new Float64Array(size);
    for(let i=0;i<size;i++)re[i]=(l[start+i]+r[start+i])/2*(0.5-0.5*Math.cos(2*Math.PI*i/size));
    for(let i=1,j=0;i<size;i++){let bit=size>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;if(i<j){[re[i],re[j]]=[re[j],re[i]];[im[i],im[j]]=[im[j],im[i]];}}
    for(let length=2;length<=size;length<<=1){const angle=-2*Math.PI/length;for(let i=0;i<size;i+=length)for(let k=0;k<length/2;k++){const wr=Math.cos(angle*k),wi=Math.sin(angle*k),xr=re[i+k+length/2]*wr-im[i+k+length/2]*wi,xi=re[i+k+length/2]*wi+im[i+k+length/2]*wr;re[i+k+length/2]=re[i+k]-xr;im[i+k+length/2]=im[i+k]-xi;re[i+k]+=xr;im[i+k]+=xi;}}
    for(let k=0;k<size/2;k++)power[k]+=re[k]**2+im[k]**2;
  }
  return {power,binHz:rate/size};
}
/** Power in the octave centred on a frequency. */
const octave=({power,binHz},hz)=>{let sum=0;for(let k=Math.ceil(hz/Math.SQRT2/binHz);k<=Math.floor(hz*Math.SQRT2/binHz);k++)sum+=power[k];return sum;};
const folder=join(directory,`export-${Date.now()}-graphic-eq`);await mkdir(folder,{recursive:true});
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
    await new Promise(r=>setTimeout(r,300));return channels(await readFile(join(folder,file)));
  };
  const dry=await exportWav('dry');
  await revealLeftTask(page,'Sound');const panel=page.getByRole('region',{name:'Track sound'});
  const details=panel.locator('details.sound-block').filter({has:page.locator('.sound-block-name',{hasText:/^Graphic EQ$/})});
  if(!await details.evaluate(node=>node.open))await details.locator('summary').click();
  const band=async(name,value)=>{await panel.getByLabel(`Graphic EQ ${name} Hz (dB)`,{exact:true}).fill(String(value));await waitForWorkspaceIdle(page);};
  const box=panel.getByLabel('Enable graphicEq',{exact:true});
  await box.click();await waitForWorkspaceIdle(page);assert.equal(await box.isChecked(),true);
  const flat=await exportWav('flat');
  await band('1k',12);const boost=await exportWav('boost-1k');
  await band('1k',0);await band('125',-12);const cut=await exportWav('cut-125');
  await band('125',0);await panel.getByLabel('graphicEq Level (dB)',{exact:true}).fill('-6');await waitForWorkspaceIdle(page);const quieter=await exportWav('level-down');
  // Each octave's level against the dry export's, from 0.1 to 1.5 s, at 125 Hz, 1 kHz and 4 kHz, and the whole level.
  // The chord's partials near 125 Hz are at 82 and 165 Hz, off the band's centre, so its octave falls less than 12 dB.
  const drySpectrum=spectrum(dry,0.1,1.5);
  const change=(render,hz)=>10*Math.log10(octave(spectrum(render,0.1,1.5),hz)/octave(drySpectrum,hz));
  const measure=render=>({low:change(render,125),mid:change(render,1000),high:change(render,4000),level:20*Math.log10(rms(render,0.1,1.5)/rms(dry,0.1,1.5))});
  const results={flat:measure(flat),boost:measure(boost),cut:measure(cut),quieter:measure(quieter)};
  const text=JSON.stringify(results);
  for(const value of Object.values(results.flat))assert.ok(Math.abs(value)<0.1,`a flat graphic EQ leaves the sound: ${text}`);
  assert.ok(results.boost.mid>8&&Math.abs(results.boost.low)<1.5,`the 1 kHz band lifts its octave only: ${text}`);
  assert.ok(results.cut.low<-5&&Math.abs(results.cut.mid)<1.5&&Math.abs(results.cut.high)<1,`the 125 Hz band cuts its octave only: ${text}`);
  assert.ok(Math.abs(results.quieter.level+6)<0.3,`the level scales the sound: ${text}`);
  const final=(await readActiveDocument(page)).project.edits.filter(edit=>edit.type==='setTrackSound').at(-1).sound.effects.graphicEq;
  assert.deepEqual(final,{enabled:true,gainsDb:Array(10).fill(0),levelDb:-6});
  await button('Play');await waitStatus(s=>s.playing&&s.renderedFrames>4096&&s.outputPeak>.001&&!s.error);await button('Stop');
  await button('Undo');assert.equal(await panel.getByLabel('graphicEq Level (dB)',{exact:true}).inputValue(),'0');
  assert.deepEqual(errors,[]);
  await writeFile(join(directory,'graphic-eq-result.json'),JSON.stringify(results,null,2));
  console.log('Graphic EQ passed:',text);
}finally{try{if(browser)await browser.close();}finally{stop(id);}}
