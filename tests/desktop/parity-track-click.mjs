// THE-213: a single real click on a track's name (dock rows and Mixer view) makes it the active track: nothing is recorded, the
// document does not become dirty, the name says it is pressed, and a digit typed next is written on that track.
// usage: node tests/desktop/parity-track-click.mjs [small|large]
import assert from 'node:assert/strict';
import { openScore,settle,sleep,click,centre,fretPoint,press } from './entry-mix-support.mjs';

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
  console.log(JSON.stringify({ok:true,tracks,...report},null,1));
}catch(error){console.log(JSON.stringify(report,null,1));throw error;}
finally{await session.close();}
