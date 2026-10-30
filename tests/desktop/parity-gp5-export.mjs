import {waitForWorkspaceIdle,clickWorkstationButton,clickWorkspaceCommand} from './workstation-commands.mjs';
import assert from 'node:assert/strict';
import { mkdir,readdir,readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Environment,io,Settings } from '@coderline/alphatab';
import { directory,launch,connect,stop } from './harness.mjs';
import { buildInstrumentFixture,fixturePath,metadataPath } from './instrument-fixture.mjs';

// Guitar Pro 5 export: Export score → Guitar Pro 5 refuses the fixture's nine-string guitar and its string-less keys before
// any save dialog, then writes Bass6 and Drums as a .gp5 that alphaTab's own GP3-5 reader opens (to the last byte) with the
// fixture's start ticks and pitches. Guitar Pro 6 (.gpx) export is not delivered, and the dialog says so.
await buildInstrumentFixture();
const metadata=JSON.parse(await readFile(metadataPath,'utf8'));
const folder=join(directory,`export-${Date.now()}-gp5`);await mkdir(folder,{recursive:true});
const id=launch({TABPLAYER_TEST_OPEN:fixturePath,TABPLAYER_TEST_EXPORT_DIR:folder});let browser;
try{
  browser=await connect();const page=browser.contexts()[0].pages()[0];await waitForWorkspaceIdle(page);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const library=page.getByRole('dialog',{name:'Library',exact:true});await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});
  await clickWorkstationButton(page,'Open',{waitForIdle:false});await waitForWorkspaceIdle(page);
  await clickWorkspaceCommand(page,'Export score',{waitForIdle:false});
  const dialog=page.getByRole('dialog',{name:'Export score'});await dialog.getByLabel('Export format').selectOption('gp5');
  await dialog.getByText(/Guitar Pro 6 \(\.gpx\) export is not available/).waitFor();
  // Everything selected: nine strings and a track without strings cannot be held, so nothing may be saved.
  await dialog.getByText(/Guitar9 has 9 strings and Guitar Pro 5 holds at most 7/).waitFor();
  assert.equal(await dialog.getByRole('button',{name:'Export',exact:true}).isDisabled(),true,'A refused selection cannot be exported.');
  assert.deepEqual(await readdir(folder),[],'Nothing is written for a refused selection.');
  // Bass6 and Drums only.
  for(const name of ['Guitar9','Keys'])await dialog.getByRole('group',{name:`${name} track and staves`}).getByRole('checkbox').uncheck();
  await dialog.getByRole('status').waitFor();
  assert.equal(await dialog.getByText(/Guitar9 has 9 strings/).count(),0,'The refusal clears once the track is deselected.');
  await dialog.getByLabel('File name',{exact:true}).fill('bass');await dialog.getByText('Saves as bass.gp5').waitFor();
  await dialog.getByRole('button',{name:'Export',exact:true}).click();
  const deadline=Date.now()+60000;let file;
  while(Date.now()<deadline&&!(file=(await readdir(folder)).find(name=>name.endsWith('.gp5'))))await new Promise(r=>setTimeout(r,200));
  assert.equal(file,'bass.gp5','The Guitar Pro 5 file was written.');await waitForWorkspaceIdle(page);
  const bytes=new Uint8Array(await readFile(join(folder,file)));
  assert.equal(bytes[0],24);assert.equal(new TextDecoder().decode(bytes.subarray(1,25)),'FICHIER GUITAR PRO v5.10');
  // alphaTab's GP3-5 reader must consume every byte.
  const reader=Environment.buildImporters()[0];reader.init(io.ByteBuffer.fromBuffer(bytes),new Settings());const score=reader.readScore();
  assert.equal(reader.data.position,reader.data.length,'The reader uses every byte and needs none more.');
  assert.deepEqual(score.tracks.map(track=>track.name),['Bass6','Drums']);
  assert.deepEqual(score.tracks[0].staves[0].tuning,metadata.tracks[1].tuning,'The bass keeps its six-string tuning.');
  assert.equal(score.tracks[1].staves[0].isPercussion,true);
  const read=track=>track.staves[0].bars.flatMap(bar=>bar.voices[0].beats.flatMap(beat=>beat.notes.map(note=>[beat.absolutePlaybackStart,track.staves[0].isPercussion?note.percussionArticulation:note.realValue]))).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  const expected=index=>metadata.notes.filter(note=>note.track===index).map(note=>[note.startTick,note.key]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  assert.ok(expected(1).length>0&&expected(2).length>0);
  assert.deepEqual(read(score.tracks[0]),expected(1),'Bass6 starts and pitches match the fixture.');
  assert.deepEqual(read(score.tracks[1]),expected(2),'Drums starts and keys match the fixture.');
  assert.deepEqual(errors,[]);
  console.log(`gp5 export: ${file} ${bytes.length} bytes; Bass6 and Drums match the fixture; the nine-string guitar was refused before saving.`);
}finally{if(browser)await browser.close().catch(()=>{});stop(id);}
