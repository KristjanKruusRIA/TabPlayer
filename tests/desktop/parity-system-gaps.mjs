import {waitForWorkspaceIdle,clickWorkstationButton} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {directory,launch,connect,stop} from './harness.mjs';
import {buildEngravingFixture,fixturePath} from './engraving-fixture.mjs';

// Per-system gaps (D08): in the vertical page view, a gap set on one system moves that system and the
// ones stacked after it on its page, by (scale - 1) x 20 x (system spacing or 1) x render scale, and
// leaves earlier systems alone. The exported PDF pages carry the same extra offset above the same system.
// Reset selected returns only its system, Reset all returns every one, every step undoes and redoes, the
// gaps save and reopen, and the native playback generation never changes (a gap edit is a settings edit).
await buildEngravingFixture();
const evidenceDirectory=resolve('.analysis/parity');mkdirSync(evidenceDirectory,{recursive:true});
const saved=resolve(directory,'gp8-system-gaps.tabplayer'),exported=resolve(directory,'gp8-system-gaps'),pdf=`${exported}.pdf`;
// The engraving fixture has 12 bars in five systems: bars 1-2, 3-4, 5-8, 9-10 and 11-12 (1-based).
const SYSTEMS=[[1,2],[3,4],[5,8],[9,10],[11,12]],SYSTEM_COUNT=SYSTEMS.length,STANDARD_GAP=20,TOLERANCE=0.01;
const THIRD=2,FOURTH=3,thirdBar=SYSTEMS[THIRD][0],fourthBar=SYSTEMS[FOURTH][0];
const result={fixture:fixturePath,checks:[]},failures=[];
const check=async(name,body)=>{
  try{const detail=await body();console.log(`PASS ${name}${detail?` - ${detail}`:''}`);result.checks.push({name,pass:true,detail:detail??null});}
  catch(error){const message=error instanceof Error?error.message:String(error);console.log(`FAIL ${name} - ${message.split('\n')[0]}`);failures.push(name);result.checks.push({name,pass:false,detail:message});}
};
const findKey=(value,key)=>{
  if(value===null||typeof value!=='object')return undefined;
  if(Object.hasOwn(value,key))return value[key];
  for(const child of Object.values(value)){const found=findKey(child,key);if(found!==undefined)return found;}
  return undefined;
};
// The gaps the document carries now: those of its last setEngraving edit (an absent field is none).
const documentGaps=project=>{const last=[...project.edits].reverse().find(edit=>edit.type==='setEngraving');return last?findKey(last,'systemGaps')??[]:[];};
// Expected tops: each system keeps its baseline top plus the offsets of the systems before it and itself
// on the same page. The first system of the score and a system that starts a page take no offset.
const expectedTops=(base,gaps,unit)=>{
  let sum=0,sheet=null;
  return base.map((system,index)=>{
    const starts=index===0||system.sheet!==sheet;if(system.sheet!==sheet){sheet=system.sheet;sum=0;}
    if(!starts)sum+=((gaps[index]??1)-1)*unit;
    return system.top+sum;
  });
};
const near=(actual,expected,label)=>actual.forEach((value,index)=>assert.ok(Math.abs(value-expected[index])<=TOLERANCE,`${label}: system ${index+1} is at ${value}, expected ${expected[index]} (+/- ${TOLERANCE})`));

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
  const snapshot=()=>readActiveDocument(page);
  const status=()=>page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('audio_status'));
  const waitStatus=async predicate=>{const deadline=Date.now()+15000;while(Date.now()<deadline){const value=await status();if(predicate(value))return value;await page.waitForTimeout(25);}throw new Error(`Audio status timeout: ${JSON.stringify(await status())}`);};
  // The chunks on screen, in page order. The last five are the systems; anything before them (title block) is not.
  const readScreen=()=>page.evaluate(()=>[...document.querySelectorAll('.score-sheet')].flatMap((sheet,index)=>[...sheet.querySelectorAll('.score-svg-chunk')].map(chunk=>({sheet:index,top:parseFloat(chunk.style.top),factor:Number(/scale\(([^)]+)\)/.exec(chunk.style.transform)?.[1])}))));
  // Repagination is synchronous with the edit, but wait for two equal reads so a pending frame cannot give a stale top.
  const screen=async()=>{
    let previous=null;
    for(let attempt=0;attempt<60;attempt++){
      const chunks=await readScreen(),key=JSON.stringify(chunks);
      if(chunks.length>=SYSTEM_COUNT&&key===previous)return chunks.slice(-SYSTEM_COUNT);
      previous=key;await page.waitForTimeout(100);
    }
    throw new Error('The vertical page view did not settle.');
  };
  const exportPdf=async()=>{
    await clickWorkstationButton(page,'Export score',{waitForIdle:false});const dialog=page.getByRole('dialog',{name:'Export score'});await dialog.getByLabel('Export format').selectOption('pdf');
    await dialog.getByRole('button',{name:'Export',exact:true}).click();
    await Promise.race([dialog.waitFor({state:'hidden',timeout:30000}),dialog.getByRole('alert').waitFor({timeout:30000}).then(async()=>{throw new Error(await dialog.getByRole('alert').textContent());})]);await dialog.waitFor({state:'hidden',timeout:30000});await idle();
    assert.equal(readFileSync(pdf).subarray(0,5).toString(),'%PDF-');
    // Each page's top-level system groups: translate(left top) is the system's position on that page.
    const pages=await page.evaluate(()=>window.__tabplayerTestExportPages.at(-1).map(sheet=>[...new DOMParser().parseFromString(sheet.svg,'image/svg+xml').querySelectorAll('svg > g[transform^="translate("]')].map(group=>Number(/translate\(\s*[-\d.e+]+[ ,]+([-\d.e+]+)\s*\)/.exec(group.getAttribute('transform'))[1]))));
    const systems=pages.flatMap((tops,index)=>tops.map(top=>({sheet:index,top})));
    assert.ok(systems.length>=SYSTEM_COUNT,`expected at least ${SYSTEM_COUNT} exported systems, got ${systems.length}`);
    return systems.slice(-SYSTEM_COUNT);
  };
  // Selects a bar (the caret's bar picks the system) from the Edit tab, then shows the Presentation tools.
  const selectBar=async bar=>{
    await button('Edit');await field('Measure').fill(String(bar));await field('Measure').press('Tab');await idle();
    await button('Presentation');await details('Design: system gaps');
    const system=SYSTEMS.find(([first,last])=>bar>=first&&bar<=last);
    await page.getByRole('status').filter({hasText:'Selected system:'}).filter({hasText:`bars ${system[0]} to ${system[1]}.`}).waitFor({timeout:10000});
  };
  const setGap=async percent=>{await details('Design: system gaps');const input=field('System gap (%)');await input.fill(String(percent));await input.press('Enter');await idle();};
  const gapButton=async name=>{await details('Design: system gaps');await page.getByRole('button',{name,exact:true}).click();await idle();};
  const generations=[];
  const generation=async label=>{const value=(await status()).generation;generations.push({label,generation:value});return value;};

  await button('Open');await waitStatus(value=>value.ready&&!value.error);await page.locator('[aria-label="Music notation"] svg').first().waitFor();
  const baselineGeneration=await generation('opened');assert.ok(Number.isInteger(baselineGeneration),'the native audio status reports an integer generation');
  await button('Presentation');await details('Page layout');await field('Width (mm)').fill('210');await field('Height (mm)').fill('297');await button('Apply page layout');
  await page.getByRole('combobox',{name:'Display mode',exact:true}).selectOption('verticalPage');
  // The units the offsets are in: system spacing and render (page) scale as the panels show them.
  await details('Engraving');await details('Page layout');
  const spacingText=await field('System spacing (%)').inputValue(),systemSpacing=spacingText===''?1:Number(spacingText)/100,pageScale=Number(await field('Scale (%)').inputValue())/100;
  assert.ok(Number.isFinite(systemSpacing)&&systemSpacing>0&&Number.isFinite(pageScale)&&pageScale>0,'system spacing and page scale are readable');
  const exportUnit=STANDARD_GAP*systemSpacing*pageScale;
  const baseScreen=await screen(),screenUnit=exportUnit*baseScreen[0].factor;
  const baseExport=await exportPdf();
  const baseProject=(await snapshot()).project;
  result.units={systemSpacing,pageScale,screenFactor:baseScreen[0].factor,exportUnit,screenUnit};
  result.baseline={screen:baseScreen,export:baseExport};

  // One state of the document: its gaps by system index, and what the screen and the export must show for them.
  const verify=async(label,gaps,{withExport})=>{
    const shown=await screen();
    assert.deepEqual(shown.map(system=>system.sheet),baseScreen.map(system=>system.sheet),`${label}: the screen keeps every system on its page`);
    near(shown.map(system=>system.top),expectedTops(baseScreen,gaps,screenUnit),`${label} (screen)`);
    if(withExport){
      const out=await exportPdf();
      assert.deepEqual(out.map(system=>system.sheet),baseExport.map(system=>system.sheet),`${label}: the export keeps every system on its page`);
      near(out.map(system=>system.top),expectedTops(baseExport,gaps,exportUnit),`${label} (export)`);
    }
  };
  const stateA={[THIRD]:2},stateB={[THIRD]:2,[FOURTH]:1.5},stateC={[THIRD]:2},stateD={};

  await check('baseline: the third system is not the first system of a page',async()=>{
    assert.ok(baseScreen[THIRD].sheet===baseScreen[THIRD-1].sheet&&baseExport[THIRD].sheet===baseExport[THIRD-1].sheet,'a gap is dropped above a system that starts a page');
    assert.deepEqual(documentGaps(baseProject),[]);
    return `screen pages ${JSON.stringify(baseScreen.map(system=>system.sheet))}, export pages ${JSON.stringify(baseExport.map(system=>system.sheet))}`;
  });

  // Step 1: select a bar in the third system and set 200%.
  await selectBar(thirdBar);
  await check('baseline: the system gap field shows 100% for the selected third system',async()=>{assert.equal(await field('System gap (%)').inputValue(),'100');});
  await setGap(200);const afterA=await snapshot();
  await check('set 200% on the third system: one setEngraving edit carrying one gap at its first bar',async()=>{
    assert.equal(afterA.project.edits.length,baseProject.edits.length+1);assert.equal(afterA.project.edits.at(-1).type,'setEngraving');
    assert.deepEqual(documentGaps(afterA.project),[{bar:SYSTEMS[THIRD][0]-1,scale:2}]);
  });
  await check('set 200% on the third system: its screen top moves down by the standard gap, earlier systems do not move',async()=>{
    await verify('state A',stateA,{withExport:false});
    const shown=await screen(),moved=shown.map((system,index)=>system.top-baseScreen[index].top);
    assert.deepEqual(moved.slice(0,THIRD).map(value=>Math.abs(value)<=TOLERANCE),Array(THIRD).fill(true),`earlier systems moved: ${JSON.stringify(moved)}`);
    assert.ok(Math.abs(moved[THIRD]-screenUnit)<=TOLERANCE,`third system moved ${moved[THIRD]}, expected ${screenUnit}`);
    return `moved ${JSON.stringify(moved.map(value=>Math.round(value*100)/100))} px, expected ${Math.round(screenUnit*100)/100} px`;
  });
  await check('set 200% on the third system: the exported PDF shows the same extra offset above it',async()=>{
    const out=await exportPdf(),moved=out.map((system,index)=>system.top-baseExport[index].top);
    assert.deepEqual(out.map(system=>system.sheet),baseExport.map(system=>system.sheet));
    near(out.map(system=>system.top),expectedTops(baseExport,stateA,exportUnit),'state A (export)');
    assert.ok(Math.abs(moved[THIRD]-exportUnit)<=TOLERANCE,`exported third system moved ${moved[THIRD]}, expected ${exportUnit}`);
    assert.ok(moved.slice(0,THIRD).every(value=>Math.abs(value)<=TOLERANCE),`earlier exported systems moved: ${JSON.stringify(moved)}`);
    return `moved ${JSON.stringify(moved.map(value=>Math.round(value*100)/100))}, expected ${Math.round(exportUnit*100)/100}`;
  });
  await check('choosing the current value records nothing',async()=>{
    await setGap(200);assert.equal((await snapshot()).project.edits.length,afterA.project.edits.length);
  });

  // Step 2: a second system (the fourth) at 150%.
  await selectBar(fourthBar);await setGap(150);const afterB=await snapshot();
  await check('set 150% on a second system: one more edit and both gaps are carried',async()=>{
    assert.equal(afterB.project.edits.length,afterA.project.edits.length+1);
    assert.deepEqual(documentGaps(afterB.project),[{bar:SYSTEMS[THIRD][0]-1,scale:2},{bar:SYSTEMS[FOURTH][0]-1,scale:1.5}]);
    await verify('state B',stateB,{withExport:true});
  });

  // Step 3: reset the selected (fourth) system: only it returns.
  await gapButton('Reset selected system');const afterC=await snapshot();
  await check('reset selected system: only the fourth system returns, the third keeps its gap',async()=>{
    assert.equal(afterC.project.edits.length,afterB.project.edits.length+1);
    assert.deepEqual(documentGaps(afterC.project),[{bar:SYSTEMS[THIRD][0]-1,scale:2}]);
    await verify('state C',stateC,{withExport:true});
  });

  // Step 4: reset all: every system returns, and the field is gone from the document.
  await gapButton('Reset all system gaps');const afterD=await snapshot();
  await check('reset all: every system returns to its baseline top, on screen and in the PDF',async()=>{
    assert.equal(afterD.project.edits.length,afterC.project.edits.length+1);
    assert.deepEqual(documentGaps(afterD.project),[]);
    await verify('state D',stateD,{withExport:true});
    const shown=await screen();near(shown.map(system=>system.top),baseScreen.map(system=>system.top),'reset all (screen vs baseline)');
  });
  await check('the reset buttons are unavailable once nothing is left to reset',async()=>{
    await details('Design: system gaps');
    for(const name of ['Reset selected system','Reset all system gaps']){const target=page.getByRole('button',{name,exact:true});assert.equal(await target.getAttribute('aria-disabled'),'true',`${name} is aria-disabled`);assert.equal(await target.isDisabled(),false,`${name} keeps focusability (never disabled)`);}
  });

  // Undo each step, then redo each step.
  const undoStates=[[afterC,stateC],[afterB,stateB],[afterA,stateA],[{project:baseProject},{}]];
  for(const [index,[expected,gaps]] of undoStates.entries()){
    await button('Undo');const now=await snapshot();
    await check(`undo ${index+1}/4 restores the earlier state`,async()=>{
      assert.deepEqual(now.project,expected.project);await verify(`undo ${index+1}`,gaps,{withExport:index===0||index===3});
    });
  }
  const redoStates=[[afterA,stateA],[afterB,stateB],[afterC,stateC],[afterD,stateD]];
  for(const [index,[expected,gaps]] of redoStates.entries()){
    await button('Redo');const now=await snapshot();
    await check(`redo ${index+1}/4 replays the step`,async()=>{
      assert.deepEqual(now.project,expected.project);await verify(`redo ${index+1}`,gaps,{withExport:index===0||index===3});
    });
  }

  // Save with a gap in the document (undo the last reset), then reopen.
  await button('Undo');
  const storedBefore=await snapshot();
  await button('Save');const stored=await snapshot();
  await check('save leaves the document clean with the gap in it',async()=>{
    assert.equal(stored.dirty,false);assert.deepEqual(documentGaps(stored.project),[{bar:SYSTEMS[THIRD][0]-1,scale:2}]);assert.deepEqual(stored.project,storedBefore.project);
  });
  await check('native playback generation is unchanged across every gap edit, undo and redo',async()=>{
    const final=await generation('after all gap edits');
    assert.equal(final,baselineGeneration,`generation went from ${baselineGeneration} to ${final}`);
    const live=await status();assert.equal(live.playing,false);assert.equal(live.generation,baselineGeneration);
    return `generation ${baselineGeneration} (idle; no playback was started)`;
  });
  await check('no page errors',async()=>{assert.deepEqual(errors,[]);});
  await browser.close();browser=null;stop(id);

  id=launch({TABPLAYER_TEST_OPEN:saved,TABPLAYER_TEST_EXPORT:exported});browser=await connect();page=browser.contexts()[0].pages()[0];await waitForWorkspaceIdle(page);await closeLibrary();await button('Open');
  await check('reopen: the project (history and gaps) is identical',async()=>{assert.deepEqual((await snapshot()).project,stored.project);});
  await button('Presentation');await page.getByRole('combobox',{name:'Display mode',exact:true}).selectOption('verticalPage');
  await check('reopen: the saved gap is on screen and in the exported PDF',async()=>{await verify('reopened',stateC,{withExport:true});});
  await check('reopen: the saved gap shows in the panel and resets',async()=>{
    await selectBar(thirdBar);assert.equal(await field('System gap (%)').inputValue(),'200');
    await gapButton('Reset selected system');assert.deepEqual(documentGaps((await snapshot()).project),[]);await verify('reopened reset',stateD,{withExport:false});
  });
  result.generations=generations;
}catch(error){
  const message=error instanceof Error?error.message:String(error);console.log(`FAIL driver - ${message.split('\n')[0]}`);failures.push('driver');result.checks.push({name:'driver',pass:false,detail:message});
  if(page)await page.screenshot({path:resolve(evidenceDirectory,'system-gaps-failure.png')}).catch(()=>{});
}finally{
  if(browser)await browser.close().catch(()=>{});stop(id);
  result.failures=failures;result.passed=result.checks.filter(item=>item.pass).length;
  writeFileSync(resolve(evidenceDirectory,'system-gaps-result.json'),JSON.stringify(result,null,2));
  console.log(`system-gaps: ${result.passed} passed, ${failures.length} failed${failures.length?` (${failures.join('; ')})`:''}.`);
  if(failures.length)process.exitCode=1;
}
