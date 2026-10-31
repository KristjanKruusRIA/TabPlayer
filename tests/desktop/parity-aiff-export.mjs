import {waitForWorkspaceIdle,clickWorkstationButton,clickWorkspaceCommand} from './workstation-commands.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir,readdir,readFile,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { exporter,model,Settings } from '@coderline/alphatab';
import { directory,launch,connect,stop } from './harness.mjs';

// AIFF export: the Export dialog's File type writes mixed audio and stems as AIFF. Python's own aifc and wave modules
// read the exported AIFF and WAV of the same chord as stereo PCM at the chosen rate and depth with identical samples,
// and the AIFF stems are .aiff files that its manifest names.
const fixture=resolve(directory,'aiff-export-fixture.gp');
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
/** Python's aifc and wave modules' reading of an AIFF and a WAV: their parameters, and whether their samples match. */
const python=`
import aifc, json, sys, wave
a = aifc.open(sys.argv[1], 'rb')
w = wave.open(sys.argv[2], 'rb')
af, wf = a.readframes(a.getnframes()), w.readframes(w.getnframes())
width = a.getsampwidth()
swapped = b''.join(af[i:i + width][::-1] for i in range(0, len(af), width))
peak = max(abs(int.from_bytes(af[i:i + width], 'big', signed=True)) for i in range(0, len(af), width))
print(json.dumps({'aiff': [a.getnchannels(), width * 8, a.getframerate(), a.getnframes()],
                  'wav': [w.getnchannels(), w.getsampwidth() * 8, w.getframerate(), w.getnframes()],
                  'same': swapped == wf, 'peak': peak / 2 ** (width * 8 - 1)}))
`;
const read=(aiff,wav)=>JSON.parse(execFileSync('python',['-W','ignore','-c',python,aiff,wav],{encoding:'utf8'}));
const folder=join(directory,`export-${Date.now()}-aiff`);await mkdir(folder,{recursive:true});
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
    await dialog.getByRole('radio',{name:type.toUpperCase()}).click();
    await dialog.getByRole('radio',{name:rate===48000?'48 kHz':'44.1 kHz'}).click();await dialog.getByRole('radio',{name:`${depth} bit`}).click();
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
  for(const [rate,depth] of [[44100,24],[48000,16]]){
    const name=`mix-${rate}-${depth}`;
    await exportAudio({format:'wav',type:'aiff',rate,depth,name,expected:`${name}.aiff`});
    await exportAudio({format:'wav',type:'wav',rate,depth,name,expected:`${name}.wav`});
    const found=read(join(folder,`${name}.aiff`),join(folder,`${name}.wav`));
    assert.deepEqual(found.aiff,found.wav,`${name}: the AIFF and WAV parameters agree`);
    assert.deepEqual(found.aiff.slice(0,3),[2,depth,rate]);
    assert.ok(found.aiff[3]>rate*2,`${name}: the chord and its tail were written`);
    assert.equal(found.same,true,`${name}: Python reads identical samples from the AIFF and the WAV`);
    assert.ok(found.peak>.01,`${name}: the chord is audible`);
    results[name]=found;
  }
  await exportAudio({format:'stems',type:'aiff',rate:48000,depth:24,name:'aiff-stems',expected:join('aiff-stems','manifest.json')});
  const stems=join(folder,'aiff-stems'),manifest=JSON.parse(await readFile(join(stems,'manifest.json'),'utf8'));
  assert.deepEqual(manifest.format,{sampleRate:48000,bitDepth:24,container:'aiff'});
  const files=(await readdir(stems)).filter(file=>file!=='manifest.json').sort();
  assert.deepEqual(files,manifest.tracks.map(track=>track.filename).sort());
  assert.ok(files.length>0&&files.every(file=>file.endsWith('.aiff')),JSON.stringify(files));
  for(const file of files){const bytes=await readFile(join(stems,file));assert.equal(bytes.subarray(0,4).toString(),'FORM');assert.equal(bytes.subarray(8,12).toString(),'AIFF');}
  results.stems=files;
  assert.deepEqual(errors,[]);
  await writeFile(join(directory,'aiff-export-result.json'),JSON.stringify(results,null,2));
  console.log('AIFF export passed:',JSON.stringify(results));
}finally{try{if(browser)await browser.close();}finally{stop(id);}}
