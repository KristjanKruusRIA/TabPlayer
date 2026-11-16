import {waitForWorkspaceIdle,clickWorkspaceCommand,closeWelcomeLibrary,setFret} from './workstation-commands.mjs';
import {launch,connect,stop,directory} from './harness.mjs';
import {resolve} from 'node:path';
import {writeFileSync} from 'node:fs';
const id=launch({TABPLAYER_TEST_OPEN:resolve('.analysis/performance-project.tabplayer')});
const browser=await connect();const page=browser.contexts()[0].pages()[0];
try {
  await closeWelcomeLibrary(page);
  const start=performance.now();await clickWorkspaceCommand(page,'Open',{waitForIdle:false});
  await waitForWorkspaceIdle(page);await page.waitForFunction(()=>document.querySelector('.score-tools').textContent.includes('100 measures'));
  await page.locator('svg text').filter({hasText:/^Performance study$/}).first().waitFor();
  const openRenderMs=performance.now()-start;
  // The edit is the palette's 'fret 13' (the Fret field and Set note are gone), so the time includes opening and running the command.
  const before=performance.now();await setFret(page,13);
  await waitForWorkspaceIdle(page);
  await page.locator('svg text').filter({hasText:/^13$/}).first().waitFor();
  const editRenderMs=performance.now()-before;
  await page.screenshot({path:resolve(directory,'preview.png')});
  writeFileSync(resolve(directory,'render-metrics.json'),JSON.stringify({openRenderMs,editRenderMs},null,2));
  console.log({openRenderMs,editRenderMs});
} finally {await browser.close();stop(id);}
