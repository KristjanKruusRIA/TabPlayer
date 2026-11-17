import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { lastExportTexts } from './drum-tab-pages.mjs';

const page = text => ({ svg: `<svg xmlns="http://www.w3.org/2000/svg"><g><text>${text}</text></g><text> 42 </text></svg>`, width: 1, height: 1 });

test('reads the text of the latest export only: the hook keeps one array of pages per export', () => {
  globalThis.DOMParser = new JSDOM('').window.DOMParser;
  globalThis.window = { __tabplayerTestExportPages: [[page('1'), page('2')], [page('36'), page('38')]] };
  try {
    assert.deepEqual(lastExportTexts(), ['36', '42', '38', '42']);
    globalThis.window.__tabplayerTestExportPages = [];
    assert.throws(() => lastExportTexts(), /no export/i);
  } finally { delete globalThis.window; delete globalThis.DOMParser; }
});
