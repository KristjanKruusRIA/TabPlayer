// THE-213 (draw speed): probes that watch every presented frame of the score area. They run in the page and use the development hooks of the desktop test build
// (`globalThis.__tabplayerDrawStatsLog` and `__tabplayerDrawFlags`, src/engraving/draw-check.ts and draw-flags.ts).

/**
 * Starts sampling once per animation frame, after the frame was presented (a task posted from the animation-frame callback runs after the rendering step), so what is read is
 * what the main thread left on screen: for every piece of the score in view whether it has a drawing, how many highlighted beats there are, and where the playback cursor is.
 * This sees the main thread's state only: a compositor scroll can present a new position before its `scroll` event runs, which this cannot see.
 * @param {import('playwright').Page} page
 */
export async function startFrameSampler(page) {
  await page.evaluate(() => {
    const state = window.__frames = { on: true, frames: 0, blank: 0, blankFrames: [], run: 0, longestBlankRun: 0, expectHighlight: false, noHighlight: 0, noHighlightFrames: [], noHighlightRuns: [], noHighlightInfo: [], hlRun: 0, cursorMoves: 0, lineChanges: 0, lastCursorTop: null, lastCursorLeft: null, log: [] };
    const host = document.querySelector('.paper-scroll'), surface = document.querySelector('.score-paper-host .at-surface');
    const channel = new MessageChannel();
    const sample = () => {
      if (!state.on) return;
      const area = host.getBoundingClientRect();
      let blank = 0;
      for (const piece of surface.children) {
        const box = piece.getBoundingClientRect();
        if (box.height > 0 && box.bottom > area.top && box.top < area.bottom && !piece.querySelector('svg')) blank++;
      }
      state.frames++;
      if (blank && (state.blankInfo ??= []).length < 6) state.blankInfo.push({ frame: state.frames, scrollTop: host.scrollTop, pieces: [...surface.children].map((piece, index) => { const rect = piece.getBoundingClientRect(); return { index, top: Math.round(rect.top), h: Math.round(rect.height), children: piece.childElementCount, inView: rect.height > 0 && rect.bottom > area.top && rect.top < area.bottom }; }).filter(piece => piece.inView), highlights: document.querySelectorAll('.at-highlight').length });
      if (blank) { state.blank++; state.run++; state.longestBlankRun = Math.max(state.longestBlankRun, state.run); if (state.blankFrames.length < 20) state.blankFrames.push(state.frames); } else state.run = 0;
      // The sounding beat is expected to be highlighted while the bar cursor is in the score area; out of it (the person scrolled away) alphaTab clears the drawing and the highlight comes back with it.
      const cursorBox = document.querySelector('.at-cursor-bar')?.getBoundingClientRect(), cursorInView = !!cursorBox && cursorBox.bottom > area.top && cursorBox.top < area.bottom;
      if (state.expectHighlight && cursorInView && document.querySelectorAll('.at-highlight').length === 0 && state.hlRun === 0 && (state.noHighlightInfo ??= []).length < 6) {
        // What the page looks like where the first frame without a highlighted beat is: which system the cursor is in and whether it has a drawing.
        const bar = document.querySelector('.at-cursor-bar'), box = bar && bar.getBoundingClientRect();
        const pieces = [...surface.children].map((piece, index) => { const rect = piece.getBoundingClientRect(); return { index, top: Math.round(rect.top), h: Math.round(rect.height), children: piece.childElementCount, hit: !!box && box.top + box.height / 2 >= rect.top && box.top + box.height / 2 <= rect.bottom }; });
        state.noHighlightInfo.push({ frame: state.frames, scrollTop: host.scrollTop, cursor: box && [Math.round(box.left), Math.round(box.top), Math.round(box.width), Math.round(box.height)], cursorPiece: pieces.find(piece => piece.hit) ?? null, inView: pieces.filter(piece => piece.top < area.bottom && piece.top + piece.h > area.top) });
      }
      if (state.expectHighlight && cursorInView && document.querySelectorAll('.at-highlight').length === 0) { state.noHighlight++; state.hlRun++; if (state.noHighlightFrames.length < 20) state.noHighlightFrames.push(state.frames); } else if (state.hlRun) { state.noHighlightRuns.push([state.frames - state.hlRun, state.hlRun]); state.hlRun = 0; }
      // The bar cursor is placed by a transform (translate(x, y) in the score's own coordinates), so a change of y is a change of line, whatever the scroll position.
      const cursor = document.querySelector('.at-cursor-bar'), moved = cursor && /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(cursor.style.transform);
      if (moved) {
        const left = Number(moved[1]), top = Number(moved[2]);
        if (state.lastCursorTop !== null && Math.abs(top - state.lastCursorTop) > 20) state.lineChanges++;
        if (left !== state.lastCursorLeft || top !== state.lastCursorTop) state.cursorMoves++;
        state.lastCursorTop = top; state.lastCursorLeft = left;
      }
    };
    channel.port1.onmessage = sample;
    const frame = () => { if (!state.on) return; channel.port2.postMessage(0); requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
  });
}

/** Zeroes the counters (keeps sampling). */
export const resetFrameSampler = page => page.evaluate(() => {
  const state = window.__frames;
  Object.assign(state, { frames: 0, blank: 0, blankFrames: [], run: 0, longestBlankRun: 0, noHighlight: 0, noHighlightFrames: [], noHighlightRuns: [], noHighlightInfo: [], hlRun: 0, cursorMoves: 0, lineChanges: 0 });
});

/** Tells the sampler whether a highlighted beat is to be expected in every frame (playing). */
/** Notes what the driver is doing at the current frame, so a run of bad frames can be tied to a step. */
export const markFrame = (page, name) => page.evaluate(name => { const state = window.__frames; (state.marks ??= []).push([state.frames, name]); }, name);

export const expectHighlight = (page, value) => page.evaluate(value => { window.__frames.expectHighlight = value; }, value);

/** Stops sampling and returns the counters. */
export const stopFrameSampler = page => page.evaluate(() => { const state = window.__frames; state.on = false; return { ...state }; });

/**
 * The draw counts the app keeps (`recordDrawStats`): the ones taken at the end of a draw and after a scroll. `emptyInView` must be 0; `painted` may not exceed `allowed`.
 * @returns {Promise<{where:string,pieces:number,inView:number,emptyInView:number,painted:number,allowed:number}[]>}
 */
export const drawStatsLog = page => page.evaluate(() => (globalThis.__tabplayerDrawStatsLog ?? []).map(stats => ({ ...stats })));
export const clearDrawStatsLog = page => page.evaluate(() => { globalThis.__tabplayerDrawStatsLog = []; });
