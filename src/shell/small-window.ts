/**
 * The tallest window height, in CSS pixels, that counts as small.
 *
 * `minHeight: 600` in tauri.conf.json sizes the window's inner (web view) area: with decorations on (the default) the title bar sits outside it, and the THE-56 walk
 * read an outerHeight of 901 for a configured height of 900, so `innerHeight` at the minimum window is about 600. The ticket measured 210 to 240px for the score at 960 by 600,
 * and 120px more height gives only about 330 to 360px (the dock is 144px for every height under 800), so 720 is not the window the ticket describes and stays unfolded.
 * The few pixels above 600 absorb the rounding of a fractional display scale. Derived from the ticket and the stylesheet, not measured in the app.
 */
export const compactWindowHeight=610;
