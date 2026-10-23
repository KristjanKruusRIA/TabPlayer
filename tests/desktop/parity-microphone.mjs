import {waitForWorkspaceIdle,clickWorkstationButton,clickWorkspaceCommand,revealLeftTask} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import { mkdir,readdir,readFile,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { exporter,model,Settings } from '@coderline/alphatab';
import { directory,launch,connect,stop } from './harness.mjs';

// Microphone: the Sound task's Microphone block, first in the chain, records its placement and output as track-sound
// edits. In exported WAVs of a low chord, a close microphone lifts the lows, an edge one thins them and adds
// presence, a room one dulls the highs and spreads the sound between the channels, and mono output folds the
// channels back into one. It plays live without errors, and Undo restores the previous output.
const fixture=resolve(directory,'microphone-fixture.gp');
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
/** The correlation of the two channels between two times in seconds. */
const correlation=({samples:[l,r],rate},from,to)=>{const [a,b]=span(rate,from,to);let lr=0,ll=0,rr=0;for(let i=a;i<b;i++){lr+=l[i]*r[i];ll+=l[i]**2;rr+=r[i]**2;}return lr/Math.sqrt(ll*rr);};
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
const folder=join(directory,`export-${Date.now()}-microphone`);await mkdir(folder,{recursive:true});
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
  const details=panel.locator('details.sound-block').filter({has:page.locator('.sound-block-name',{hasText:/^Microphone$/})});
  if(!await details.evaluate(node=>node.open))await details.locator('summary').click();
  const choose=async(name,value)=>{await panel.getByLabel(`Microphone ${name}`,{exact:true}).selectOption(value);await waitForWorkspaceIdle(page);};
  const box=panel.getByLabel('Enable microphone',{exact:true});
  await box.click();await waitForWorkspaceIdle(page);assert.equal(await box.isChecked(),true);
  const renders={};
  for(const placement of ['close','edge','room']){await choose('placement',placement);renders[placement]=await exportWav(placement);}
  await choose('output','mono');renders.roomMono=await exportWav('room-mono');
  // Each octave's level against the dry export's, from 0.1 to 1.5 s, as the lowest lows (80 Hz, the E2's
  // fundamental), the lows (125 Hz) and the highs (5 kHz) tilt
  // against 1 kHz; and how alike the two channels are.
  const drySpectrum=spectrum(dry,0.1,1.5);
  const change=(render,hz)=>10*Math.log10(octave(spectrum(render,0.1,1.5),hz)/octave(drySpectrum,hz));
  const measure=render=>({lowest:change(render,80)-change(render,1000),lows:change(render,125)-change(render,1000),highs:change(render,5000)-change(render,1000),correlation:correlation(render,0.1,1.5)});
  const results={dry:{correlation:correlation(dry,0.1,1.5)},...Object.fromEntries(Object.entries(renders).map(([name,render])=>[name,measure(render)]))};
  const text=JSON.stringify(results);
  assert.ok(results.close.lows>2,`a close microphone lifts the lows: ${text}`);
  assert.ok(results.edge.lows<-2&&results.edge.highs>2,`an edge microphone thins the lows and adds presence: ${text}`);
  assert.ok(results.room.highs<-1.5,`a room microphone dulls the highs: ${text}`);
  assert.ok(results.room.correlation<0.9&&results.room.correlation<results.dry.correlation-0.05,`a room microphone spreads the sound: ${text}`);
  assert.ok(results.roomMono.correlation>0.9999,`mono output folds the channels into one: ${text}`);
  // The panel recorded the placement and output as sound edits.
  const final=(await readActiveDocument(page)).project.edits.filter(edit=>edit.type==='setTrackSound').at(-1).sound.effects.microphone;
  assert.deepEqual(final,{enabled:true,placement:'room',output:'mono'});
  await button('Play');await waitStatus(s=>s.playing&&s.renderedFrames>4096&&s.outputPeak>.001&&!s.error);await button('Stop');
  await button('Undo');assert.equal(await panel.getByLabel('Microphone output',{exact:true}).inputValue(),'stereo');
  assert.deepEqual(errors,[]);
  await writeFile(join(directory,'microphone-result.json'),JSON.stringify(results,null,2));
  console.log('Microphone passed:',text);
}finally{try{if(browser)await browser.close();}finally{stop(id);}}
