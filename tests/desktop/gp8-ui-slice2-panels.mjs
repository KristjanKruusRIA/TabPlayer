import assert from 'node:assert/strict';
import { checkWorkspace } from './gp8-ui-check.mjs';

await checkWorkspace(2, async page => {
  const score = page.locator('.score-workspace');
  for (const [key, pane] of [['F2', 'palette'], ['F3', 'dock'], ['F6', 'inspector']]) {
    const button = page.locator(`[data-pane-toggle="${pane}"]`);
    const before = await button.getAttribute('aria-pressed');
    await score.focus();
    await page.keyboard.press(key);
    assert.notEqual(await button.getAttribute('aria-pressed'), before, key);
    await score.focus();
    await page.keyboard.press(key);
    assert.equal(await button.getAttribute('aria-pressed'), before, key);
  }
  for (const [key, panel] of [['F7', '.instrument-view'], ['F8', '.instrument-keyboard']]) {
    await score.focus();
    await page.keyboard.press(key);
    await page.locator(panel).first().waitFor();
    await page.keyboard.press(key);
    await page.locator(panel).first().waitFor({state:'hidden'});
  }
  const tabs = page.locator('.inspector-tabs');
  if (!await tabs.isVisible()) await page.locator('[data-pane-toggle="inspector"]').click();
  assert.equal(await tabs.evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length), 2);
  const notationToggles = page.locator('.track-notation .notation-toggle');
  const toggleWidths = await notationToggles.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width));
  assert.ok(toggleWidths.length >= 2 && toggleWidths.every(w => w >= 28 && w <= 48), `Compact notation toggle widths: ${JSON.stringify(toggleWidths)}`);
  const lyrics = page.locator('[data-palette-id="lyrics"]');
  if (!await lyrics.isVisible()) await page.locator('[data-pane-toggle="palette"]').click();
  assert.ok(await lyrics.evaluate(el => el.offsetWidth > 40));
  const activeVoice = page.locator('.tp-toolbar-voices [aria-pressed=true]');
  const voiceColors = await activeVoice.evaluate(el => {
    const {color, backgroundColor} = getComputedStyle(el);
    return { color, backgroundColor };
  });
  assert.ok(voiceColors.color !== voiceColors.backgroundColor && voiceColors.backgroundColor !== 'rgba(0, 0, 0, 0)', `Active voice fill/contrast: ${JSON.stringify(voiceColors)}`);
});
