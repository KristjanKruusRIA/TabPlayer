import assert from 'node:assert/strict';
import { checkWorkspace } from './gp8-ui-check.mjs';

await checkWorkspace(4, async (page, capture) => {
  const dock = page.locator('[data-pane-toggle="dock"]');
  if (await dock.getAttribute('aria-pressed') !== 'true') await dock.click();
  const track = page.locator('.score-overview-track-name').first();
  assert.ok((await track.boundingBox()).width >= 150);
  const trackFader = page.locator('.score-overview-track .dock-fader').first();
  const masterFader = page.locator('.score-overview-master input[type="range"]').first();
  assert.ok(Math.abs((await trackFader.boundingBox()).x - (await masterFader.boundingBox()).x) <= 1);
  for (const [view, selector] of [['Mixer', '.mixer-view'], ['Sound', '.sound-view']]) {
    const button = page.getByRole('radio', {name:view, exact:true});
    await button.click();
    await page.locator(selector).waitFor();
    assert.ok(await button.evaluate(el => el === document.activeElement));
    await capture(view.toLowerCase());
  }
  await page.getByRole('radio', {name:'Score', exact:true}).click();
});
