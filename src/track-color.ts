import { model } from '@coderline/alphatab';

const hexColor=/^#[0-9a-f]{6}$/i;

/** A track color as the `#rrggbb` value a color input shows. */
export function trackColorHex(color:model.Color):string {
  return '#'+[color.r,color.g,color.b].map(channel=>channel.toString(16).padStart(2,'0')).join('');
}

/** Reads a `#rrggbb` track color as an opaque alphaTab color; GPIF stores tracks as RGB only. */
export function parseTrackColor(value:unknown):model.Color {
  if(typeof value!=='string'||!hexColor.test(value))throw new Error('Choose a track color as #rrggbb.');
  const rgb=Number.parseInt(value.slice(1),16);
  return new model.Color(rgb>>16&255,rgb>>8&255,rgb&255,255);
}
