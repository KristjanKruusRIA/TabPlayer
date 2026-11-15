/**
 * How the score is drawn (THE-213, draw speed). Every field is on in the released app. In development, in tests and in the desktop test build
 * `globalThis.__tabplayerDrawFlags` is this object, so a driver can switch a change off and measure the old behaviour on the same build.
 */
export const drawFlags={
  /** Paint only the systems in view with the draw (the vertical live layouts); alphaTab paints the others as they scroll into view. */
  lazy:true,
  /**
   * How many times (16 ms each) a draw gives way to keys that are waiting before it runs anyway. A draw of the whole score took a fifth of a second and could not
   * be interrupted, so it let a typed key go first; a draw that paints only what is in view takes a few tens of milliseconds, and the key-up of the key just
   * typed counts as waiting input, which held every draw back for about 100 ms. The old behaviour is 6.
   */
  deferrals:0,
};
const developerHooks=(()=>{const env=(import.meta as {env?:{DEV?:boolean;MODE?:string;VITE_DESKTOP_TEST?:string}}).env;return !!(env?.DEV||env?.MODE==='test'||env?.VITE_DESKTOP_TEST==='1');})();
if(developerHooks)(globalThis as {__tabplayerDrawFlags?:typeof drawFlags}).__tabplayerDrawFlags=drawFlags;
