import {waitForWorkspaceIdle,clickWorkspaceCommand} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { exporter,model,Settings } from '@coderline/alphatab';
import { directory,launch,connect,stop } from './harness.mjs';

// Direct symbol editing (E19): double-clicking the title, a tempo mark, a chord name or a clef on the rendered score edits it
// in place, and a right-click (or Shift+F10 on the focused score) opens the actions that fit. Each gesture is one undoable
// edit; the value a symbol already has records nothing; Escape cancels and returns focus to the score; a finalized document
// explains itself and refuses.
//
// Not run when this file was written: it needs a desktop-test build at .analysis/desktop-smoke/tabplayer.exe (see CLAUDE.md).
const fixture=resolve(directory,'symbol-editing-fixture.gp');
{
  const score=new model.Score(),track=new model.Track(),staff=new model.Staff();
  score.title='Etude';score.artist='Ann';
  track.name='Guitar';track.playbackInfo.program=25;staff.stringTuning.tunings=[64,59,55,50,45,40];track.addStaff(staff);score.addTrack(track);
  for(let index=0;index<4;index++){
    const master=new model.MasterBar();
    if(index===0)master.tempoAutomations=[model.Automation.buildTempoAutomation(false,0,100,2)];
    if(index===1)master.tempoAutomations=[model.Automation.buildTempoAutomation(false,0,140,2)];
    score.addMasterBar(master);
    const bar=new model.Bar(),voice=new model.Voice();bar.clef=model.Clef.G2;
    for(let beat=0;beat<4;beat++){const value=new model.Beat();value.duration=4;value.isEmpty=false;const note=new model.Note();note.string=6;note.fret=0;value.addNote(note);voice.addBeat(value);}
    bar.addVoice(voice);staff.addBar(bar);
  }
  const chord=new model.Chord();chord.name='Am';chord.strings=[0,0,2,2,1,0];chord.showName=true;chord.showDiagram=true;staff.addChord('c1',chord);
  staff.bars[1].voices[0].beats[0].chordId='c1';
  score.finish(new Settings());writeFileSync(fixture,new exporter.Gp7Exporter().export(score,new Settings()));
}
const id=launch({TABPLAYER_TEST_OPEN:fixture});let browser,page;
try{
  browser=await connect();page=browser.contexts()[0].pages()[0];await waitForWorkspaceIdle(page);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const library=page.getByRole('dialog',{name:'Library',exact:true});await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});
  const idle=async()=>{await waitForWorkspaceIdle(page);assert.deepEqual(await page.getByRole('alert').allTextContents(),[]);};
  await clickWorkspaceCommand(page,'Open',{waitForIdle:false});await idle();await page.locator('[aria-label="Music notation"] svg').first().waitFor();
  const workspace=page.getByRole('region',{name:'Score workspace'});
  await page.evaluate(()=>{window.__gestures=[];document.addEventListener('scroll',event=>window.__gestures.push('scroll:'+(event.target.className||event.target.nodeName)),true);window.addEventListener('resize',()=>window.__gestures.push('resize'));new MutationObserver(records=>{for(const record of records){for(const node of record.addedNodes)if(node.classList?.contains('score-symbol-popover'))window.__gestures.push('popover+');for(const node of record.removedNodes)if(node.classList?.contains('score-symbol-popover'))window.__gestures.push('popover-');}}).observe(document.body,{childList:true,subtree:true});for(const type of ['mousedown','dblclick','contextmenu'])document.addEventListener(type,event=>window.__gestures.push(type+':'+event.target.tagName+':'+(event.target.textContent||'').trim().slice(0,12)),true);});
  const edits=async()=>(await readActiveDocument(page)).project.edits;
  const symbols=text=>page.locator('[data-testid="score-pages"] svg text, [data-testid="score-source"] svg text').filter({visible:true}).filter({hasText:text});
  const symbol=text=>symbols(text).first();
  // The chord diagram heading above the first system is spelled like the chord and is not a target; the chord name is the lower one, and the order the
  // renderer leaves them in changes with each redraw.
  const lowest=async text=>{let best=null,top=-1;for(const candidate of await symbols(text).all()){const box=await candidate.boundingBox();if(box&&box.y>top){top=box.y;best=candidate;}}return best;};
  const popover=page.locator('.score-symbol-popover');
  // alphaTab redraws the score a moment after an edit lands; a click that falls in the redraw loses its target and no editor opens.
  // A gesture that opened nothing is repeated (it records nothing, so repeating it is safe).
  const gesture=async(target,options,name)=>{
    for(let attempt=0;attempt<4;attempt++){
      await target[name](options);
      if(await popover.waitFor({state:'attached',timeout:2500}).then(()=>true,()=>false))return;
    }
    throw new Error('No editor opened for the gesture.');
  };
  const dbl=(target,options)=>gesture(target,options,'dblclick');
  const rclick=target=>gesture(target,{button:'right'},'click');
  const onScore=()=>page.evaluate(()=>!!document.activeElement?.closest('.score-presentation,.score-workspace'));
  const settle=async()=>{await popover.waitFor({state:'detached'});await idle();};
  const start=(await edits()).length;

  // Title: double-click, type, Enter. One setScoreInfo; the score shows it.
  await dbl(symbol('Etude'));
  const field=popover.getByRole('textbox');await field.waitFor();
  assert.equal(await field.evaluate(node=>node===document.activeElement),true,'The editor takes focus.');
  assert.equal(await field.inputValue(),'Etude');
  await field.fill('Nocturne');await page.keyboard.press('Enter');await settle();
  assert.deepEqual((await edits()).slice(start).map(edit=>[edit.type,edit.title]),[['setScoreInfo','Nocturne']]);
  await symbol('Nocturne').waitFor();assert.equal(await onScore(),true,'Focus returns to the score.');

  // The value a symbol already has records nothing, and Escape cancels.
  await dbl(symbol('Nocturne'));await popover.getByRole('textbox').waitFor();await page.keyboard.press('Enter');await settle();
  assert.equal((await edits()).length,start+1,'The current title records nothing.');
  await dbl(symbol('= 100'));await popover.getByRole('textbox').fill('90');await page.keyboard.press('Escape');await settle();
  assert.equal((await edits()).length,start+1,'Escape records nothing.');
  assert.equal(await onScore(),true,'Escape returns focus to the score.');
  assert.equal(await symbol('= 100').isVisible(),true);

  // Tempo: a bad value is explained and keeps the editor; a good one is one edit.
  await dbl(symbol('= 100'));await popover.getByRole('textbox').fill('fast');await page.keyboard.press('Enter');
  assert.equal(await popover.getByRole('alert').textContent(),'Type a tempo from 1 to 999 BPM.');
  await popover.getByRole('textbox').fill('90');await page.keyboard.press('Enter');await settle();
  assert.deepEqual((await edits()).at(-1),{type:'setScoreInfo',title:'Nocturne',artist:'Ann',tempo:90,preserveOpeningMark:true});
  await symbol('= 90').waitFor();
  await dbl(symbol('= 140'));await popover.getByRole('textbox').fill('150');await page.keyboard.press('Enter');await settle();
  assert.equal((await edits()).at(-1).type,'setMeasureSettings');
  await symbol('= 150').waitFor();

  // Chord name.
  await dbl(await lowest('Am'));await popover.getByRole('textbox',{name:'Chord name'}).fill('Am7');await page.keyboard.press('Enter');await settle();
  assert.equal((await edits()).at(-1).chord.name,'Am7');

  // Clef: a menu of choices with the current one checked; choosing it again records nothing.
  const count=(await edits()).length;
  await dbl(symbol(''));
  const menu=popover.getByRole('menu',{name:'Clef, measure 1'});await menu.waitFor();
  assert.equal(await menu.getByRole('menuitemradio',{name:/Treble/}).getAttribute('aria-checked'),'true');
  await menu.getByRole('menuitemradio',{name:/Treble/}).click();await settle();
  assert.equal((await edits()).length,count,'The current clef records nothing.');
  await dbl(symbol(''));await popover.getByRole('menuitemradio',{name:/Bass/}).click();await settle();
  assert.deepEqual((await edits()).at(-1),{type:'setBarNotation',track:0,staff:0,bar:0,keySignature:0,keyMode:0,clef:model.Clef.F4});

  // Right-click: the actions that fit the chord, from the keyboard too.
  await rclick(await lowest('Am7'));
  const chordMenu=popover.getByRole('menu',{name:'Chord Am7'});await chordMenu.waitFor();
  assert.deepEqual(await chordMenu.getByRole('menuitem').allTextContents(),['Edit chord name…','Open chord editor…','Remove chord']);
  await page.keyboard.press('ArrowDown');await page.keyboard.press('Escape');await settle();
  assert.equal(await onScore(),true,'Escape closes the menu and returns focus.');
  await rclick(await lowest('Am7'));await popover.getByRole('menuitem',{name:'Remove chord'}).click();await settle();
  assert.deepEqual({chord:(await edits()).at(-1).chord,type:(await edits()).at(-1).type},{chord:null,type:'setHarmonyChord'});
  await workspace.focus();await page.keyboard.press('Shift+F10');
  await popover.getByRole('menu',{name:'Score symbols'}).waitFor();
  assert.equal(await popover.getByRole('menuitem').first().evaluate(node=>node===document.activeElement),true,'The keyboard menu focuses its first action.');
  await page.keyboard.press('Escape');await popover.waitFor({state:'detached'});

  // Undo takes back one gesture at a time.
  const before=(await edits()).length;
  await workspace.focus();await page.keyboard.press('Control+Z');await idle();
  assert.equal((await edits()).length,before-1);

  // A finalized document refuses: the menu says why and its actions stay focusable but unavailable.
  await clickWorkspaceCommand(page,'Finalize document');
  const locked=(await edits()).length;
  await dbl(symbol('Nocturne'));
  const item=popover.getByRole('menuitem',{name:'Edit title…'});await item.waitFor();
  assert.equal(await item.getAttribute('aria-disabled'),'true');assert.equal(await item.getAttribute('disabled'),null);
  await item.click({force:true});assert.equal(await popover.getByRole('textbox').count(),0);
  await page.keyboard.press('Escape');await popover.waitFor({state:'detached'});
  assert.equal((await edits()).length,locked);
  await page.waitForFunction(async()=>{const status=await window.__TAURI_INTERNALS__.invoke('audio_status');if(status.error)throw new Error(status.error);return status.ready;},undefined,{timeout:20000});
  assert.deepEqual(errors,[]);
  console.log('symbol editing: title, tempo, chord name and clef were edited in place and from a context menu as undoable edits; the current value, Escape and a locked document recorded nothing.');
}catch(error){if(page)console.error('Popover at failure:',await page.evaluate(()=>({popover:document.querySelector('.score-symbol-popover')?.innerText??null,lastEvents:window.__gestures.slice(-4)})).then(JSON.stringify).catch(()=>'unreadable'));if(page)await page.screenshot({path:resolve('.analysis/parity/symbol-editing-failure.png')}).catch(()=>{});throw error;}
finally{if(browser)await browser.close().catch(()=>{});stop(id);}
