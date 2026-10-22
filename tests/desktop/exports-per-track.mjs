import {waitForWorkspaceIdle,clickWorkspaceCommand,clickWorkstationButton} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import { readFile,readdir,mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { directory,launch,connect,stop } from './harness.mjs';
import { buildInstrumentFixture,fixturePath } from './instrument-fixture.mjs';

// One file per track: the 4-track instrument fixture exports as PNG and PDF into fresh folders,
// each file named from the template with its own track number and name.
// Alpha of the top-left pixel: every PNG row filter leaves the first pixel of the first row unchanged.
function firstPixelAlpha(bytes){
  const data=[];for(let at=8;at<bytes.length;){const length=bytes.readUInt32BE(at),type=bytes.toString('latin1',at+4,at+8);if(type==='IDAT')data.push(bytes.subarray(at+8,at+8+length));at+=12+length;}
  return inflateSync(Buffer.concat(data))[4];
}
await buildInstrumentFixture();
const expected=['1 Guitar9','2 Bass6','3 Drums','4 Keys'];
for(const format of ['png','pdf']){
  const folder=join(directory,`export-${Date.now()}-per-track-${format}`);await mkdir(folder,{recursive:true});
  const id=launch({TABPLAYER_TEST_OPEN:fixturePath,TABPLAYER_TEST_EXPORT_DIR:folder});let browser;
  try{
    browser=await connect();const page=browser.contexts()[0].pages()[0];await waitForWorkspaceIdle(page);
    const library=page.getByRole('dialog',{name:'Library',exact:true});await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});
    await clickWorkstationButton(page,'Open',{waitForIdle:false});await waitForWorkspaceIdle(page);
    const before=await readActiveDocument(page);
    await clickWorkspaceCommand(page,'Export score',{waitForIdle:false});
    const dialog=page.getByRole('dialog',{name:'Export score'});await dialog.getByLabel('Export format').selectOption(format);
    await dialog.getByLabel('File name',{exact:true}).fill('%n %t');
    if(format==='png'){await dialog.getByLabel('Resolution').selectOption('72');await dialog.getByLabel('Transparent background').check();}
    await dialog.getByLabel('One file per track').check();
    await dialog.getByRole('button',{name:'Export',exact:true}).click();
    const deadline=Date.now()+120000;let names=[];
    while(Date.now()<deadline){
      names=(await readdir(folder)).sort();
      if(expected.every(name=>names.some(file=>file.startsWith(name))))break;
      const failure=dialog.getByRole('alert');if(await failure.count())throw new Error(await failure.innerText());
      await new Promise(r=>setTimeout(r,200));
    }
    await waitForWorkspaceIdle(page);names=(await readdir(folder)).sort();
    // Every file belongs to exactly one track, numbered only when that track has several pages.
    const pattern=new RegExp(`^(${expected.join('|')})(-\\d+)?\\.${format}$`);
    assert.ok(names.length>=4&&names.every(name=>pattern.test(name)),`Unexpected files: ${names.join(', ')}`);
    for(const track of expected)assert.ok(names.some(name=>name.startsWith(`${track}.`)||name.startsWith(`${track}-`)),`Missing ${track}`);
    for(const name of names){
      const bytes=await readFile(join(folder,name));
      if(format==='pdf')assert.equal(bytes.subarray(0,5).toString(),'%PDF-');
      else{assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(bytes[25],6);assert.equal(firstPixelAlpha(bytes),0,`${name} must keep a transparent background.`);}
    }
    assert.deepEqual(await readActiveDocument(page),before,'Export must leave the document unchanged.');
    console.log(`${format} one file per track: ${names.join(', ')}`);
  }finally{if(browser)await browser.close().catch(()=>{});stop(id);}
}
