import {waitForWorkspaceIdle,clickWorkstationButton,clickWorkspaceCommand,revealLeftTask} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import { mkdir,readdir,readFile,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { exporter,model,Settings } from '@coderline/alphatab';
import { directory,launch,connect,stop } from './harness.mjs';

// Factory sounds: the Sound task applies a factory sound as one track-sound edit holding the catalog's chain, and
// previews and keeps another. Exported WAVs of a low chord through the warm jazz clean and metal rhythm sounds are
// within 6 dB of each other in level, and the metal one carries far more of its power in the upper octaves. It plays
// live without errors, and Undo restores the previous sound.
const catalog=JSON.parse(await readFile(resolve('tests/factory-sounds.json'),'utf8'));
const fixture=resolve(directory,'factory-sounds-fixture.gp');
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
/** Both channels of a 16- or 24-bit stereo PCM WAV as numbers in -1..1, with the sample rate. */
function channels(bytes){
  assert.equal(bytes.subarray(0,4).toString(),'RIFF');const rate=bytes.readUInt32LE(24),bits=bytes.readUInt16LE(34),width=bits/8,frames=bytes.readUInt32LE(40)/(2*width),out=[new Float64Array(frames),new Float64Array(frames)];
  for(let i=0;i<frames;i++)for(let c=0;c<2;c++){const at=44+(i*2+c)*width;out[c][i]=bits===16?bytes.readInt16LE(at)/32768:bytes.readIntLE(at,3)/8388608;}
  return {samples:out,rate};
}
const span=(rate,from,to)=>[Math.round(rate*from),Math.round(rate*to)];
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
/** Power between two frequencies. */
const band=({power,binHz},low,high)=>{let sum=0;for(let k=Math.ceil(low/binHz);k<=Math.floor(high/binHz);k++)sum+=power[k];return sum;};
/** The mid channel's RMS level in dBFS between two times in seconds. */
const level=({samples:[l,r],rate},from,to)=>{const [a,b]=span(rate,from,to);let sum=0;for(let i=a;i<b;i++)sum+=((l[i]+r[i])/2)**2;return 10*Math.log10(sum/(b-a));};
const folder=join(directory,`export-${Date.now()}-factory-sounds`);await mkdir(folder,{recursive:true});
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
  await revealLeftTask(page,'Sound');const panel=page.getByRole('region',{name:'Track sound'});
  const soundEdits=async()=>(await readActiveDocument(page)).project.edits.filter(edit=>edit.type==='setTrackSound');
  const lastSound=async()=>(await soundEdits()).at(-1)?.sound;
  const entry=id=>catalog.find(item=>item.id===id);
  // A block's defaults, as a sound that bypasses it holds them.
  const defaults=block=>catalog.find(item=>!item.effects[block].enabled).effects[block];
  /** Asserts `effects` as recorded plays the catalog's chain for `id`. The native player leaves out bypassed blocks and
   * fields it added later while they hold their defaults, so a bypassed block must stay bypassed, and an enabled block
   * must record every field the catalog sets, leaving out only fields at their defaults. */
  const plays=(effects,id)=>{for(const [block,settings] of Object.entries(entry(id).effects)){
    if(!settings.enabled){assert.notEqual(effects[block]?.enabled,true,`${id} ${block}`);continue;}
    assert.ok(effects[block],`${id} ${block}`);
    for(const field of new Set([...Object.keys(settings),...Object.keys(effects[block])])){
      if(Object.hasOwn(effects[block],field))assert.deepEqual(effects[block][field],settings[field],`${id} ${block}.${field}`);
      else assert.deepEqual(settings[field],defaults(block)[field],`${id} ${block}.${field} left out`);
    }
  }};
  const apply=async(id,name)=>{
    await panel.getByLabel('Factory sound',{exact:true}).selectOption(id);
    await panel.getByRole('button',{name:'Apply factory sound',exact:true}).click();await waitForWorkspaceIdle(page);
    await panel.getByRole('status').filter({hasText:`Applied “${name}”.`}).waitFor();
    const sound=await lastSound();plays(sound.effects,id);assert.equal(sound.presetId,entry(id).presetId);
  };
  await apply('jazz-clean','Warm jazz clean');const jazz=await exportWav('jazz-clean');
  await apply('metal-rhythm','Metal rhythm');const metal=await exportWav('metal-rhythm');
  // Level over the chord from 0.1 to 1.5 s, and the share of its power from 1 to 8 kHz.
  const upper=render=>{const s=spectrum(render,0.1,1.5);return 10*Math.log10(band(s,1000,8000)/band(s,40,8000));};
  const results={jazz:{levelDb:level(jazz,0.1,1.5),upperShareDb:upper(jazz)},metal:{levelDb:level(metal,0.1,1.5),upperShareDb:upper(metal)}};
  const text=JSON.stringify(results);
  assert.ok(Math.abs(results.jazz.levelDb-results.metal.levelDb)<=6,`levels match: ${text}`);
  assert.ok(results.metal.upperShareDb-results.jazz.upperShareDb>10,`metal is far brighter: ${text}`);
  // Previewing a factory sound records nothing until it is kept.
  const before=(await soundEdits()).length;
  await panel.getByLabel('Preview sound',{exact:true}).selectOption('factory:shimmer');
  await panel.getByRole('status').filter({hasText:'Previewing “Octave shimmer”.'}).waitFor();
  assert.equal((await soundEdits()).length,before);
  await panel.getByRole('button',{name:'Keep previewed sound',exact:true}).click();await waitForWorkspaceIdle(page);
  await panel.getByRole('status').filter({hasText:'Kept “Octave shimmer”.'}).waitFor();
  assert.equal((await soundEdits()).length,before+1);plays((await lastSound()).effects,'shimmer');
  await button('Play');await waitStatus(s=>s.playing&&s.renderedFrames>4096&&s.outputPeak>.001&&!s.error);await button('Stop');
  await button('Undo');plays((await lastSound()).effects,'metal-rhythm');
  assert.deepEqual(errors,[]);
  await writeFile(join(directory,'factory-sounds-result.json'),JSON.stringify(results,null,2));
  console.log('Factory sounds passed:',text);
}finally{try{if(browser)await browser.close();}finally{stop(id);}}
