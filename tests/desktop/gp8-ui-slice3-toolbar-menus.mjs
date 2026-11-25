import assert from 'node:assert/strict';
import { checkWorkspace } from './gp8-ui-check.mjs';
import { waitForWorkspaceIdle } from './workstation-commands.mjs';

await checkWorkspace(3, async page => {
  const toolbar = page.locator('.gp-toolbar');
  assert.equal(await toolbar.evaluate(el => getComputedStyle(el).gridTemplateRows.split(' ').length), 1);
  const controls = page.getByRole('button', { name: 'Score display', exact: true });
  await controls.click();
  await page.locator('.score-layout-select').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await controls.getAttribute('aria-expanded'), 'false');
  assert.match(await page.locator('.transport-lcd-meta').innerText(), /♩ = \d+/);
  const add = page.locator('.document-tab-new');
  await add.waitFor();
  const tabs = page.locator('.document-tabs').getByRole('tab');
  const before = await tabs.count();
  await add.click();
  await waitForWorkspaceIdle(page);
  await tabs.nth(before).waitFor();
  assert.ok(await tabs.nth(before).evaluate(el => el === document.activeElement));
  await page.locator('.document-tab-item[data-active=true] .document-tab-close').click();
  await waitForWorkspaceIdle(page);
  assert.equal(await tabs.count(), before);
  for (const label of ['Bar','Note','Effects','Section','Tools']) {
    const menu = page.locator('.command-menu').filter({has: page.locator('summary', {hasText: new RegExp(`^${label}$`)})});
    await menu.locator('summary').click();
    const visibleButtons = menu.locator('section button:visible');
    const count = await visibleButtons.count();
    assert.ok(count >= (label === 'Effects' ? 6 : 2), `${label} menu count ${count}`);
    const kbdLayout = await visibleButtons.evaluateAll(buttons => buttons.flatMap(btn => {
      const kbd = btn.querySelector('kbd');
      if (!kbd) return [];
      const b = btn.getBoundingClientRect(), k = kbd.getBoundingClientRect();
      return [{ label: btn.textContent?.trim(), leftGap: k.left - b.left, width: b.width, kRight: k.right, bRight: b.right }];
    }));
    for (const row of kbdLayout) {
      assert.ok(row.leftGap > 40 && row.kRight <= row.bRight + 1, `Aligned shortcut hint in ${label}: ${JSON.stringify(row)}`);
    }
    await page.keyboard.press('Escape');
  }
});
