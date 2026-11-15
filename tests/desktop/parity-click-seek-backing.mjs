// THE-216: with a backing track, playback from a clicked beat keeps the backing going (real click, real Space).
// usage: node tests/desktop/parity-click-seek-backing.mjs [small|large]
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { directory } from './harness.mjs';
import { clickWorkstationButton,waitForWorkspaceIdle } from './workstation-commands.mjs';
import { openScore,settle,sleep,click,press,transport } from './entry-mix-support.mjs';

const size=process.argv[2]??'small',backing=join(directory,'click-seek-backing.wav');
const rate=48000,frames=rate*8,bytes=Buffer.alloc(44+frames*4);
bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(2,22);bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*4,28);bytes.writeUInt16LE(4,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(frames*4,40);
for(let frame=0;frame<frames;frame++){const tone=Math.round(Math.sin(frame/rate*440*Math.PI*2)*5000);bytes.writeInt16LE(tone,44+frame*4);bytes.writeInt16LE(tone,46+frame*4);}
writeFileSync(backing,bytes);

const session=await openScore(size,{TABPLAYER_TEST_BACKING:backing}),{page,cdp}=session,report={size};
try{
  const status=()=>page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('audio_status'));
  await clickWorkstationButton(page,'Import backing',{waitForIdle:false});await waitForWorkspaceIdle(page);
  const until=Date.now()+20000;let st;while(Date.now()<until){st=await status();if(st.backingDurationSeconds>7)break;await sleep(100);}
  assert.ok(st.backingDurationSeconds>7,'the backing track is imported');
  await settle(page,800);
  const point=await page.evaluate(()=>{const numbers=[...document.querySelector('.score-paper-host').querySelectorAll('svg text')].filter(text=>/^\d{1,2}$/.test(text.textContent)&&text.getBoundingClientRect().width>0&&!/rgb\(2[0-2]\d, ?\d+, ?\d+\)|red/.test(getComputedStyle(text).fill)).map(text=>{const r=text.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});const top=Math.min(...numbers.map(n=>n.y));const system=numbers.filter(n=>n.y<top+120);const columns=[...new Set(system.map(n=>Math.round(n.x/10)))].sort((a,b)=>a-b);return system.find(n=>Math.round(n.x/10)===columns[10]);});
  await click(cdp,point.x,point.y);await sleep(600);
  const clicked=await transport(page);
  assert.ok(clicked.tick>0,'the click moved the position');
  await press(cdp,' ');await sleep(800);
  st=await status();
  assert.equal(st.playing,true,'playback from the clicked beat with the backing track');assert.ok(st.tick>=clicked.tick-10,`the backing plays from the clicked position (tick ${st.tick}, clicked ${clicked.tick})`);
  assert.ok(st.backingDurationSeconds>7);
  report.result={clickedTick:clicked.tick,tick:st.tick,seconds:st.seconds,backingDurationSeconds:st.backingDurationSeconds};
  await press(cdp,' ');await sleep(300);
  console.log(JSON.stringify({ok:true,...report},null,1));
}catch(error){console.log(JSON.stringify(report,null,1));throw error;}
finally{await session.close();}
