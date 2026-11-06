import {waitForWorkspaceIdle,clickWorkstationButton,clickWorkspaceCommand} from './workstation-commands.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir,readdir,readFile,stat,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { exporter,model,Settings } from '@coderline/alphatab';
import { directory,launch,connect,stop } from './harness.mjs';

// OGG export: the Export dialog's File type writes mixed audio and stems as Ogg Vorbis. Symphonia's Vorbis decoder,
// run through the decode_audio example (DECODE_AUDIO names a built one; otherwise cargo builds it), reads the OGG of a
// chord at the WAV's rate and exact length, and close to the WAV's samples, which the test reads itself.
const fixture=resolve(directory,'ogg-export-fixture.gp');
{
  const score=new model.Score(),track=new model.Track(),staff=new model.Staff();
  track.name='Guitar';track.playbackInfo.program=25;staff.stringTuning.tunings=[64,59,55,50,45,40];track.addStaff(staff);score.addTrack(track);
  // A sustained E2, B2 and E3 together, then a bar of rest.
  for(let index=0;index<2;index++){
    score.addMasterBar(new model.MasterBar());const bar=new model.Bar(),voice=new model.Voice(),beat=new model.Beat();beat.duration=model.Duration.Whole;
    if(index===0)for(const [string,fret] of [[1,0],[2,2],[3,2]]){const note=new model.Note();note.string=string;note.fret=fret;beat.addNote(note);}
    voice.addBeat(beat);bar.addVoice(voice);staff.addBar(bar);
  }
  score.finish(new Settings());await writeFile(fixture,new exporter.Gp7Exporter().export(score,new Settings()));
}
/** Symphonia's reading of `file`: its stream parameters and its samples as `bits`-bit integers. */
async function decode(file,bits){
  const out=`${file}.samples`,args=[file,String(bits),out];
  const json=process.env.DECODE_AUDIO?execFileSync(process.env.DECODE_AUDIO,args,{encoding:'utf8'})
    :execFileSync('cargo',['run','--quiet','--release','--example','decode_audio','--',...args],{cwd:resolve('src-tauri'),encoding:'utf8'});
  const bytes=await readFile(out),samples=new Int32Array(bytes.length/4);for(let i=0;i<samples.length;i++)samples[i]=bytes.readInt32LE(i*4);
  return {...JSON.parse(json),samples};
}
/** The parameters and samples of a 16- or 24-bit stereo WAV. */
function wav(bytes){
  assert.equal(bytes.subarray(0,4).toString(),'RIFF');const bits=bytes.readUInt16LE(34),width=bits/8,count=bytes.readUInt32LE(40)/width,samples=new Int32Array(count);
  for(let i=0;i<count;i++)samples[i]=bits===16?bytes.readInt16LE(44+i*width):bytes.readIntLE(44+i*width,3);
  return {sampleRate:bytes.readUInt32LE(24),channels:bytes.readUInt16LE(22),bits,samples};
}
const folder=join(directory,`export-${Date.now()}-ogg`);await mkdir(folder,{recursive:true});
const id=launch({TABPLAYER_TEST_OPEN:fixture,TABPLAYER_TEST_EXPORT_DIR:folder});let browser;
try{
  browser=await connect();const page=browser.contexts()[0].pages()[0];await waitForWorkspaceIdle(page);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const library=page.getByRole('dialog',{name:'Library',exact:true});await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});
  const button=async name=>{await clickWorkstationButton(page,name,{waitForIdle:false});await waitForWorkspaceIdle(page);assert.deepEqual(await page.getByRole('alert').allTextContents(),[]);};
  const status=()=>page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('audio_status'));
  const waitStatus=async predicate=>{const deadline=Date.now()+20000;let last;while(Date.now()<deadline){last=await status();if(predicate(last))return last;await page.waitForTimeout(50);}throw new Error(`Native status timed out: ${JSON.stringify(last)}`);};
  await button('Open');await waitStatus(s=>s.ready&&!s.error&&s.generation===s.desiredGeneration);
  /** Exports through the dialog and waits for `expected` in the export folder. */
  const exportAudio=async({format,type,rate,depth,name,expected})=>{
    await clickWorkspaceCommand(page,'Export score',{waitForIdle:false});
    const dialog=page.getByRole('dialog',{name:'Export score'});await dialog.getByLabel('Export format').selectOption(format);
    await dialog.getByRole('radio',{name:type==='ogg'?'OGG Vorbis (compressed)':type.toUpperCase()}).click();
    await dialog.getByRole('radio',{name:rate===48000?'48 kHz':'44.1 kHz'}).click();
    // OGG has no bit depth, so the dialog hides it.
    if(type==='ogg')assert.equal(await dialog.getByRole('radiogroup',{name:'Bit depth'}).count(),0);else await dialog.getByRole('radio',{name:`${depth} bit`}).click();
    await dialog.getByLabel('File name',{exact:true}).fill(name);
    if(format==='wav')await dialog.getByText(`Saves as ${name}.${type}`,{exact:true}).waitFor();
    await dialog.getByRole('button',{name:'Export',exact:true}).click();
    const deadline=Date.now()+120000;
    while(Date.now()<deadline&&!existsSync(join(folder,expected))){
      const failure=dialog.getByRole('alert');if(await failure.count())throw new Error(await failure.innerText());await new Promise(r=>setTimeout(r,200));
    }
    assert.ok(existsSync(join(folder,expected)),`${expected} was written`);await dialog.waitFor({state:'detached',timeout:30000}).catch(()=>{});await waitForWorkspaceIdle(page);
    await new Promise(r=>setTimeout(r,300));
  };
  const results={};
  for(const rate of [44100,48000]){
    const name=`mix-${rate}`;
    await exportAudio({format:'wav',type:'ogg',rate,name,expected:`${name}.ogg`});
    await exportAudio({format:'wav',type:'wav',rate,depth:24,name,expected:`${name}.wav`});
    const ogg=await decode(join(folder,`${name}.ogg`),24),pcm=wav(await readFile(join(folder,`${name}.wav`)));
    assert.equal((await readFile(join(folder,`${name}.ogg`))).subarray(0,4).toString(),'OggS');
    assert.deepEqual([ogg.sampleRate,ogg.channels],[rate,2]);assert.deepEqual([pcm.sampleRate,pcm.channels,pcm.bits],[rate,2,24]);
    assert.equal(ogg.frames,pcm.samples.length/2,`${name}: the OGG and WAV hold the same frames`);
    assert.ok(ogg.frames>rate*2,`${name}: the chord and its tail were written`);
    // Lossy, so compare by the signal-to-noise ratio of the decoded OGG against the WAV.
    let signal=0,noise=0,peak=0;for(let i=0;i<pcm.samples.length;i++){const d=ogg.samples[i]-pcm.samples[i];signal+=pcm.samples[i]**2;noise+=d*d;peak=Math.max(peak,Math.abs(pcm.samples[i]));}
    const snr=10*Math.log10(signal/Math.max(noise,1));
    assert.ok(peak/2**23>.01,`${name}: the chord is audible`);
    assert.ok(snr>25,`${name}: the OGG sounds like the WAV (SNR ${snr.toFixed(1)} dB)`);
    const sizes={ogg:(await stat(join(folder,`${name}.ogg`))).size,wav:(await stat(join(folder,`${name}.wav`))).size};
    assert.ok(sizes.ogg*4<sizes.wav,`${name}: OGG is under a quarter of the 24-bit WAV ${JSON.stringify(sizes)}`);
    results[name]={frames:ogg.frames,snrDb:+snr.toFixed(1),...sizes,ratio:+(sizes.ogg/sizes.wav).toFixed(3)};
  }
  await exportAudio({format:'stems',type:'ogg',rate:48000,name:'ogg-stems',expected:join('ogg-stems','manifest.json')});
  const stems=join(folder,'ogg-stems'),manifest=JSON.parse(await readFile(join(stems,'manifest.json'),'utf8'));
  assert.equal(manifest.format.container,'ogg');assert.equal(manifest.format.sampleRate,48000);
  const files=(await readdir(stems)).filter(file=>file!=='manifest.json'&&!file.endsWith('.samples')).sort();
  assert.deepEqual(files,manifest.tracks.map(track=>track.filename).sort());
  assert.ok(files.length>0&&files.every(file=>file.endsWith('.ogg')),JSON.stringify(files));
  for(const file of files){const decoded=await decode(join(stems,file),24);assert.deepEqual([decoded.sampleRate,decoded.channels],[48000,2]);assert.ok(decoded.frames>48000*2,file);}
  results.stems={files,format:manifest.format};
  assert.deepEqual(errors,[]);
  await writeFile(join(directory,'ogg-export-result.json'),JSON.stringify(results,null,2));
  console.log('OGG export passed:',JSON.stringify(results));
}finally{try{if(browser)await browser.close();}finally{stop(id);}}
