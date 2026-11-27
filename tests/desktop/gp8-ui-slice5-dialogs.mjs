import assert from 'node:assert/strict';
import { checkWorkspace } from './gp8-ui-check.mjs';
import { openProperties, openScoreStyle } from './workstation-commands.mjs';

await checkWorkspace(5, async (page, capture) => {
  await page.locator('.score-workspace').focus();
  await page.keyboard.press('Control+,');
  const preferences = page.getByRole('dialog', {name:'Preferences', exact:true});
  await preferences.getByLabel('Language', {exact:true}).waitFor();
  await capture('preferences');
  await page.keyboard.press('Escape');
  await preferences.waitFor({state:'hidden'});
  assert.ok(await page.locator('.score-workspace').evaluate(el => el === document.activeElement));

  const view = page.locator('.command-menu').filter({has: page.locator('summary', {hasText:/^View$/})});
  await view.locator('summary').click();
  assert.equal(await view.locator('fieldset').count(), 0);
  await view.getByRole('button', {name:'Preferences', exact:true}).click();
  await preferences.waitFor();
  await page.keyboard.press('Escape');
  assert.ok(await view.locator('summary').evaluate(el => el === document.activeElement));

  const add = page.getByRole('button', {name:'Add a track', exact:true});
  if (!await add.isVisible()) await page.locator('[data-pane-toggle="dock"]').click();
  await add.click();
  const addTrack = page.getByRole('dialog', {name:'Add track', exact:true});
  await addTrack.getByLabel('New track name').waitFor();
  assert.equal(await addTrack.getByRole('tab').count(), 4);
  const guitarColor = await addTrack.getByLabel('Track color').inputValue();
  assert.notEqual(guitarColor.toLowerCase(), '#c80000');
  await addTrack.getByRole('tab', {name:'Orchestra', exact:true}).click();
  const orchColor = await addTrack.getByLabel('Track color').inputValue();
  assert.notEqual(orchColor, guitarColor);
  await addTrack.getByRole('tab', {name:'Stringed', exact:true}).click();
  await addTrack.getByRole('listbox', {name:'Instrument groups', exact:true}).getByRole('option', {name:'Other', exact:true}).click();
  await capture('add-track');
  const tune = addTrack.getByRole('button', {name:/^Edit new track tuning/});
  await tune.click();
  const tuning = page.getByRole('dialog', {name:'Tuning', exact:true});
  assert.ok(await tuning.locator('[data-autofocus]').evaluate(el => el === document.activeElement));
  await capture('tuning');
  await page.keyboard.press('Escape');
  await tuning.waitFor({state:'hidden'});
  assert.ok(await tune.evaluate(el => el === document.activeElement));
  await page.keyboard.press('Escape');
  await addTrack.waitFor({state:'hidden'});
  assert.ok(await add.evaluate(el => el === document.activeElement));

  const properties = await openProperties(page);
  const firstTab = properties.getByRole('tab', {selected:true});
  const firstLabel = await firstTab.innerText();
  await page.keyboard.press('ArrowRight');
  assert.notEqual(await firstTab.innerText(), firstLabel);
  await page.keyboard.press('Escape');
  await properties.waitFor({state:'hidden'});
  const scoreStyle = await openScoreStyle(page);
  assert.ok(await scoreStyle.getByRole('tab', {selected:true}).evaluate(el => el === document.activeElement));
  await page.keyboard.press('Escape');
  await scoreStyle.waitFor({state:'hidden'});

  const exportButton = page.locator('.gp-toolbar').getByRole('button', {name:'Export or print…', exact:true});
  await exportButton.click();
  const exporting = page.getByRole('dialog', {name:'Export score', exact:true});
  await exporting.waitFor();
  await capture('export');
  await page.keyboard.press('Escape');
  await exporting.waitFor({state:'hidden'});
});
