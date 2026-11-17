/**
 * The text of the pages of the latest export, as the desktop test hook keeps them: `window.__tabplayerTestExportPages` holds one array of pages
 * per export (src/export/bridge.ts), so the latest export is its last entry. Self-contained, because Playwright runs it in the page:
 * `page.evaluate(lastExportTexts)`. Throws when nothing was exported, so a missing hook is not mistaken for a score without numbers.
 */
export function lastExportTexts() {
  const exports = window.__tabplayerTestExportPages ?? [], pages = exports.at(-1);
  if (!pages) throw new Error('The page recorded no export.');
  return pages.flatMap(sheet => [...new DOMParser().parseFromString(sheet.svg, 'image/svg+xml').querySelectorAll('text')].map(text => text.textContent.trim()));
}
