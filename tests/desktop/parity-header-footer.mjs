import {waitForWorkspaceIdle,clickWorkstationButton} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {directory,launch,connect,stop} from './harness.mjs';
import {buildEngravingFixture,fixturePath} from './engraving-fixture.mjs';

// Header and footer fields: the Page layout panel sets first-page and other-page bands with score
// fields, the exported PDF pages carry the filled text in place, the layout saves and reopens, and
// undo restores the established title and page-number pages.
await buildEngravingFixture();
const saved=resolve(directory,'gp8-header-footer.tabplayer'),exported=resolve(directory,'gp8-header-footer'),pdf=`${exported}.pdf`;
const title='Amber Windows — engraving study',subtitle='Original desktop acceptance fixture',artist='TabPlayer verification';
const fields=[['First page header center','%SUBTITLE%'],['First page header right','%ARTIST%'],['First page footer left','© %TITLE%'],['Other pages header left',''],['Other pages header center','%TITLE% (cont.)'],['Other pages footer center',''],['Other pages footer right','%PAGE%/%PAGES% · 100%%']];
let id=launch({TABPLAYER_TEST_OPEN:fixturePath,TABPLAYER_TEST_SAVE:saved,TABPLAYER_TEST_EXPORT:exported}),browser,page;
try{
  browser=await connect();page=browser.contexts()[0].pages()[0];await waitForWorkspaceIdle(page);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const closeLibrary=async()=>{const library=page.getByRole('dialog',{name:'Library',exact:true});await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});};
  await closeLibrary();
  const idle=async()=>{await waitForWorkspaceIdle(page);assert.deepEqual(await page.getByRole('alert').allTextContents(),[]);};
  const button=async name=>{await clickWorkstationButton(page,name,{waitForIdle:false});await idle();};
  const details=name=>page.locator('summary').filter({hasText:new RegExp(`^${name}$`)}).first().evaluate(node=>{node.parentElement.open=true;});
  const field=name=>page.getByLabel(name,{exact:true});
  const exportPdf=async()=>{
    await clickWorkstationButton(page,'Export score',{waitForIdle:false});const dialog=page.getByRole('dialog',{name:'Export score'});await dialog.getByLabel('Export format').selectOption('pdf');
    await dialog.getByRole('button',{name:'Export',exact:true}).click();
    await Promise.race([dialog.waitFor({state:'hidden',timeout:30000}),dialog.getByRole('alert').waitFor({timeout:30000}).then(async()=>{throw new Error(await dialog.getByRole('alert').textContent());})]);await dialog.waitFor({state:'hidden',timeout:30000});await idle();
    assert.equal(readFileSync(pdf).subarray(0,5).toString(),'%PDF-');
    // Page-level text only: notation text sits inside the system groups.
    return page.evaluate(()=>window.__tabplayerTestExportPages.at(-1).map(sheet=>[...new DOMParser().parseFromString(sheet.svg,'image/svg+xml').querySelectorAll('svg > text')].map(text=>[text.getAttribute('text-anchor')??'start',text.textContent])));
  };
  // On-screen page view: each sheet draws its header and footer in the page margins, clear of the music.
  const screenTexts=async()=>{
    await page.waitForFunction(()=>{const sheets=document.querySelectorAll('.score-sheet');return sheets.length>0&&[...sheets].every(sheet=>sheet.querySelector('svg.score-page-text'));});
    return page.evaluate(()=>[...document.querySelectorAll('.score-sheet')].map(sheet=>{
      const box=sheet.getBoundingClientRect(),overlay=sheet.querySelector('svg.score-page-text'),chunks=[...sheet.querySelectorAll('.score-svg-chunk')].map(chunk=>chunk.getBoundingClientRect());
      const top=Math.min(...chunks.map(r=>r.top)),bottom=Math.max(...chunks.map(r=>r.bottom));
      if(overlay.getAttribute('aria-hidden')!=='true'||getComputedStyle(overlay).pointerEvents!=='none')throw new Error('The page text overlay must be hidden from assistive technology and let clicks through.');
      return [...overlay.querySelectorAll('text')].map(text=>{
        const r=text.getBoundingClientRect(),inside=r.left>=box.left-1&&r.right<=box.right+1&&r.top>=box.top-1&&r.bottom<=box.bottom+1,clear=r.bottom<=top+1||r.top>=bottom-1;
        if(!inside)throw new Error(`Page text "${text.textContent}" runs off its sheet.`);
        if(!clear)throw new Error(`Page text "${text.textContent}" overlaps the music.`);
        return [text.getAttribute('text-anchor')??'start',text.textContent];
      });
    }));
  };
  const layout=async(width,height)=>{await details('Page layout');await field('Width (mm)').fill(String(width));await field('Height (mm)').fill(String(height));};
  await button('Open');await page.locator('[aria-label="Music notation"] svg').first().waitFor();
  await button('Presentation');
  // The three-track fixture spans several A4 pages, so both bands are exercised.
  await layout(210,297);await button('Apply page layout');
  const before=await exportPdf();assert.ok(before.length>1,`expected several pages, got ${before.length}`);
  before.forEach((texts,index)=>assert.deepEqual(texts,[['start',title],['middle',`${index+1} / ${before.length}`]]));
  await page.getByRole('combobox',{name:'Display mode',exact:true}).selectOption('verticalPage');
  const screenBefore=await screenTexts();assert.ok(screenBefore.length>1,`expected several screen pages, got ${screenBefore.length}`);
  screenBefore.forEach((texts,index)=>assert.deepEqual(texts,[['start',title],['middle',`${index+1} / ${screenBefore.length}`]]));
  await details('Page layout');for(const [name,value] of fields)await field(name).fill(value);
  await field('Other pages footer right').fill('%COMPOSER%');await page.getByRole('button',{name:'Apply page layout'}).click();
  assert.equal(await page.getByRole('alert').textContent(),'Other pages footer right: unknown field %COMPOSER%.');
  await field('Other pages footer right').fill(fields.at(-1)[1]);await button('Apply page layout');
  const authored=await readActiveDocument(page),edit=authored.project.edits.at(-1);
  assert.equal(edit.type,'setPageLayout');
  assert.deepEqual(edit.layout.headerFooter,{first:{header:{left:'%TITLE%',center:'%SUBTITLE%',right:'%ARTIST%'},footer:{left:'© %TITLE%',center:'%PAGE% / %PAGES%',right:''}},other:{header:{left:'',center:'%TITLE% (cont.)',right:''},footer:{left:'',center:'',right:'%PAGE%/%PAGES% · 100%%'}}});
  const screenAfter=await screenTexts(),n=screenAfter.length;assert.equal(n,screenBefore.length,'A header-only edit does not repaginate the screen.');
  assert.deepEqual(screenAfter[0],[['start',title],['middle',subtitle],['end',artist],['start',`© ${title}`],['middle',`1 / ${n}`]]);
  screenAfter.slice(1).forEach((texts,index)=>assert.deepEqual(texts,[['middle',`${title} (cont.)`],['end',`${index+2}/${n} · 100%`]]));
  const after=await exportPdf();assert.equal(after.length,before.length);
  assert.deepEqual(after[0],[['start',title],['middle',subtitle],['end',artist],['start',`© ${title}`],['middle',`1 / ${after.length}`]]);
  after.slice(1).forEach((texts,index)=>assert.deepEqual(texts,[['middle',`${title} (cont.)`],['end',`${index+2}/${after.length} · 100%`]]));
  await button('Undo');assert.deepEqual(await exportPdf(),before,'Undo restores the established header and footer.');
  assert.deepEqual(await screenTexts(),screenBefore,'Undo restores the header and footer on screen.');
  await button('Redo');assert.deepEqual(await screenTexts(),screenAfter,'Redo shows the authored header and footer on screen.');assert.deepEqual((await readActiveDocument(page)).project,authored.project);
  await button('Save');const stored=await readActiveDocument(page);assert.equal(stored.dirty,false);assert.deepEqual(errors,[]);
  await browser.close();browser=null;stop(id);
  id=launch({TABPLAYER_TEST_OPEN:saved,TABPLAYER_TEST_EXPORT:exported});browser=await connect();page=browser.contexts()[0].pages()[0];await waitForWorkspaceIdle(page);await closeLibrary();await button('Open');
  assert.deepEqual((await readActiveDocument(page)).project,stored.project);
  await button('Presentation');await details('Page layout');assert.equal(await field('Other pages header center').inputValue(),'%TITLE% (cont.)');
  assert.deepEqual(await exportPdf(),after,'The reopened document prints the same header and footer.');
  console.log(`header-footer: ${after.length} pages; first page ${JSON.stringify(after[0].map(([,text])=>text))}; other pages "${after[1].map(([,text])=>text).join('" / "')}"; ${screenAfter.length} screen pages show the same bands; saved, reopened and undone.`);
}catch(error){if(page)await page.screenshot({path:resolve('.analysis/parity/header-footer-failure.png')}).catch(()=>{});throw error;}
finally{if(browser)await browser.close().catch(()=>{});stop(id);}
