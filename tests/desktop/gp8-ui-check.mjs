import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { connect, directory, launch, stop } from './harness.mjs';
import { closeWelcomeLibrary, waitForWorkspaceIdle } from './workstation-commands.mjs';

export async function checkWorkspace(slice, check) {
  const id = launch();
  let browser;
  try {
    browser = await connect();
    const page = browser.contexts()[0].pages()[0];
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await waitForWorkspaceIdle(page);
    await closeWelcomeLibrary(page);
    for (const [width, height] of [[1366, 768], [1920, 1080]]) {
      await page.setViewportSize({ width, height });
      await check(page, name => capture(page, slice, width, name));
      await capture(page, slice, width);
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await stop(id);
  }
}

async function capture(page, slice, width, name) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  const suffix = name ? `-${name}` : '';
  await page.screenshot({ path: resolve(directory, `gp8-slice${slice}${suffix}-${width}.png`) });
}
