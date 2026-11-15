// THE-215: lists every control in the Song, Track and Selection tabs of the inspector as the app shows them at its default
// window size (collapsed sections closed), with each tab's content height. Reads only; changes nothing in the score.
// usage (from the checkout root, after scripts/build-desktop-test.ps1): node tests/desktop/inspector-inventory.mjs [out.json] [screenshot-directory]
import { mkdirSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openScore,settle } from './entry-mix-support.mjs';
import { revealInspectorTab } from './workstation-commands.mjs';

const out=process.argv[2]??'.analysis/desktop-smoke/inspector-inventory.json',shots=process.argv[3]?resolve(process.argv[3]):null;
if(shots)mkdirSync(shots,{recursive:true});
const session=await openScore('small'),{page}=session,report={viewport:null,tabs:{}};
const collect=tab=>page.evaluate(tab=>{
  const panel=document.querySelector(`#inspector-panel-${tab}`),host=document.querySelector('.workstation-inspector');
  const label=node=>(node.getAttribute('aria-label')||node.labels?.[0]?.textContent||node.getAttribute('title')||node.textContent||'').trim().replace(/\s+/g,' ').slice(0,60);
  const section=node=>{
    let at=node;
    while(at&&at!==panel){
      const details=at.closest('details');
      if(details&&panel.contains(details)){const s=details.querySelector(':scope>summary');return `${s?s.textContent.trim():'details'}${details.open?'':' (closed)'}`;}
      at=at.parentElement;
    }
    const heading=[...panel.querySelectorAll('h2,h3')].filter(h=>h.compareDocumentPosition(node)&Node.DOCUMENT_POSITION_FOLLOWING).at(-1);
    return heading?heading.textContent.trim():'';
  };
  const controls=[];
  for(const node of panel.querySelectorAll('button,input,select,textarea,summary,[role=slider],[role=switch]')){
    const hidden=!node.getClientRects().length,closedAncestor=node.closest('details:not([open])')&&node.tagName!=='SUMMARY'&&!node.matches('details:not([open])>summary');
    const r=node.getBoundingClientRect();
    controls.push({section:section(node),kind:node.tagName.toLowerCase()+(node.type?`:${node.type}`:''),label:label(node),shown:!hidden&&!closedAncestor,top:Math.round(r.top-panel.getBoundingClientRect().top),height:Math.round(r.height)});
  }
  return {scrollHeight:panel.scrollHeight,clientHeight:host.clientHeight,width:Math.round(host.getBoundingClientRect().width),controls};
},tab);
try{
  report.viewport=await page.evaluate(()=>({w:innerWidth,h:innerHeight}));
  for(const tab of ['Song','Track']){
    await revealInspectorTab(page,tab);await settle(page,500);
    const result=await collect(tab.toLowerCase());report.tabs[tab]={...result,shown:result.controls.filter(c=>c.shown).length,all:result.controls.length};
    if(shots)await page.screenshot({path:resolve(shots,`inventory-${tab.toLowerCase()}.png`)});
  }
  writeFileSync(out,JSON.stringify(report,null,1));
  for(const [tab,data] of Object.entries(report.tabs))console.log(`${tab}: content ${data.scrollHeight}px, pane ${data.clientHeight}px, width ${data.width}px, ${data.shown} visible controls of ${data.all}`);
}finally{await session.close();}
