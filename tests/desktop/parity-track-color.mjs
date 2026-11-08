import {waitForWorkspaceIdle,clickWorkstationButton,revealDock,revealLeftTask} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import { readFileSync,rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { directory,launch,connect,stop } from './harness.mjs';
import { buildInstrumentFixture,fixturePath } from './instrument-fixture.mjs';

// Recoloring a track: the four-track fixture's Bass6 gets a new color from track settings, the
// Mixer swatch shows it, a GP export carries it, and Undo restores the original color.
await buildInstrumentFixture();
const exported=resolve(directory,'gp8-track-color.gp');rmSync(exported,{force:true});
const id=launch({TABPLAYER_TEST_OPEN:fixturePath,TABPLAYER_TEST_EXPORT:exported});let browser;
try{
  browser=await connect();const page=browser.contexts()[0].pages()[0];await waitForWorkspaceIdle(page);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const library=page.getByRole('dialog',{name:'Library',exact:true});await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});
  const button=async name=>{await clickWorkstationButton(page,name,{waitForIdle:false});await waitForWorkspaceIdle(page);assert.deepEqual(await page.getByRole('alert').allTextContents(),[]);};
  const swatch=async()=>{await revealDock(page,'Mixer');return page.getByRole('button',{name:'Track 2: Bass6',exact:true}).locator('.track-color-swatch').evaluate(node=>getComputedStyle(node).backgroundColor);};
  await button('Open');await button('Track 2: Bass6');
  const original=await swatch();
  await revealLeftTask(page,'Track');const settings=page.locator('.track-settings');await settings.getByText('Selected instrument',{exact:true}).click();
  const input=settings.getByLabel('Track color',{exact:true});
  await input.fill('#ff8800');await settings.getByRole('button',{name:'Apply track color',exact:true}).click();await waitForWorkspaceIdle(page);
  assert.deepEqual((await readActiveDocument(page)).project.edits.at(-1),{type:'setTrackColor',track:1,color:'#ff8800'});
  assert.equal(await swatch(),'rgb(255, 136, 0)');
  assert.notEqual(original,'rgb(255, 136, 0)');
  await button('Export GP');
  const colors=await page.evaluate(async bytes=>{const {importer,Settings}=await import('/alphatab/alphaTab.mjs');const score=importer.ScoreLoader.loadScoreFromBytes(Uint8Array.from(bytes),new Settings());
    return score.tracks.map(track=>({name:track.name,rgb:[track.color.r,track.color.g,track.color.b]}));},[...readFileSync(exported)]);
  assert.deepEqual(colors[1],{name:'Bass6',rgb:[255,136,0]});
  await button('Undo');
  assert.equal(await swatch(),original);
  assert.deepEqual(errors,[]);
  console.log(`track color: Bass6 ${original} -> rgb(255, 136, 0), GP export ${colors.map(track=>`${track.name}=${track.rgb.join('/')}`).join(', ')}; undo restored ${original}.`);
}finally{if(browser)await browser.close().catch(()=>{});stop(id);}
