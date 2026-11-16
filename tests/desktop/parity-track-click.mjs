// THE-213: a single real click on a track's name (dock rows and Mixer view) makes it the active track: nothing is recorded, the
// document does not become dirty, the name says it is pressed, and a digit typed next is written on that track.
// THE-213 (other tracks): a real click on a fret number of any track's staff puts the cursor on that note and makes that track active, in the
// continuous layouts and the page layouts alike; it records nothing and does not dirty the document.
// usage: node tests/desktop/parity-track-click.mjs [small|large]
import assert from 'node:assert/strict';
import { openScore,settle,sleep,click,centre,fretPoint,press } from './entry-mix-support.mjs';
import { waitForWorkspaceIdle } from './workstation-commands.mjs';

const size=process.argv[2]??'small',session=await openScore(size),{page,cdp}=session,report={size,clicks:[]};
const trackOfLast=async()=>{const edit=(await session.edits()).at(-1),note=edit?.type==='sequence'?edit.commands.find(step=>step.type==='setNote'):edit;return note?.target?.track;};
try{
  const point=await fretPoint(page,2);await click(cdp,point.x,point.y);await sleep(400);
  const check=async(where,selector,count,{enter=null,toScore=null,digit='5'}={})=>{
    for(let index=count-1;index>=0;index--){
      if(enter)await enter();
      await settle(page,500);
      const before=await session.snapshot(),editsBefore=before.project.edits.length;
      const rect=await centre(page,selector(index));
      report.last={where,index,rect,under:await page.evaluate(({x,y})=>{const n=document.elementFromPoint(x,y);return n?`${n.tagName}.${n.className}`:null;},rect)};
      await click(cdp,rect.x,rect.y);await sleep(500);
      const pressed=await page.evaluate(selector=>document.querySelector(selector)?.getAttribute('aria-pressed'),selector(index));
      const after=await session.snapshot();
      assert.equal(pressed,'true',`${where} ${index}: the name shows it is the active track`);
      assert.equal(after.project.edits.length,editsBefore,`${where} ${index}: choosing a track records nothing`);
      assert.equal(after.dirty,before.dirty,`${where} ${index}: choosing a track does not make the document dirty`);
      // The Mixer view shows no score to type on: go back to the Score view (focusing its workspace with a call, since there is no tab stop to click), where the chosen track is the one entry goes to.
      if(toScore)await toScore();
      await press(cdp,digit);await settle(page,800);
      const track=await trackOfLast();
      assert.equal(track,index,`${where} ${index}: a digit typed next lands on the chosen track (got ${track})`);
      report.clicks.push({where,index,pressed,dirty:after.dirty});
    }
  };
  const tracks=(await session.snapshot()).project?.edits?await page.evaluate(()=>document.querySelectorAll('.score-overview-track-name').length):0;
  await check('dock',index=>`[role=row][aria-rowindex="${index+2}"] button.score-overview-track-name`,tracks);
  const toScore=async()=>{
    await page.getByRole('radio',{name:'Score'}).click().catch(()=>page.getByRole('button',{name:'Score',exact:true}).first().click());await sleep(600);
    await page.evaluate(()=>document.querySelector('.score-workspace')?.focus());await sleep(200);
  };
  const toMixer=()=>page.getByRole('radio',{name:'Mixer'}).click().catch(()=>page.getByRole('button',{name:'Mixer',exact:true}).first().click());
  await check('mixer',index=>`.mixer-strip:nth-child(${index+1}) .mixer-strip-select`,tracks,{enter:async()=>{await toMixer();await sleep(600);},toScore,digit:'7'});

  // ---- Clicks on the fret numbers of every track's staff, in each screen layout. ----
  const modes=['verticalPage','horizontalPage','grid','parchment','verticalScreen','horizontalScreen'],layouts=[['parchment',100],['verticalScreen',100],['horizontalScreen',100],['parchment',70],['verticalPage',60],['horizontalPage',60]];
  const modeSelect=()=>page.getByRole('combobox',{name:'Display mode',exact:true});
  const setMode=async layout=>{
    const select=modeSelect();let current=await select.inputValue();if(current===layout)return;
    await select.focus();
    for(let attempt=0;attempt<12&&(await select.inputValue())!==layout;attempt++)await page.keyboard.press(modes.indexOf(layout)>modes.indexOf(await select.inputValue())?'ArrowDown':'ArrowUp');
    assert.equal(await select.inputValue(),layout,'keyboard could not reach the mode');
    await waitForWorkspaceIdle(page);await settle(page,1200);
  };
  const setZoom=async value=>{
    const input=page.getByLabel('Zoom (%)',{exact:true});if(Number(await input.inputValue())===value)return;
    await input.click({clickCount:3});await page.keyboard.type(String(value));await page.keyboard.press('Tab');await waitForWorkspaceIdle(page);await settle(page,1200);
  };
  // The fret numbers of the first system, by beat: one column per beat of the first bar (left to right), each holding that beat's number on every track, top track first.
  // Every beat has one note on every track, so the numbers at one x are the tracks' notes, in track order; the system is the topmost row of numbers.
  const staffDigits=()=>page.evaluate(tracks=>{
    const host=document.querySelector('.paper-scroll').getBoundingClientRect();
    const all=[...document.querySelector('.score-paper-host').querySelectorAll('svg text')].filter(text=>/^\d{1,2}$/.test(text.textContent)&&text.getBoundingClientRect().width>0&&!text.closest('.score-source-staging,[aria-hidden="true"],[inert],[transform*="rotate"]')&&!text.getAttribute('transform')?.includes('rotate')).map(text=>{const r=text.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,top:r.y,height:r.height,text:text.textContent};});
    // Bar numbers are drawn smaller than fret numbers (and in red): only the full-size numbers are fret numbers.
    const size=Math.max(...all.map(number=>number.height)),frets=all.filter(number=>number.height>=size*0.9);
    all.length=0;all.push(...frets.filter(n=>n.x>host.left+4&&n.x<host.right-4&&n.y>host.top+4&&n.y<host.bottom-4).sort((a,b)=>a.x-b.x));
    const columns=[];for(const number of all){const last=columns.at(-1);if(last&&number.x-last.x<6)last.numbers.push(number);else columns.push({x:number.x,numbers:[number]});}
    const top=Math.min(...all.map(number=>number.top));
    return columns.map(column=>column.numbers.sort((a,b)=>a.top-b.top)).filter(numbers=>numbers.length>=tracks&&numbers[0].top-top<100).map(numbers=>numbers.slice(0,tracks));
  },tracks);
  const where=async()=>({text:await page.evaluate(()=>document.querySelector('.score-edit-announcement')?.textContent??''),pressed:await page.evaluate(()=>[...document.querySelectorAll('[role=row] button.score-overview-track-name')].map(b=>b.getAttribute('aria-pressed')==='true').indexOf(true))});
  // The score shows only the active track until the others' eyes are opened: open them with real clicks, so that every track has a staff on the page.
  for(let hidden=await page.locator('button[data-kind="shown"][aria-pressed="false"]').count();hidden>0;hidden=await page.locator('button[data-kind="shown"][aria-pressed="false"]').count()){
    await page.locator('button[data-kind="shown"][aria-pressed="false"]').first().click();await settle(page,800);
  }
  report.layouts={};
  for(const [layout,zoom] of layouts){
    await setMode(layout);await setZoom(zoom);
    const found=await staffDigits(),log=report.layouts[`${layout} ${zoom}%`]={columns:found.length,clicks:[]};
    assert.ok(found.length>=7,`${layout} ${zoom}%: the first system shows a column of fret numbers per beat (${found.length})`);
    // The beat under the cursor draws its number in the selection colour, which this search leaves out: the first column may be the second beat. The third beat took the typed digits above, so it is skipped.
    const first=[0,1].find(skip=>found.slice(0,5).every((column,at)=>at+skip===2||column.every((number,track)=>number.text===String(((at+skip)*3+track)%12))));
    assert.notEqual(first,undefined,`${layout} ${zoom}%: the columns hold the numbers the score was made with`);log.firstBeat=first+1;
    // Down the tracks and back up again, and a track already active last: every click on a track's note makes it that track's.
    for(const [track,column] of [[1,1],[2,3],[0,4],[2,5],[1,3],[0,1],[0,6],[1,6]]) {
      const point=(await staffDigits())[column-first][track],before=await session.snapshot();
      assert.equal(point.text,String((column*3+track)%12),`${layout} ${zoom}%: the number clicked is track ${track+1}'s note on beat ${column+1} of the first bar`);
      await click(cdp,point.x,point.y);await sleep(500);
      const now=await where(),after=await session.snapshot(),beat=Number(/beat (\d+)/.exec(now.text)?.[1]),trackName=/Editing Track (\d+)/.exec(now.text)?.[1];
      log.clicks.push({track,column,digit:point.text,now:now.text,pressed:now.pressed});
      assert.equal(trackName,String(track+1),`${layout} ${zoom}%: a click on track ${track+1}'s fret number puts the cursor on that track (${now.text})`);
      assert.equal(now.pressed,track,`${layout} ${zoom}%: track ${track+1} is the active track`);
      assert.equal(beat,column+1,`${layout} ${zoom}%: the cursor is on the clicked beat (${now.text})`);
      assert.equal(after.project.edits.length,before.project.edits.length,`${layout} ${zoom}%: choosing a note records no edit`);
      assert.equal(after.dirty,before.dirty,`${layout} ${zoom}%: choosing a note does not dirty the document`);
    }
  }
  console.log(JSON.stringify({ok:true,tracks,...report},null,1));
}catch(error){console.log(JSON.stringify(report,null,1));throw error;}
finally{await session.close();}
