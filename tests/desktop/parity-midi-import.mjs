import {waitForWorkspaceIdle,clickWorkstationButton} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { importer,Settings } from '@coderline/alphatab';
import { launch,connect,stop } from './harness.mjs';

// F02 MIDI import: File > Import MIDI… reads a Standard MIDI file chosen in the dialog, shows what it understood and
// opens it as a new untitled GP-based tab. A malformed file is refused with its reason and changes nothing. The options
// (quantization, tuplets, voices per track, tablature) decide the rhythm of the score that opens.
const vlq=value=>{const out=[value&0x7f];while((value>>=7)>0)out.unshift((value&0x7f)|0x80);return out;};
const track=events=>{const body=events.flatMap(([delta,data])=>[...vlq(delta),...data,]);body.push(0,0xff,0x2f,0);return [0x4d,0x54,0x72,0x6b,body.length>>>24,body.length>>16&255,body.length>>8&255,body.length&255,...body];};
const file=(division,tracks,format=1)=>Buffer.from([0x4d,0x54,0x68,0x64,0,0,0,6,0,format,0,tracks.length,division>>8,division&255,...tracks.flat()]);
const line=(notes,channel=0)=>{
  const events=notes.flatMap(([start,length,key])=>[[start,[0x90|channel,key,90]],[start+length,[0x80|channel,key,0]]]).sort((a,b)=>a[0]-b[0]||(a[1][0]&0xf0)-(b[1][0]&0xf0));
  let last=0;return events.map(([at,data])=>{const delta=at-last;last=at;return [delta,data];});
};
const tempo=bpm=>{const micros=Math.round(60e6/bpm);return [0xff,0x51,3,micros>>16&255,micros>>8&255,micros&255];};
// 3/4 at 100 BPM, 480 ticks per quarter. Guitar: a triplet of eighth notes, then two straight quarters (bar 1).
// Bass: one long note under a short one (two voices). A second bar holds one long guitar note. Drums on channel 10: kick, snare, kick, snare.
const conductor=track([[0,[0xff,0x03,4,...Buffer.from('Demo')]],[0,tempo(100)],[0,[0xff,0x58,4,3,2,24,8]]]);
const guitar=track([[0,[0xc0,25]],...line([[0,160,64],[160,160,67],[320,160,71],[480,480,69],[960,480,60],[1440,1440,62]])]);
const bass=track([[0,[0xc1,33]],...line([[0,1440,40],[480,480,47]],1)]);
const drums=track(line([[0,10,36],[480,10,38],[960,10,36]],9));
const demo=file(480,[conductor,guitar,bass,drums]);
// Format 0, one bass channel: four sixteenths and a quarter. A 16th grid keeps the sixteenths; an 8th grid cannot.
const sixteenths=file(480,[track([[0,[0xc0,33]],...line([[0,120,40],[120,120,43],[240,120,45],[360,120,47],[480,480,52]])])],0);
const broken=demo.subarray(0,60);

const id=launch({});let browser,page;
try{
  browser=await connect();page=browser.contexts()[0].pages()[0];await waitForWorkspaceIdle(page);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const library=page.getByRole('dialog',{name:'Library',exact:true});await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});
  const tabs=async()=>(await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('workspace_snapshot'))).documents.length;
  const before=await tabs(),edits0=(await readActiveDocument(page)).project.edits;
  const openDialog=async()=>{
    await clickWorkstationButton(page,'Import MIDI…',{waitForIdle:false});
    const dialog=page.getByRole('dialog',{name:'Import MIDI',exact:true});await dialog.waitFor();
    assert.equal(await dialog.getByRole('button',{name:'Choose MIDI file…'}).evaluate(node=>node===document.activeElement),true,'The file button takes focus.');
    return dialog;
  };
  // Quantization and voices are radio groups of buttons now, not selects.
  const grids={4:'Quarter note (1/4)',8:'Eighth note (1/8)',16:'16th note (1/16)',32:'32nd note (1/32)',64:'64th note (1/64)'};
  const pick=(dialog,group,name)=>dialog.getByRole('radiogroup',{name:group,exact:true}).getByRole('radio',{name,exact:true}).click();
  const chooseFile=(dialog,name,buffer)=>dialog.locator('input[type="file"]').setInputFiles({name,mimeType:'audio/midi',buffer});

  // A cut-off file is refused with its reason, nothing opens and the open score is untouched.
  let dialog=await openDialog();
  await chooseFile(dialog,'broken.mid',broken);
  await dialog.getByRole('status').filter({hasText:/This is not a valid MIDI file/}).waitFor();
  assert.equal(await dialog.getByRole('button',{name:'Import',exact:true}).isDisabled(),true);
  assert.equal(await tabs(),before);assert.deepEqual((await readActiveDocument(page)).project.edits,edits0);
  // A plain text file is refused too.
  await chooseFile(dialog,'notes.mid',Buffer.from('not midi at all, just words'));
  await dialog.getByRole('status').filter({hasText:'This is not a Standard MIDI File.'}).waitFor();

  // The good file is summarised, and the dialog stays modal.
  await chooseFile(dialog,'Demo song.mid',demo);
  await dialog.getByRole('status').filter({hasText:/^Format 1, 3 parts, 2 measures at 100 BPM\.$/}).waitFor();
  await dialog.getByRole('list',{name:'Parts'}).getByText(/Drums: drums/).waitFor();
  for(let press=0;press<12;press++)await page.keyboard.press('Tab');
  assert.equal(await dialog.evaluate(node=>node.contains(document.activeElement)),true,'Focus stays in the dialog.');
  const open=await tabs();await page.keyboard.press('Control+n');await waitForWorkspaceIdle(page);assert.equal(await tabs(),open);
  await dialog.getByRole('button',{name:'Import',exact:true}).click();
  await dialog.waitFor({state:'detached'});await waitForWorkspaceIdle(page);
  assert.deepEqual(await page.getByRole('alert').allTextContents(),[]);
  assert.equal(await tabs(),before+1);

  const imported=await readActiveDocument(page);
  assert.equal(imported.path,null,'The import is an untitled document.');
  assert.equal(imported.project.base.kind,'file');assert.equal(imported.project.base.filename,'Demo song.gp');
  const score=importer.ScoreLoader.loadScoreFromBytes(Buffer.from(imported.project.base.bytesBase64,'base64'),new Settings());
  assert.equal(score.title,'Demo');assert.equal(score.masterBars[0].tempoAutomations[0].value,100);
  assert.deepEqual(score.masterBars.map(bar=>[bar.timeSignatureNumerator,bar.timeSignatureDenominator]),[[3,4],[3,4]]);
  assert.deepEqual(score.tracks.map(item=>item.playbackInfo.program),[25,33,0]);
  assert.equal(score.tracks[2].isPercussion,true);
  const guitarBeats=score.tracks[0].staves[0].bars[0].voices[0].beats;
  assert.deepEqual(guitarBeats.map(beat=>[beat.duration,beat.hasTuplet?`${beat.tupletNumerator}:${beat.tupletDenominator}`:null]),[[8,'3:2'],[8,'3:2'],[8,'3:2'],[4,null],[4,null]]);
  assert.deepEqual(score.tracks[0].staves[0].tuning,[64,59,55,50,45,40]);
  assert.equal(score.tracks[1].staves[0].bars[0].voices.length,2,'Overlapping bass notes use two voices.');
  assert.deepEqual(score.tracks[1].staves[0].tuning,[43,38,33,28],'A bass program gets bass tuning.');
  // Drum notes name rows of the file's own articulation table: kick, snare, kick sound as MIDI 36, 38, 36.
  const drumKeys=score.tracks[2].staves[0].bars[0].voices[0].beats.filter(beat=>beat.notes.length).map(beat=>score.tracks[2].percussionArticulations[beat.notes[0].percussionArticulation].outputMidiNumber);
  assert.deepEqual(drumKeys,[36,38,36]);
  await page.locator('[aria-label="Music notation"] svg').first().waitFor();
  // The import is an ordinary editable score.
  await page.getByRole('region',{name:'Score workspace'}).focus();await page.keyboard.press('Control+Shift+P');
  const palette=page.getByRole('dialog',{name:'Commands',exact:true});await palette.getByRole('combobox',{name:'Command'}).fill('fret 2');await page.keyboard.press('Enter');
  await palette.waitFor({state:'detached'});await waitForWorkspaceIdle(page);
  assert.deepEqual((await readActiveDocument(page)).project.edits.map(edit=>[edit.type,edit.fret]),[['setNote',2]]);

  // The same file again with other options: eighth-note grid, no tuplets and one voice, in another new tab.
  dialog=await openDialog();
  await chooseFile(dialog,'Demo song.mid',demo);
  await dialog.getByRole('status').filter({hasText:/^Format 1, 3 parts/}).waitFor();
  await pick(dialog,'Quantization',grids[8]);
  await dialog.getByLabel('Tuplets').selectOption('none');
  await pick(dialog,'Voices per track','1');
  await dialog.getByLabel('Guitar and bass as tablature').uncheck();
  await dialog.getByRole('list',{name:'Parts'}).getByText(/Acoustic Guitar \(steel\): notation/).waitFor();
  await dialog.getByRole('button',{name:'Import',exact:true}).click();
  await dialog.waitFor({state:'detached'});await waitForWorkspaceIdle(page);
  assert.equal(await tabs(),before+2);
  const second=await readActiveDocument(page);
  assert.deepEqual(second.project.edits,[]);
  const plain=importer.ScoreLoader.loadScoreFromBytes(Buffer.from(second.project.base.bytesBase64,'base64'),new Settings());
  assert.equal(plain.tracks.some(item=>item.staves[0].bars.some(bar=>bar.voices.some(voice=>voice.beats.some(beat=>beat.tupletNumerator>1)))),false);
  assert.equal(plain.tracks[1].staves[0].bars[0].voices.length,1);
  assert.deepEqual(plain.tracks[0].staves[0].tuning,[]);

  // Format 0: the quantization option decides the written durations.
  const durationsFor=async grid=>{
    dialog=await openDialog();
    await chooseFile(dialog,'Sixteenths.mid',sixteenths);
    await dialog.getByRole('status').filter({hasText:/^Format 0, 1 part, 1 measure at 120 BPM\.$/}).waitFor();
    await pick(dialog,'Quantization',grids[grid]);
    await dialog.getByRole('status').filter({hasText:/^Format 0, 1 part/}).waitFor();
    await dialog.getByRole('button',{name:'Import',exact:true}).click();
    await dialog.waitFor({state:'detached'});await waitForWorkspaceIdle(page);
    const loaded=importer.ScoreLoader.loadScoreFromBytes(Buffer.from((await readActiveDocument(page)).project.base.bytesBase64,'base64'),new Settings());
    assert.deepEqual(loaded.tracks[0].staves[0].tuning,[43,38,33,28]);
    return loaded.tracks[0].staves[0].bars[0].voices[0].beats.map(beat=>beat.duration);
  };
  const fine=await durationsFor('16'),coarse=await durationsFor('8');
  assert.deepEqual(fine.slice(0,5),[16,16,16,16,4],'A 16th grid keeps four sixteenths and a quarter.');
  assert.equal(coarse.includes(16),false,'An 8th grid writes no sixteenths.');assert.notDeepEqual(coarse,fine);
  assert.equal(await tabs(),before+4);
  assert.deepEqual(errors,[]);
  console.log('MIDI import: malformed files refused without changes; a format 1 file opened as an untitled, editable score with tempo, meter, programs, triplets, voices and drums; options changed the second import.');
}catch(error){if(page)await page.screenshot({path:resolve('.analysis/parity/midi-import-failure.png')}).catch(()=>{});throw error;}
finally{if(browser)await browser.close().catch(()=>{});stop(id);}
