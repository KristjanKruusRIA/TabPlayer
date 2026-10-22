import {waitForWorkspaceIdle,clickWorkstationButton,clickWorkspaceCommand} from './workstation-commands.mjs';
import assert from 'node:assert/strict';
import { mkdir,readdir,readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { directory,launch,connect,stop } from './harness.mjs';
import { buildInstrumentFixture,fixturePath,metadataPath } from './instrument-fixture.mjs';

// ASCII tablature: Export score → ASCII tablature writes a .txt with Guitar9 and Bass6 (named by octave
// where string names repeat), leaves out Drums and Keys, and every string line carries exactly the
// fixture's frets in time order.
await buildInstrumentFixture();
const metadata=JSON.parse(await readFile(metadataPath,'utf8'));
const folder=join(directory,`export-${Date.now()}-ascii-tab`);await mkdir(folder,{recursive:true});
const id=launch({TABPLAYER_TEST_OPEN:fixturePath,TABPLAYER_TEST_EXPORT_DIR:folder});let browser;
try{
  browser=await connect();const page=browser.contexts()[0].pages()[0];await waitForWorkspaceIdle(page);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const library=page.getByRole('dialog',{name:'Library',exact:true});await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});
  await clickWorkstationButton(page,'Open',{waitForIdle:false});await waitForWorkspaceIdle(page);
  await clickWorkspaceCommand(page,'Export score',{waitForIdle:false});
  const dialog=page.getByRole('dialog',{name:'Export score'});await dialog.getByLabel('Export format').selectOption('ascii');
  await dialog.getByText(/^ASCII tablature writes the fret numbers/).waitFor();
  await dialog.getByLabel('File name',{exact:true}).fill('tab');await dialog.getByText('Saves as tab.txt').waitFor();
  await dialog.getByRole('button',{name:'Export',exact:true}).click();
  const deadline=Date.now()+60000;let file;
  while(Date.now()<deadline&&!(file=(await readdir(folder)).find(name=>name.endsWith('.txt'))))await new Promise(r=>setTimeout(r,200));
  assert.equal(file,'tab.txt','The ASCII tablature was written.');await waitForWorkspaceIdle(page);
  const text=await readFile(join(folder,file),'utf8'),lines=text.split('\n');
  assert.equal(lines[0],'Authored instrument view fixture - TabPlayer desktop verification');assert.equal(metadata.title,'Authored instrument view fixture');
  assert.ok(lines.includes('Guitar9 [C#1 F#1 B1 E2 A2 D3 G3 B3 E4]'),text);
  assert.ok(lines.includes('Bass6 [B E A D G C]'),text);
  assert.ok(!/Drums|Keys/.test(text),'Percussion and string-less tracks are left out.');
  assert.ok(lines.every(line=>line.length<=80),'Systems wrap at 80 columns.');
  // Each string's line, joined across systems, holds that string's frets in time order.
  const strings={Guitar9:['E4','B3','G3','D3','A2','E2','B1','F#1','C#1'],Bass6:['C','G','D','A','E','B']};
  for(const [index,name] of [[0,'Guitar9'],[1,'Bass6']]){
    const start=lines.indexOf(lines.find(line=>line.startsWith(`${name} [`))),end=lines.findIndex((line,at)=>at>start&&/^\S.* \[/.test(line));
    const block=lines.slice(start+1,end<0?undefined:end),width=Math.max(...strings[name].map(label=>label.length));
    strings[name].forEach((label,row)=>{
      const prefix=`${label.padEnd(width)}|`,written=block.filter(line=>line.startsWith(prefix)).map(line=>line.slice(prefix.length)).join('').match(/\d+/g)?.map(Number)??[];
      const expected=metadata.notes.filter(note=>note.track===index&&note.string===strings[name].length-row).sort((a,b)=>a.startTick-b.startTick).map(note=>note.fret);
      assert.deepEqual(written,expected,`${name} ${label} string`);
    });
  }
  assert.deepEqual(errors,[]);
  console.log(`ascii tab: ${file} ${lines.length} lines; Guitar9 and Bass6 frets match the fixture string by string.`);
}finally{if(browser)await browser.close().catch(()=>{});stop(id);}
