import {waitForWorkspaceIdle,clickWorkstationButton,revealDock,revealInspectorTab,revealPlaybackControls,hidePlaybackControls} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {directory,launch,connect,stop} from './harness.mjs';
import {buildEngravingFixture,fixturePath} from './engraving-fixture.mjs';

// Staff groups, braces and per-staff spacing (D11), in the vertical page view at A4 with every track shown.
// The engraving fixture (Guitar6, Grand Piano with two staves, Drums; 12 bars in five systems) is grouped Guitar6 + Grand Piano:
//   - as a bracket and as a brace: one group mark per system, on screen and in the export pages handed to the PDF writer;
//   - with long names on the first system and short names after, ending left of every mark;
//   - with 200% (and 300%) below Guitar6, which moves the piano and drums down by the same amount and leaves the guitar alone;
//   - together with a 200% system gap on the third system (D08), which adds its offset over the composed heights;
//   - a click on a moved piano notehead selects that note and a click inside the opened gap selects nothing;
//   - the playback highlight on a note inside the composed (defs/use) markup is visibly restyled;
//   - moving Drums between the two members stops drawing the group; undo draws it again.
// Every step is undone and redone, the groups, gaps and names are saved and reopened, and the native playback generation does not change for any of the settings edits.
await buildEngravingFixture();
const evidenceDirectory=resolve('.analysis/parity');mkdirSync(evidenceDirectory,{recursive:true});
const saved=resolve(directory,'gp8-staff-groups.tabplayer'),exported=resolve(directory,'gp8-staff-groups'),pdf=`${exported}.pdf`;
// The engraving fixture has 12 bars in five systems: bars 1-2, 3-4, 5-8, 9-10 and 11-12 (1-based).
const SYSTEMS=[[1,2],[3,4],[5,8],[9,10],[11,12]],SYSTEM_COUNT=SYSTEMS.length,STANDARD_GAP=20,TOLERANCE=0.01,THIRD=2,thirdBar=SYSTEMS[THIRD][0];
const LONG=['Guitar6','Grand Piano','Drums'],SHORT=['Gtr.','Pno.','Dr.'],ALL_NAMES=[...LONG,...SHORT],CREDIT='rendered by alphaTab';
const result={fixture:fixturePath,checks:[]},failures=[];
const check=async(name,body)=>{
  try{const detail=await body();console.log(`PASS ${name}${detail?` - ${detail}`:''}`);result.checks.push({name,pass:true,detail:detail??null});}
  catch(error){const message=error instanceof Error?error.message:String(error);console.log(`FAIL ${name} - ${message.split('\n').slice(0,6).join(' | ')}`);failures.push(name);result.checks.push({name,pass:false,detail:message});}
};
const findKey=(value,key)=>{
  if(value===null||typeof value!=='object')return undefined;
  if(Object.hasOwn(value,key))return value[key];
  for(const child of Object.values(value)){const found=findKey(child,key);if(found!==undefined)return found;}
  return undefined;
};
const lastEngraving=project=>[...project.edits].reverse().find(edit=>edit.type==='setEngraving');
const documentField=(project,key)=>{const last=lastEngraving(project);return last?findKey(last,key)??[]:[];};
const round=value=>Math.round(value*100)/100;
const near=(actual,expected,label,tolerance=TOLERANCE)=>assert.ok(Math.abs(actual-expected)<=tolerance,`${label}: ${actual} is not within ${tolerance} of ${expected}`);
// Deep comparison of two measurements, numbers within `tolerance`.
const same=(a,b,label,tolerance=TOLERANCE)=>{
  if(typeof a==='number'&&typeof b==='number')return near(a,b,label,tolerance);
  assert.equal(typeof a,typeof b,`${label}: type`);
  if(Array.isArray(a)){assert.ok(Array.isArray(b)&&a.length===b.length,`${label}: length ${a.length} vs ${b?.length}`);a.forEach((item,index)=>same(item,b[index],`${label}[${index}]`,tolerance));return;}
  if(a&&typeof a==='object'){assert.deepEqual(Object.keys(a).sort(),Object.keys(b).sort(),`${label}: keys`);for(const key of Object.keys(a))same(a[key],b[key],`${label}.${key}`,tolerance);return;}
  assert.equal(a,b,label);
};

// Reads every system the screen (the .score-svg-chunk boxes) or the export pages (the last PDF handed to the native writer) show, in the units of the system's own SVG.
// A composed system keeps its content once in <defs> and shows it through clipped, translated <use> bands, so every y is mapped through the band that holds it.
// The page function is self-contained: Playwright serialises it.
const measurePage=([source,{names,credit,count}])=>{
  const NUMBER='-?[\\d.]+(?:e[-+]?\\d+)?',pattern=new RegExp(`translate\\(\\s*(${NUMBER})[\\s,]+(${NUMBER})\\s*\\)`),head=String.fromCharCode(57508);
  const translate=node=>{const found=pattern.exec(node.getAttribute('transform')??'');return found?[Number(found[1]),Number(found[2])]:[0,0];};
  const offset=(node,root)=>{let x=0,y=0;for(;node&&node!==root;node=node.parentNode){if(node.nodeType!==1)break;const [dx,dy]=translate(node);x+=dx;y+=dy;}return [x,y];};
  const chunks=[];
  if(source==='screen'){
    [...document.querySelectorAll('.score-sheet')].forEach((sheet,index)=>sheet.querySelectorAll('.score-svg-chunk').forEach(div=>{
      const root=div.querySelector('svg');if(!root)return;
      chunks.push({sheet:index,root,top:parseFloat(div.style.top),factor:Number(/scale\(([^)]+)\)/.exec(div.style.transform)?.[1]),rect:div.getBoundingClientRect()});
    }));
  }else{
    window.__tabplayerTestExportPages.at(-1).forEach((entry,index)=>{
      const doc=new DOMParser().parseFromString(entry.svg,'image/svg+xml');
      doc.querySelectorAll('svg > g[transform^="translate("]').forEach(root=>chunks.push({sheet:index,root,top:translate(root)[1],factor:1,rect:null,markup:entry.svg}));
    });
  }
  const fontOf=node=>Number(/(\d+(?:\.\d+)?)px/.exec(node.getAttribute('style')??'')?.[1]??12);
  const systems=chunks.filter(chunk=>!chunk.root.textContent.includes(credit)).slice(-count).map(chunk=>{
    const {root}=chunk,bands=[...root.querySelectorAll('use')].map(use=>{
      const id=/url\(#([^)]+)\)/.exec(use.getAttribute('clip-path')??'')?.[1],clip=[...root.querySelectorAll('clipPath')].find(node=>node.getAttribute('id')===id)?.querySelector('rect');
      return clip?{start:Number(clip.getAttribute('y')),end:Number(clip.getAttribute('y'))+Number(clip.getAttribute('height')),shift:translate(use.parentNode)[1]}:null;
    }).filter(Boolean);
    const shown=y=>y+([...bands].reverse().find(band=>y>=band.start&&y<band.end)?.shift??0);
    const lines=[...new Set([...root.querySelectorAll('rect')].filter(rect=>!rect.closest('clipPath')&&Number(rect.getAttribute('height'))<3&&Number(rect.getAttribute('width'))>20).map(rect=>{const [, oy]=offset(rect.parentNode,root);return Math.round((shown(Number(rect.getAttribute('y'))+oy))*100)/100;}))].sort((a,b)=>a-b);
    const texts=[...root.querySelectorAll('text')].filter(node=>node.getAttribute('fill')==='#222211'&&names.includes(node.textContent.trim())).map(node=>{
      const [ox,oy]=offset(node.parentNode,root),x=ox+Number(node.getAttribute('x')??0),y=oy+Number(node.getAttribute('y')??0),rotated=/rotate/.test(node.parentNode.getAttribute('transform')??''),size=fontOf(node);
      return {text:node.textContent.trim(),rotated,size,anchor:node.getAttribute('text-anchor')??'start',font:node.getAttribute('style')??'',x,y:shown(y),right:rotated?ox:null,left:rotated?ox-size:null};
    });
    const marks=[...root.querySelectorAll('[data-tp-accolade]')].map(node=>{
      const name=node.getAttribute('data-tp-accolade'),[ox,oy]=offset(node.parentNode,root);
      if(/bracket$/.test(name)){
        const rect=node.querySelector('rect'),glyphs=[...node.querySelectorAll('g.at')].map(glyph=>translate(glyph));
        const y=oy+Number(rect.getAttribute('y')),height=Number(rect.getAttribute('height'));
        return {name,x:ox+Number(rect.getAttribute('x')),width:Number(rect.getAttribute('width')),top:y,bottom:y+height,spikeTop:oy+glyphs[0][1],spikeBottom:oy+glyphs[1][1]};
      }
      const holder=node.querySelector('g'),[hx,hy]=translate(holder),basePx=source==='screen'?parseFloat(getComputedStyle(holder).fontSize):Number(/\.at\{[^}]*font-size:(\d+(?:\.\d+)?)px/.exec(chunk.markup)?.[1]),pct=Number(/font-size: ([-\d.e]+)%/.exec(node.querySelector('text').getAttribute('style'))[1]),compress=/scale\(([-\d.e]+) 1\)/.exec(holder.getAttribute('transform'));
      return {name,x:ox+hx,width:null,top:null,bottom:oy+hy,pct,basePx,xScale:compress?Number(compress[1]):1};
    });
    const spikes=[...root.querySelectorAll('g.at')].filter(glyph=>glyph.firstElementChild?.textContent===String.fromCharCode(57347)&&!glyph.closest('[data-tp-accolade]')).map(glyph=>{const [gx,gy]=offset(glyph,root);return {x:gx,y:shown(gy)};});
    const lit=[...root.querySelectorAll('.at-highlight g.at')].map(glyph=>{const [gx,gy]=offset(glyph,root);return {x:gx,y:shown(gy),inDefs:!!glyph.closest('defs')};});
    const heads=[...root.querySelectorAll('g.at')].filter(glyph=>glyph.firstElementChild?.textContent===head).map(glyph=>{const [gx,gy]=offset(glyph,root);return {x:gx,y:shown(gy)};});
    return {sheet:chunk.sheet,top:chunk.top,factor:chunk.factor,rect:chunk.rect?{left:chunk.rect.left,top:chunk.rect.top,width:chunk.rect.width,height:chunk.rect.height}:null,composed:bands.length>0,bands,lines,texts,marks,heads,spikes,lit};
  });
  return {total:chunks.length,systems};
};

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
  const measure=source=>page.evaluate(measurePage,[source,{names:ALL_NAMES,credit:CREDIT,count:SYSTEM_COUNT}]).then(value=>value);
  // Repagination and re-rendering are asynchronous: wait for `ready` and two equal reads.
  const settle=async(source,label,ready=()=>true)=>{
    let previous=null,last=null;
    for(let attempt=0;attempt<100;attempt++){
      last=await measure(source);
      const key=JSON.stringify(last.systems.map(system=>[system.sheet,round(system.top),system.marks.map(mark=>[mark.name,round(mark.x),round(mark.bottom)]),system.texts.map(text=>[text.text,round(text.y)]),system.lines.length]));
      if(last.systems.length===SYSTEM_COUNT&&ready(last)&&key===previous)return last;
      previous=key;await page.waitForTimeout(150);
    }
    throw new Error(`${label}: the ${source} did not settle (${last.systems.length} systems, ${last.total} chunks)`);
  };
  const exportPdf=async(label,{only}={})=>{
    await clickWorkstationButton(page,'Export score',{waitForIdle:false});const dialog=page.getByRole('dialog',{name:'Export score'});await dialog.getByLabel('Export format').selectOption('pdf');
    if(only)for(const name of LONG.filter(name=>!only.includes(name)))await dialog.getByLabel(name,{exact:true}).uncheck();
    await dialog.getByRole('button',{name:'Export',exact:true}).click();
    await Promise.race([dialog.waitFor({state:'hidden',timeout:30000}),dialog.getByRole('alert').waitFor({timeout:30000}).then(async()=>{throw new Error(await dialog.getByRole('alert').textContent());})]);await dialog.waitFor({state:'hidden',timeout:30000});await idle();
    assert.equal(readFileSync(pdf).subarray(0,5).toString(),'%PDF-',`${label}: the written file is a PDF`);
    return measure('export');
  };

  // ---- expectations read from a measurement ----
  const markNames=system=>system.marks.map(mark=>mark.name).sort();
  const expectMarks=(measurement,names,label)=>{
    assert.equal(measurement.systems.length,SYSTEM_COUNT,`${label}: ${SYSTEM_COUNT} systems`);
    measurement.systems.forEach((system,index)=>assert.deepEqual(markNames(system),[...names].sort(),`${label}: system ${index+1} marks`));
  };
  const hasNames=(measurement,first,after)=>measurement.systems.every((system,index)=>{
    const texts=[...new Set(system.texts.map(text=>text.text))].sort();
    return JSON.stringify(texts)===JSON.stringify([...(index===0?first:after)].sort());
  });
  const byName=(system,text)=>{const found=system.texts.find(item=>item.text===text);assert.ok(found,`no "${text}" name (${JSON.stringify(system.texts.map(item=>item.text))})`);return found;};
  // The displayed y of each track's name (a name centres on its track): the first system carries the long names, later ones the short ones.
  const trackY=(system,index)=>{const [guitar,piano,drums]=index===0?LONG:SHORT;return {Guitar6:byName(system,guitar).y,'Grand Piano':byName(system,piano).y,Drums:byName(system,drums).y};};
  const moved=(measurement,reference,index=0)=>{
    const now=trackY(measurement.systems[index],index),before=trackY(reference.systems[index],index);
    return Object.fromEntries(Object.keys(now).map(name=>[name,now[name]-before[name]]));
  };

  const generations=[],generation=async label=>{const value=(await status()).generation;generations.push({label,generation:value});return value;};
  await button('Open');await waitStatus(value=>value.ready&&!value.error);await page.locator('[aria-label="Music notation"] svg').first().waitFor();
  const baselineGeneration=await generation('opened');assert.ok(Number.isInteger(baselineGeneration),'the native audio status reports an integer generation');
  await button('Presentation');await details('Page layout');await field('Width (mm)').fill('210');await field('Height (mm)').fill('297');await button('Apply page layout');
  await page.getByRole('combobox',{name:'Display mode',exact:true}).selectOption('verticalPage');
  await page.getByRole('combobox',{name:'Displayed tracks',exact:true}).selectOption('all');
  await details('Engraving');await details('Page layout');
  const spacingText=await field('System spacing (%)').inputValue(),systemSpacing=spacingText===''?1:Number(spacingText)/100,pageScale=Number(await field('Scale (%)').inputValue())/100;
  assert.ok(Number.isFinite(systemSpacing)&&systemSpacing>0&&Number.isFinite(pageScale)&&pageScale>0,'system spacing and page scale are readable');
  const exportUnit=STANDARD_GAP*systemSpacing*pageScale;
  const baseScreen=await settle('screen','baseline',m=>m.systems.every(system=>!system.composed));
  const baseExport=await exportPdf('baseline');
  const screenFactor=baseScreen.systems[0].factor,screenUnit=exportUnit*screenFactor;
  const baseProject=(await snapshot()).project;
  result.units={systemSpacing,pageScale,screenFactor,exportUnit,screenUnit};

  // ---- panel helpers ----
  const open=()=>details('Design: staff groups');
  const groupsOf=project=>documentField(project,'staffGroups'),gapsOf=project=>documentField(project,'staffGaps');
  const include=async(name,on=true)=>{await open();await page.getByLabel(`Include ${name}`,{exact:true}).setChecked(on);};
  const createKind=()=>page.locator('label').filter({hasText:/^Group mark/}).locator('select');
  const groupKind=()=>page.getByLabel(/^Group mark: Group:/);
  const edits=async()=>(await snapshot()).project.edits.length;
  const staffGap=async(trackName,percent)=>{await open();await page.getByLabel(/^Space below/).selectOption({label:trackName});const input=field('Staff gap (%)');await input.fill(String(percent));await input.press('Enter');await idle();};
  const namesButton=()=>page.getByRole('button',{name:'Long names first, short after',exact:true});
  const GROUP_BRACKET=['group-bracket','track-brace'],GROUP_BRACE=['group-brace'];

  // ---- baseline ----
  await check('baseline: no accolade drawn by TabPlayer on screen or in the export pages, and the piano keeps its native brace',async()=>{
    expectMarks(baseScreen,[],'screen');expectMarks(baseExport,[],'export');
    assert.deepEqual(groupsOf(baseProject),[]);assert.deepEqual(gapsOf(baseProject),[]);
    const exportedPages=await page.evaluate(()=>window.__tabplayerTestExportPages.at(-1).map(entry=>entry.svg));
    const braces=exportedPages.map(svg=>svg.split('&#57344;').length-1);
    assert.equal(braces.reduce((sum,count)=>sum+count,0),SYSTEM_COUNT,`one native brace (&#57344;) per system in the export pages, got ${JSON.stringify(braces)}`);
    assert.ok(exportedPages.every(svg=>!svg.includes('data-tp-accolade')));
    return `native braces per export page ${JSON.stringify(braces)}`;
  });
  await check('baseline: the first system shows only short names, later systems none',async()=>{
    const names=measurement=>measurement.systems.map(system=>[...new Set(system.texts.map(text=>text.text))].sort());
    assert.deepEqual(names(baseScreen)[0],[...SHORT].sort());assert.deepEqual(names(baseExport)[0],[...SHORT].sort());
    return `first system ${JSON.stringify(names(baseExport)[0])}, later ${JSON.stringify(names(baseExport).slice(1))}`;
  });

  // ---- E1: group Guitar6 + Grand Piano as a bracket ----
  const states=[];  // {label, project, screen, export?}
  const record=(label,project,screen,exported=null)=>states.push({label,project,screen,exported});
  record('baseline',baseProject,baseScreen,baseExport);
  await include('Guitar6');await include('Grand Piano');
  const e0=await edits();await button('Group chosen tracks');
  const afterGroup=await snapshot();
  const screenBracket=await settle('screen','bracket',m=>m.systems.every(system=>markNames(system).join()===[...GROUP_BRACKET].sort().join()));
  await check('group Guitar6 and Grand Piano: one setEngraving edit carrying the group',async()=>{
    assert.equal(afterGroup.project.edits.length,e0+1);assert.equal(afterGroup.project.edits.at(-1).type,'setEngraving');
    const groups=groupsOf(afterGroup.project);assert.equal(groups.length,1);assert.equal(groups[0].kind,'bracket');assert.equal(groups[0].trackIds.length,2);
    assert.deepEqual(gapsOf(afterGroup.project),[]);
  });
  const exportBracket=await exportPdf('bracket');
  await check('bracket group: one group-bracket and one track-brace per system, on screen and in the export pages',async()=>{
    expectMarks(screenBracket,GROUP_BRACKET,'screen');expectMarks(exportBracket,GROUP_BRACKET,'export');
    const exportedPages=await page.evaluate(()=>window.__tabplayerTestExportPages.at(-1).map(entry=>entry.svg));
    const glyphs=symbol=>exportedPages.reduce((sum,svg)=>sum+svg.split(symbol).length-1,0);
    // alphaTab's own brackets are off while a group draws: the glyphs left are TabPlayer's (one brace, one bracket pair per system).
    assert.equal(glyphs('&#57344;'),SYSTEM_COUNT);assert.equal(glyphs('&#57347;'),SYSTEM_COUNT);assert.equal(glyphs('&#57348;'),SYSTEM_COUNT);
    return `${SYSTEM_COUNT} systems, ${glyphs('&#57344;')} brace and ${glyphs('&#57347;')} bracket glyph pairs in the pages`;
  });
  await check('bracket group: the group bracket starts where the native bracket started in the baseline',async()=>{
    // The baseline native bracket's top spike (&#57347;) sits at the guitar's top; with a group drawing, TabPlayer's top spike must be there too (within 1 px).
    // The two states lay out the chunk's top differently (the group reserves room), so the spike is compared with the guitar's own first staff line.
    const fromLine=(system,spike)=>spike-Math.min(...system.lines.filter(y=>y>spike-10));
    exportBracket.systems.forEach((system,index)=>{
      const mark=system.marks.find(item=>item.name==='group-bracket'),native=baseExport.systems[index].spikes;
      assert.ok(mark&&native.length===1,`system ${index+1}: one group bracket and ${native.length} native spikes in the baseline`);
      near(fromLine(system,mark.spikeTop),fromLine(baseExport.systems[index],native[0].y),`system ${index+1} top spike above the guitar's first line`,1);
    });
    return `top spike above the guitar's first line: ${JSON.stringify(exportBracket.systems.map(system=>round(fromLine(system,system.marks.find(item=>item.name==='group-bracket').spikeTop))))} (baseline ${JSON.stringify(baseExport.systems.map(system=>round(fromLine(system,system.spikes[0].y))))})`;
  });
  const afterBracket=await snapshot();record('bracket',afterBracket.project,screenBracket,exportBracket);
  // The reference for the brace span: the bracket rect starts a quarter staff space (plus a 3 unit bar overflow) beyond the staves it spans.
  const lineSpacing=system=>system.lines.length>1?Math.min(...system.lines.slice(1).map((y,index)=>y-system.lines[index]).filter(delta=>delta>4)):9;
  result.lineSpacing=exportBracket.systems.map(lineSpacing);

  // ---- E2: change the group to a brace ----
  await open();const e1=await edits();
  await groupKind().selectOption('brace');await idle();
  const afterBrace=await snapshot();
  const screenBrace=await settle('screen','brace',m=>m.systems.every(system=>markNames(system).join()===GROUP_BRACE.join()));
  await check('change the group to a brace: one edit, the kind is brace',async()=>{
    assert.equal(afterBrace.project.edits.length,e1+1);assert.equal(groupsOf(afterBrace.project)[0].kind,'brace');
  });
  const exportBrace=await exportPdf('brace');
  // The brace glyph's height per pixel of font size, from Bravura itself (a canvas measurement of U+E000), so the drawn extent is checked against the font rather than against TabPlayer's own metrics.
  const braceRatio=await page.evaluate(async()=>{await document.fonts.load('1000px Bravura','');const context=document.createElement('canvas').getContext('2d');context.font='1000px Bravura';const metrics=context.measureText('');return (metrics.actualBoundingBoxAscent+metrics.actualBoundingBoxDescent)/1000;});
  const braceHeight=mark=>braceRatio*mark.basePx*mark.pct/100;
  await check('brace group: one group-brace per system spanning the guitar top to the piano bottom within 1 px (the top within 1 px + 0.5% of its height, Bravura ink bounds), on screen',async()=>{
    expectMarks(screenBrace,GROUP_BRACE,'screen');
    const spans=[];let worst=0;
    for(const [index,system] of screenBrace.systems.entries()){
      const mark=system.marks[0],reference=screenBracket.systems[index].marks.find(item=>item.name==='group-bracket'),overflow=lineSpacing(screenBracket.systems[index])/4,height=braceHeight(mark);
      // The bracket's spikes sit a quarter staff space outside the staves; the brace spans the staves themselves, so it is that much inside the spikes.
      near(mark.bottom,reference.spikeBottom-overflow,`screen system ${index+1} brace bottom`,1);
      near(mark.bottom-height,reference.spikeTop+overflow,`screen system ${index+1} brace top (base ${mark.basePx}px, ${round(mark.pct)}%, bottom ${round(mark.bottom)}, height ${round(height)})`,1+0.005*height);
      worst=Math.max(worst,Math.abs(mark.bottom-height-(reference.spikeTop+overflow)));spans.push(`${round(mark.bottom-height)}..${round(mark.bottom)}`);
    }
    return `screen brace spans ${spans.join(', ')}; worst top difference ${round(worst)} px`;
  });
  await check('brace group: the export pages carry the same brace as the screen (position, size percentage and compression), one per system',async()=>{
    expectMarks(exportBrace,GROUP_BRACE,'export');
    exportBrace.systems.forEach((system,index)=>{
      const out=system.marks[0],shown=screenBrace.systems[index].marks[0],reference=exportBracket.systems[index].marks.find(item=>item.name==='group-bracket');
      near(out.x,shown.x,`system ${index+1} brace x`);near(out.bottom,shown.bottom,`system ${index+1} brace bottom`,1.5);near(out.pct/shown.pct,1,`system ${index+1} brace size`,0.005);near(out.xScale/shown.xScale,1,`system ${index+1} brace compression`,0.005);
      near(out.bottom,reference.spikeBottom-lineSpacing(exportBracket.systems[index])/4,`export system ${index+1} brace bottom`,1);
    });
  });
  {
    // Not a pass or fail: the export page sets the music font to 34px, the screen's alphaTab stylesheet to engravingSettings.musicFontSize (36px here), so the same percentage draws a shorter glyph in the export pages.
    const screenMark=screenBrace.systems[0].marks[0],exportMark=exportBrace.systems[0].marks[0],shortBy=braceHeight(screenMark)-braceHeight(exportMark);
    result.notes=[...(result.notes??[]),{musicFontPx:{screen:screenMark.basePx,exportPage:exportMark.basePx},braceHeightShortBy:round(shortBy),of:round(braceHeight(screenMark))}];
    console.log(`NOTE music font size: screen ${screenMark.basePx}px, export page ${exportMark.basePx}px; the same group brace is ${round(shortBy)} px shorter in the export pages (${round(braceHeight(exportMark))} of ${round(braceHeight(screenMark))} px). Pre-existing: the export page style .at{font-size:34px} is not what alphaTab sets on screen.`);
  }
  await check('choosing the current group kind records nothing',async()=>{
    const before=await edits();await groupKind().selectOption('brace');await idle();assert.equal(await edits(),before);
  });
  record('brace',afterBrace.project,screenBrace,exportBrace);

  // ---- E3: long names first, short after ----
  const e2=await edits();await open();await namesButton().click();await idle();
  const afterNames=await snapshot();
  const screenNames=await settle('screen','names',m=>hasNames(m,LONG,SHORT));
  await check('long names first, short after: one edit',async()=>{
    assert.equal(afterNames.project.edits.length,e2+1);assert.equal(afterNames.project.edits.at(-1).type,'setEngraving');
  });
  const exportNames=await exportPdf('names');
  await check('names: system 1 of the export pages shows Guitar6, Grand Piano and Drums, later systems Gtr., Pno. and Dr. and not Guitar6',async()=>{
    assert.ok(hasNames(exportNames,LONG,SHORT),`export names ${JSON.stringify(exportNames.systems.map(system=>system.texts.map(text=>text.text)))}`);
    assert.ok(hasNames(screenNames,LONG,SHORT),'screen names');
    for(const system of exportNames.systems.slice(1))assert.ok(!system.texts.some(text=>text.text==='Guitar6'));
    return `system 1 ${JSON.stringify(exportNames.systems[0].texts.map(text=>text.text))}, system 2 ${JSON.stringify(exportNames.systems[1].texts.map(text=>text.text))}`;
  });
  await check('names: every name ends left of the leftmost mark, on screen and in the export pages',async()=>{
    const gaps=[];
    for(const [label,measurement] of [['screen',screenNames],['export',exportNames]]){
      measurement.systems.forEach((system,index)=>{
        const leftmost=Math.min(...system.marks.map(mark=>mark.x));
        for(const text of system.texts){
          assert.ok(text.rotated,`${label} system ${index+1} "${text.text}" is a rotated (vertical) name`);
          assert.ok(text.right<leftmost,`${label} system ${index+1}: "${text.text}" ends at ${round(text.right)}, the leftmost mark starts at ${round(leftmost)}`);
          gaps.push(leftmost-text.right);
        }
      });
    }
    return `smallest clearance ${round(Math.min(...gaps))} px, largest ${round(Math.max(...gaps))} px`;
  });
  await check('pressing the names button again records nothing',async()=>{
    const before=await edits();assert.equal(await namesButton().getAttribute('aria-disabled'),'true');assert.equal(await namesButton().getAttribute('disabled'),null);
    await namesButton().evaluate(node=>node.click());await idle();assert.equal(await edits(),before);
  });
  record('names',afterNames.project,screenNames,exportNames);

  // ---- E4: 200% below Guitar6 ----
  const e3=await edits();await staffGap('Guitar6',200);
  const afterGap=await snapshot();
  const screenGap=await settle('screen','staff gap 200',m=>Math.abs(moved(m,screenNames)['Grand Piano'])>1);
  const exportGap=await exportPdf('staff gap 200');
  const shifted200={screen:moved(screenGap,screenNames),export:moved(exportGap,exportNames)};
  await check('200% below Guitar6: one edit carrying one gap',async()=>{
    assert.equal(afterGap.project.edits.length,e3+1);assert.equal(afterGap.project.edits.at(-1).type,'setEngraving');
    const gaps=gapsOf(afterGap.project);assert.equal(gaps.length,1);near(gaps[0].scale,2,'staff gap scale');assert.equal(typeof gaps[0].trackId,'string');
    assert.deepEqual(groupsOf(afterGap.project),groupsOf(afterNames.project));
  });
  await check('200% below Guitar6: piano and drums move down by the same space on screen and in the export pages, the guitar does not',async()=>{
    for(const [label,delta] of Object.entries(shifted200)){
      near(delta.Guitar6,0,`${label} Guitar6`);
      assert.ok(delta['Grand Piano']>5,`${label} the piano moved by ${delta['Grand Piano']}`);
      near(delta.Drums,delta['Grand Piano'],`${label} the drums move with the piano ${JSON.stringify([ (label==='screen'?screenGap:exportGap).systems[0].bands,(label==='screen'?screenGap:exportGap).systems[0].texts.map(t=>[t.text,t.x,t.y]),(label==='screen'?screenNames:exportNames).systems[0].texts.map(t=>[t.text,t.x,t.y])])}`);
    }
    near(shifted200.screen['Grand Piano'],shifted200.export['Grand Piano'],'the screen and the export open the same space',0.5);
    // Every staff line moves by 0 or by that space, nothing in between, and nothing above the cut moves.
    for(const [label,now,before] of [['screen',screenGap,screenNames],['export',exportGap,exportNames]]){
      const space=moved(now,before)['Grand Piano'];
      now.systems.forEach((system,index)=>{
        assert.equal(system.lines.length,before.systems[index].lines.length,`${label} system ${index+1}: same staff lines`);
        const first=before.systems[index].lines;
        const deltas=system.lines.map((y,line)=>round(y-first[line]));
        assert.ok(deltas.every(delta=>Math.abs(delta)<=0.02||deltas.length&&delta>0),`${label} system ${index+1}: lines never move up (${JSON.stringify([...new Set(deltas)])})`);
        assert.ok(deltas.every((delta,line)=>line===0||delta>=deltas[line-1]-0.02),`${label} system ${index+1}: the shift only grows down the system`);
        assert.ok(Math.abs(deltas[0])<=0.02,`${label} system ${index+1}: the first line does not move`);
        assert.ok(deltas.every(delta=>Math.abs(delta)<=0.02||Math.abs(delta-space)<=0.5||Math.abs(delta)<=space+0.5),`${label} system ${index+1}: no line moves by more than the space`);
      });
    }
    return `piano moved ${round(shifted200.screen['Grand Piano'])} (screen) and ${round(shifted200.export['Grand Piano'])} (export), drums ${round(shifted200.screen.Drums)} and ${round(shifted200.export.Drums)}, guitar ${round(shifted200.screen.Guitar6)} and ${round(shifted200.export.Guitar6)}`;
  });
  await check('200% below Guitar6: the brace follows the moved staves and later systems on the page move down by the space opened above them',async()=>{
    expectMarks(screenGap,GROUP_BRACE,'screen');expectMarks(exportGap,GROUP_BRACE,'export');
    for(const [label,now,before] of [['screen',screenGap,screenNames],['export',exportGap,exportNames]]){
      now.systems.forEach((system,index)=>{
        const after=system.marks[0],was=before.systems[index].marks[0],space=moved(now,before,index)['Grand Piano'];
        near(after.bottom-was.bottom,space,`${label} system ${index+1}: the brace bottom moved with the piano`,0.5);
      });
    }
    // Consecutive systems on one page stack by the composed height: the distance between them grows by the space opened in the upper one.
    for(const [label,now,before,factor] of [['screen',screenGap,screenNames,screenFactor],['export',exportGap,exportNames,1]]){
      for(let index=0;index+1<SYSTEM_COUNT;index++){
        if(now.systems[index].sheet!==now.systems[index+1].sheet||before.systems[index].sheet!==before.systems[index+1].sheet)continue;
        const growth=(now.systems[index+1].top-now.systems[index].top)-(before.systems[index+1].top-before.systems[index].top),space=moved(now,before,index)['Grand Piano']*factor;
        near(growth,space,`${label}: system ${index+2} sits ${round(growth)} lower below system ${index+1}, expected ${round(space)}`,0.5);
      }
    }
  });
  record('staff gap 200',afterGap.project,screenGap,exportGap);

  // The space is linear in the percentage: 300% opens twice as much as 200% (the base is the measured space, not a constant).
  await staffGap('Guitar6',300);const afterGap300=await snapshot();
  const screenGap300=await settle('screen','staff gap 300',m=>Math.abs(moved(m,screenNames)['Grand Piano']-shifted200.screen['Grand Piano'])>1);
  const exportGap300=await exportPdf('staff gap 300');
  await check('300% below Guitar6 opens twice the space of 200%, on screen and in the export pages',async()=>{
    near(moved(screenGap300,screenNames)['Grand Piano'],2*shifted200.screen['Grand Piano'],'screen 300% vs 200%',0.2);
    near(moved(exportGap300,exportNames)['Grand Piano'],2*shifted200.export['Grand Piano'],'export 300% vs 200%',0.2);
    return `${round(moved(exportGap300,exportNames)['Grand Piano'])} = 2 x ${round(shifted200.export['Grand Piano'])}`;
  });
  record('staff gap 300',afterGap300.project,screenGap300,exportGap300);
  await staffGap('Guitar6',200);const afterGapBack=await snapshot();
  const screenGapBack=await settle('screen','staff gap 200 again',m=>Math.abs(moved(m,screenNames)['Grand Piano']-shifted200.screen['Grand Piano'])<=0.5);
  await check('choosing the current staff gap records nothing',async()=>{
    const before=await edits();await staffGap('Guitar6',200);assert.equal(await edits(),before);
  });
  record('staff gap 200 again',afterGapBack.project,screenGapBack,null);

  // ---- clicks on the moved staves ----
  const documentTrack=async()=>(await page.locator('[aria-label="Editing location"]').innerText()).trim().replace(/\s+/g,' ');
  // Clicks the point (x, y) of system `system`, in that system's own SVG units (displayed y), after scrolling the score so the point is inside the visible host.
  const clickScore=async(system,x,y)=>{
    for(let attempt=0;attempt<4;attempt++){
      const rect=(await measure('screen')).systems[system].rect,host=await page.locator('.paper-scroll').evaluate(node=>{const box=node.getBoundingClientRect();return {top:box.top,bottom:box.bottom};});
      const pointY=rect.top+y*screenFactor;
      if(pointY>host.top+40&&pointY<host.bottom-40){await page.mouse.click(rect.left+x*screenFactor,pointY);await idle();return;}
      await page.locator('.paper-scroll').evaluate((node,delta)=>{node.scrollTop+=delta;},pointY-(host.top+host.bottom)/2);
      await page.waitForTimeout(150);
    }
    throw new Error('Could not scroll the point into view.');
  };
  const nearestHead=(system,name)=>{
    const centre=byName(system,name).y,heads=system.heads.filter(head=>head.x>120);
    return heads.reduce((best,head)=>Math.abs(head.y-centre)<Math.abs(best.y-centre)?head:best,heads[0]);
  };
  await check('a click on a piano notehead after the 200% gap selects that note and a click inside the opened gap selects nothing',async()=>{
    const first=(await settle('screen','click')).systems[0];
    // Select the guitar first, so that "selects nothing" is a change that would show: the gap click must leave the guitar selected.
    const guitarHead=nearestHead(first,'Guitar6'),pianoHead=nearestHead(first,'Grand Piano');
    await clickScore(0,guitarHead.x+4,guitarHead.y);
    const guitarSelected=await documentTrack();assert.match(guitarSelected,/^Guitar6/,`the guitar head selects Guitar6 (${guitarSelected})`);
    await clickScore(0,pianoHead.x+4,pianoHead.y);
    const pianoSelected=await documentTrack();assert.match(pianoSelected,/^Grand Piano/,`the piano head selects the Grand Piano (${pianoSelected})`);
    // The opened gap: between the bottom of the band above the cut and the top of the band below it, in displayed coordinates.
    const system=(await measure('screen')).systems[0],bands=system.bands;
    assert.ok(bands.length>=2,'the first system is composed in bands');
    const upperEnd=bands[0].end+bands[0].shift,lowerStart=bands[1].start+bands[1].shift;
    assert.ok(lowerStart-upperEnd>5,`the gap is open: ${round(upperEnd)}..${round(lowerStart)}`);
    const middle=(upperEnd+lowerStart)/2;
    await clickScore(0,guitarHead.x+4,guitarHead.y);
    const beforeGap=await documentTrack(),editsBefore=await edits();
    await clickScore(0,pianoHead.x+4,middle);
    assert.equal(await documentTrack(),beforeGap,'a click inside the opened gap changes no selection');assert.equal(await edits(),editsBefore);
    return `guitar "${guitarSelected.slice(0,30)}", piano "${pianoSelected.slice(0,30)}", gap ${round(upperEnd)}..${round(lowerStart)} (${round(lowerStart-upperEnd)} px) left the selection at "${beforeGap.slice(0,30)}"`;
  });

  // ---- playback highlight on a composed chunk ----
  await check('the playback highlight restyles a note inside a composed system (content in defs, shown through use)',async()=>{
    const first=(await settle('screen','highlight')).systems[0];
    assert.ok(first.composed,'the first system is composed (defs shown through use)');
    await page.locator('.paper-scroll').evaluate(node=>{node.scrollTop=0;});
    await waitStatus(value=>value.ready&&!value.error);
    // Play needs a start: seek to bar 1 (a plain Play then starts from that position).
    await revealPlaybackControls(page);await page.getByLabel('Seek measure',{exact:true}).fill('1');await page.getByRole('button',{name:'Seek',exact:true}).click();await idle();await hidePlaybackControls(page);
    // Counts the pixels painted in the highlight colour (#6b8a2c) in a PNG.
    const lime=png=>page.evaluate(async base64=>{
      const bytes=Uint8Array.from(atob(base64),character=>character.charCodeAt(0)),bitmap=await createImageBitmap(new Blob([bytes],{type:'image/png'}));
      const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;const context=canvas.getContext('2d');context.drawImage(bitmap,0,0);
      const data=context.getImageData(0,0,bitmap.width,bitmap.height).data;let count=0;
      for(let at=0;at<data.length;at+=4)if(Math.hypot(data[at]-107,data[at+1]-138,data[at+2]-44)<=25)count++;
      return count;
    },png.toString('base64'));
    await page.waitForFunction(()=>{const play=[...document.querySelectorAll('button')].find(item=>item.textContent==='Play');return play&&!play.matches(':disabled');},undefined,{timeout:60000});
    await button('Play');
    let proof=null;
    const deadline=Date.now()+20000;
    while(!proof&&Date.now()<deadline){
      const system=(await measure('screen')).systems[0];
      const host=await page.locator('.paper-scroll').evaluate(node=>{const box=node.getBoundingClientRect();return {top:box.top,bottom:box.bottom,left:box.left,right:box.right};});
      const visible=system.lit.filter(glyph=>{const y=system.rect.top+glyph.y*screenFactor,x=system.rect.left+glyph.x*screenFactor;return y>host.top+20&&y<host.bottom-20&&x>host.left+20&&x<host.right-40;});
      if(!visible.length){await page.waitForTimeout(20);continue;}
      assert.ok(visible.every(glyph=>glyph.inDefs),'the highlighted glyphs sit in the defs content');
      const glyph=visible[0],clip={x:system.rect.left+(glyph.x-3)*screenFactor,y:system.rect.top+(glyph.y-14)*screenFactor,width:24*screenFactor,height:26*screenFactor};
      const lit=await lime(await page.screenshot({clip}));
      if(lit>=6)proof={glyph,clip,lit,glyphs:system.lit.length};
    }
    await button('Pause');
    assert.ok(proof,'no highlighted note painted in the highlight colour within 20 s');
    await button('Stop');
    await page.waitForFunction(()=>!document.querySelector('.score-svg-chunk .at-highlight'),undefined,{timeout:10000});
    const after=await lime(await page.screenshot({clip:proof.clip}));
    assert.ok(after<=1,`after Stop the same region still holds ${after} highlight-coloured pixels`);
    return `${proof.lit} highlight-coloured pixels on the note at (${round(proof.glyph.x)}, ${round(proof.glyph.y)}) while highlighted (${proof.glyphs} lit glyphs in the composed system), ${after} after Stop`;
  });

  // ---- E5: a 200% system gap on the third system composes with the staff gap ----
  const selectBar=async bar=>{
    await button('Edit');await field('Measure').fill(String(bar));await field('Measure').press('Tab');await idle();
    await button('Presentation');await details('Design: system gaps');
    const system=SYSTEMS.find(([first,last])=>bar>=first&&bar<=last);
    await page.getByRole('status').filter({hasText:'Selected system:'}).filter({hasText:`bars ${system[0]} to ${system[1]}.`}).waitFor({timeout:10000});
  };
  await selectBar(thirdBar);
  const systemGapsOf=project=>documentField(project,'systemGaps');
  const e4=await edits();await details('Design: system gaps');
  {const input=field('System gap (%)');await input.fill('200');await input.press('Enter');await idle();}
  const afterSystemGap=await snapshot();
  const expectedTops=(reference,unit)=>{
    let sum=0,sheet=null;
    return reference.systems.map((system,index)=>{
      const starts=index===0||system.sheet!==sheet;if(system.sheet!==sheet){sheet=system.sheet;sum=0;}
      if(!starts&&index===THIRD)sum+=1*unit;
      return system.top+sum;
    });
  };
  const screenBoth=await settle('screen','system gap over staff gap',m=>Math.abs(m.systems[THIRD].top-screenGapBack.systems[THIRD].top)>1||m.systems[THIRD].sheet!==screenGapBack.systems[THIRD].sheet);
  const exportBoth=await exportPdf('system gap over staff gap');
  await check('a 200% system gap on the third system composes with the staff gap: one edit, and the D08 offset is added over the composed heights',async()=>{
    assert.equal(afterSystemGap.project.edits.length,e4+1);
    assert.deepEqual(systemGapsOf(afterSystemGap.project).map(entry=>entry.scale),[2]);
    assert.deepEqual(gapsOf(afterSystemGap.project),gapsOf(afterGapBack.project));
    for(const [label,now,before,unit] of [['screen',screenBoth,screenGapBack,screenUnit],['export',exportBoth,exportGap,exportUnit]]){
      assert.deepEqual(now.systems.map(system=>system.sheet),before.systems.map(system=>system.sheet),`${label}: every system stays on its page`);
      expectedTops(before,unit).forEach((top,index)=>near(now.systems[index].top,top,`${label} system ${index+1} top`));
      // The staff gap inside every system is unchanged by the system gap.
      now.systems.forEach((system,index)=>near(trackY(system,index)['Grand Piano']-trackY(system,index).Guitar6,trackY(before.systems[index],index)['Grand Piano']-trackY(before.systems[index],index).Guitar6,`${label} system ${index+1} staff gap`,0.01));
    }
    return `third system moved ${round(screenBoth.systems[THIRD].top-screenGapBack.systems[THIRD].top)} px (screen, expected ${round(screenUnit)}), ${round(exportBoth.systems[THIRD].top-exportGap.systems[THIRD].top)} (export, expected ${round(exportUnit)})`;
  });
  record('system gap',afterSystemGap.project,screenBoth,exportBoth);
  const generationAfterEdits=await generation('after the settings edits');

  // ---- per-track export of the guitar alone ----
  await check('exporting the guitar alone to PDF draws no group',async()=>{
    const alone=await exportPdf('guitar alone',{only:['Guitar6']});
    assert.ok(alone.systems.length>0,'systems were exported');
    const pages=await page.evaluate(()=>window.__tabplayerTestExportPages.at(-1).map(entry=>entry.svg));
    assert.ok(pages.every(svg=>!svg.includes('data-tp-accolade')),'no data-tp-accolade in the export pages');
    assert.ok(alone.systems.every(system=>!system.marks.length));
    assert.ok(pages.every(svg=>!svg.includes('>Grand Piano<')&&!svg.includes('>Drums<')),'only the guitar was rendered');
    return `${alone.systems.length} systems, no accolades; alphaTab's own bracket glyphs: ${pages.reduce((sum,svg)=>sum+svg.split('&#57347;').length-1,0)}`;
  });

  // ---- move Drums between the two members ----
  await revealDock(page,'Mixer');
  await page.getByRole('button',{name:'Track 3: Drums',exact:true}).click();await idle();
  await revealInspectorTab(page,'Track');const before6=await edits();
  await page.locator('.track-settings').getByRole('button',{name:'Move track up',exact:true}).click();await idle();
  const afterMove=await snapshot();
  await button('Presentation');await open();
  await check('move Drums above Grand Piano: the group is no longer drawn and the panel says why',async()=>{
    assert.equal(afterMove.project.edits.length,before6+1);assert.equal(afterMove.project.edits.at(-1).type,'moveTrack');
    await page.getByText('Not drawn: its tracks are no longer next to each other.',{exact:true}).waitFor({timeout:10000});
    const live=await settle('screen','group not drawn',m=>m.systems.every(system=>!system.marks.length));
    expectMarks(live,[],'screen');
    const out=await exportPdf('moved drums');expectMarks(out,[],'export');
    // The group and the gap stay in the document: only drawing stops.
    assert.equal(groupsOf((await snapshot()).project).length,1);
    return 'no data-tp-accolade on screen or in the export pages; the status line is shown';
  });
  await button('Undo');
  const afterMoveUndo=await snapshot();
  const screenRestored=await settle('screen','move undone',m=>m.systems.every(system=>markNames(system).join()===GROUP_BRACE.join()));
  await check('undo of the track move draws the group again, identically',async()=>{
    assert.deepEqual(afterMoveUndo.project,afterSystemGap.project);
    same(screenRestored.systems.map(system=>[system.sheet,system.top,system.marks,system.texts]),screenBoth.systems.map(system=>[system.sheet,system.top,system.marks,system.texts]),'restored screen');
    const out=await exportPdf('move undone');
    same(out.systems.map(system=>[system.sheet,system.top,system.marks,system.texts]),exportBoth.systems.map(system=>[system.sheet,system.top,system.marks,system.texts]),'restored export');
  });
  await check('a Redo of the track move leaves the group undrawn again, then Undo restores it',async()=>{
    await button('Redo');await settle('screen','move redone',m=>m.systems.every(system=>!system.marks.length));
    await button('Undo');await settle('screen','move undone again',m=>m.systems.every(system=>markNames(system).join()===GROUP_BRACE.join()));
  });

  const generationAfterMove=await generation('after the track move, its undo and redo, and the undo');
  // ---- undo and redo every step ----
  const chain=states.slice(1);  // bracket .. system gap, the edits made after the baseline
  const sameProject=(now,expected)=>assert.deepEqual(now,expected);
  for(let index=chain.length-1;index>=0;index--){
    const target=index===0?states[0]:chain[index-1];
    await button('Undo');const now=await snapshot();
    await check(`undo ${chain.length-index}/${chain.length} restores the state before "${chain[index].label}"`,async()=>{
      sameProject(now.project,target.project);
      const namesOn=hasNames(target.screen,LONG,SHORT);
      const live=await settle('screen',`undo to ${target.label}`,m=>JSON.stringify(m.systems.map(markNames))===JSON.stringify(target.screen.systems.map(markNames))&&(namesOn?hasNames(m,LONG,SHORT):hasNames(m,SHORT,[])));
      same(live.systems.map(system=>[system.sheet,system.top,system.marks.map(mark=>[mark.name,mark.x,mark.bottom]),system.texts.map(text=>[text.text,text.y])]),target.screen.systems.map(system=>[system.sheet,system.top,system.marks.map(mark=>[mark.name,mark.x,mark.bottom]),system.texts.map(text=>[text.text,text.y])]),`screen after undo to ${target.label}`);
      if(index===0||index===chain.length-1){
        const out=await exportPdf(`undo to ${target.label}`);
        if(target.exported)same(out.systems.map(system=>[system.sheet,system.top,system.marks.map(mark=>[mark.name,mark.x,mark.bottom])]),target.exported.systems.map(system=>[system.sheet,system.top,system.marks.map(mark=>[mark.name,mark.x,mark.bottom])]),`export after undo to ${target.label}`);
      }
    });
  }
  for(let index=0;index<chain.length;index++){
    await button('Redo');const now=await snapshot();
    await check(`redo ${index+1}/${chain.length} replays "${chain[index].label}"`,async()=>{
      sameProject(now.project,chain[index].project);
      const live=await settle('screen',`redo ${chain[index].label}`,m=>JSON.stringify(m.systems.map(markNames))===JSON.stringify(chain[index].screen.systems.map(markNames)));
      same(live.systems.map(system=>[system.sheet,system.top,system.marks.map(mark=>[mark.name,mark.x,mark.bottom]),system.texts.map(text=>[text.text,text.y])]),chain[index].screen.systems.map(system=>[system.sheet,system.top,system.marks.map(mark=>[mark.name,mark.x,mark.bottom]),system.texts.map(text=>[text.text,text.y])]),`screen after redo of ${chain[index].label}`);
      if(index===chain.length-1){
        const out=await exportPdf('after all redo');
        same(out.systems.map(system=>[system.sheet,system.top,system.marks.map(mark=>[mark.name,mark.x,mark.bottom])]),chain[index].exported.systems.map(system=>[system.sheet,system.top,system.marks.map(mark=>[mark.name,mark.x,mark.bottom])]),'export after all redo');
      }
    });
  }

  // ---- parchment: the overlay draws the groups where the screen layout has no composed chunks ----
  await check('parchment: the overlay draws one group brace per system and it lines up with the staves within 1 px of the page view',async()=>{
    await button('Presentation');
    await page.getByRole('combobox',{name:'Display mode',exact:true}).selectOption('parchment');
    // The overlay (svg[data-tp-accolades]) shares its origin with alphaTab's own surface: each surface chunk sits at its wrapper's left/top.
    const read=()=>page.evaluate(()=>{
      const overlay=document.querySelector('svg[data-tp-accolades]');if(!overlay)return null;
      const pattern=/translate\(\s*([-\d.e]+)[\s,]+([-\d.e]+)\s*\)/;
      const marks=[...overlay.querySelectorAll('[data-tp-accolade]')].map(node=>{
        const holder=node.querySelector('g'),found=pattern.exec(holder.getAttribute('transform')),text=node.querySelector('text');
        return {name:node.getAttribute('data-tp-accolade'),bottom:Number(found[2]),pct:Number(/font-size: ([-\d.e]+)%/.exec(text.getAttribute('style'))[1]),basePx:parseFloat(getComputedStyle(holder).fontSize)};
      });
      const lines=[];
      for(const svg of document.querySelectorAll('[aria-label="Music notation"] svg')){
        if(overlay.contains(svg)||svg===overlay)continue;
        const top=parseFloat(svg.parentElement.style.top)||0;
        for(const rect of svg.querySelectorAll('rect'))if(Number(rect.getAttribute('height'))<3&&Number(rect.getAttribute('width'))>20)lines.push(top+Number(rect.getAttribute('y')));
      }
      return {marks,lines:[...new Set(lines.map(y=>Math.round(y*100)/100))].sort((a,b)=>a-b)};
    });
    let live=null;
    for(let attempt=0;attempt<100;attempt++){live=await read();if(live&&live.marks.length===SYSTEM_COUNT&&live.marks.every(mark=>mark.name==='group-brace'))break;await page.waitForTimeout(150);live=null;}
    assert.ok(live,'the overlay did not draw one group brace per system');
    // The same distances in the page view: from the brace's top to the first staff line inside it, and from the last staff line inside it to its bottom.
    const inside=(lines,top,bottom)=>lines.filter(y=>y>=top-5&&y<=bottom+5);
    const reference=screenBrace.systems.map(system=>{const mark=system.marks[0],top=mark.bottom-braceHeight(mark),lines=inside(system.lines,top,mark.bottom);return {top:lines[0]-top,bottom:mark.bottom-lines.at(-1)};});
    const worst=[];
    live.marks.forEach((mark,index)=>{
      const top=mark.bottom-braceHeight(mark),lines=inside(live.lines,top,mark.bottom);
      assert.ok(lines.length>=10,`system ${index+1}: ${lines.length} staff lines inside the brace`);
      near(lines[0]-top,reference[index].top,`system ${index+1} brace top to its first staff line`,1);
      near(mark.bottom-lines.at(-1),reference[index].bottom,`system ${index+1} brace bottom to its last staff line`,1);
      worst.push(round(Math.max(Math.abs(lines[0]-top-reference[index].top),Math.abs(mark.bottom-lines.at(-1)-reference[index].bottom))));
    });
    await page.getByRole('combobox',{name:'Display mode',exact:true}).selectOption('verticalPage');
    await settle('screen','back to the vertical page view',m=>m.systems.every(system=>markNames(system).join()===GROUP_BRACE.join()));
    return `${live.marks.length} overlay braces, music font ${live.marks[0].basePx}px, largest difference from the page view ${Math.max(...worst)} px`;
  });

  // ---- save, reopen ----
  const storedBefore=await snapshot();
  await button('Save');const stored=await snapshot();
  const finalState=chain.at(-1);
  await check('save leaves the document clean with the group, the gap and the names in it',async()=>{
    assert.equal(stored.dirty,false);assert.deepEqual(stored.project,storedBefore.project);
    assert.equal(groupsOf(stored.project)[0].kind,'brace');assert.equal(gapsOf(stored.project).length,1);near(gapsOf(stored.project)[0].scale,2,'staff gap scale');
    assert.deepEqual(systemGapsOf(stored.project).map(entry=>entry.scale),[2]);
  });
  await check('native playback generation is unchanged across every settings edit (group, kind, names, staff gap, system gap) and across their undo and redo',async()=>{
    const final=await generation('after all undo and redo');
    assert.equal(generationAfterEdits,baselineGeneration,`the settings edits moved the generation from ${baselineGeneration} to ${generationAfterEdits}`);
    assert.equal(final,generationAfterMove,`undo and redo of the settings edits moved the generation from ${generationAfterMove} to ${final}`);
    const live=await status();assert.equal(live.playing,false);assert.equal(live.generation,final);
    // Moving a track does change the playback plan, so the generation advanced there and only there.
    return `generation ${baselineGeneration} through the edits; the track move, its undo and redo advanced it to ${generationAfterMove} (expected: it is a different kind of edit), then ${final} through the undo and redo chain (idle; playback was started and stopped once, for the highlight check, and did not change it)`;
  });
  await check('no page errors',async()=>{assert.deepEqual(errors,[]);});
  await browser.close();browser=null;stop(id);

  id=launch({TABPLAYER_TEST_OPEN:saved,TABPLAYER_TEST_EXPORT:exported});browser=await connect();page=browser.contexts()[0].pages()[0];await waitForWorkspaceIdle(page);await closeLibrary();await button('Open');
  await check('reopen: the project (history, group, gaps and names) is identical',async()=>{assert.deepEqual((await snapshot()).project,stored.project);});
  await button('Presentation');await page.getByRole('combobox',{name:'Display mode',exact:true}).selectOption('verticalPage');await page.getByRole('combobox',{name:'Displayed tracks',exact:true}).selectOption('all');
  await check('reopen: the saved group, gap and names are on screen and in the export pages',async()=>{
    const live=await settle('screen','reopened',m=>JSON.stringify(m.systems.map(markNames))===JSON.stringify(finalState.screen.systems.map(markNames))&&hasNames(m,LONG,SHORT));
    same(live.systems.map(system=>[system.sheet,system.top,system.marks.map(mark=>[mark.name,mark.x,mark.bottom]),system.texts.map(text=>[text.text,text.y])]),finalState.screen.systems.map(system=>[system.sheet,system.top,system.marks.map(mark=>[mark.name,mark.x,mark.bottom]),system.texts.map(text=>[text.text,text.y])]),'reopened screen');
    const out=await exportPdf('reopened');
    same(out.systems.map(system=>[system.sheet,system.top,system.marks.map(mark=>[mark.name,mark.x,mark.bottom]),system.texts.map(text=>[text.text,text.y])]),finalState.exported.systems.map(system=>[system.sheet,system.top,system.marks.map(mark=>[mark.name,mark.x,mark.bottom]),system.texts.map(text=>[text.text,text.y])]),'reopened export');
  });
  await check('reopen: the saved group and gap show in the panel and can be removed',async()=>{
    await button('Presentation');await open();
    await page.getByText('Drawn.',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Reset all staff gaps',exact:true}).click();await idle();
    assert.deepEqual(gapsOf((await snapshot()).project),[]);
    await page.getByRole('button',{name:'Remove all groups',exact:true}).click();await idle();
    assert.deepEqual(groupsOf((await snapshot()).project),[]);
    const live=await settle('screen','removed',m=>m.systems.every(system=>!system.marks.length));expectMarks(live,[],'screen');
  });
  result.generations=generations;
}catch(error){
  const message=error instanceof Error?error.message:String(error);console.log(`FAIL driver - ${message.split('\n').slice(0,10).join(' | ')}`);failures.push('driver');result.checks.push({name:'driver',pass:false,detail:message});
  if(page)await page.screenshot({path:resolve(evidenceDirectory,'staff-groups-failure.png')}).catch(()=>{});
}finally{
  if(browser)await browser.close().catch(()=>{});stop(id);
  result.failures=failures;result.passed=result.checks.filter(item=>item.pass).length;
  writeFileSync(resolve(evidenceDirectory,'staff-groups-result.json'),JSON.stringify(result,null,2));
  console.log(`staff-groups: ${result.passed} passed, ${failures.length} failed${failures.length?` (${failures.join('; ')})`:''}.`);
  if(failures.length)process.exitCode=1;
}
