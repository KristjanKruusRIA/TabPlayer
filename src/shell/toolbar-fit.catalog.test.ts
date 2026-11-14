import { describe, expect, it } from 'vitest';
import { catalogs } from '../i18n';

// The widths in toolbar-fit.ts were measured with these texts. They are the only visible, language-dependent texts of the toolbar
// that set its width: the display group's layout and track choices, fit buttons, visible-tracks summary and actual-zoom readout, and the
// transport's bar readout. (The transport row measured 1003px in all three languages; its other captions are out of the flow or icons.)
const measuredWith = {
  en: {
    'track_display.layout_vertical_page': 'Vertical page', 'track_display.layout_horizontal_page': 'Horizontal page', 'track_display.layout_grid': 'Grid',
    'track_display.layout_parchment': 'Parchment', 'track_display.layout_vertical_screen': 'Vertical screen', 'track_display.layout_horizontal_screen': 'Horizontal screen',
    'track_display.tracks_selected': 'Selected track', 'track_display.tracks_all': 'All tracks', 'track_display.tracks_custom': 'Chosen tracks',
    'track_display.fit_width': 'Fit width', 'track_display.fit_page': 'Fit page', 'track_display.visible_tracks_summary': 'Visible tracks',
    'track_display.actual_zoom_text': 'Actual zoom: {zoom}%', 'transport.bar_n': 'Bar {number}', 'transport.of_n': 'of {total}',
  },
  et: {
    'track_display.layout_vertical_page': 'Vertikaalne leht', 'track_display.layout_horizontal_page': 'Horisontaalne leht', 'track_display.layout_grid': 'Ruudustik',
    'track_display.layout_parchment': 'Pärgament', 'track_display.layout_vertical_screen': 'Vertikaalne ekraan', 'track_display.layout_horizontal_screen': 'Horisontaalne ekraan',
    'track_display.tracks_selected': 'Valitud rada', 'track_display.tracks_all': 'Kõik rajad', 'track_display.tracks_custom': 'Valitud rajad',
    'track_display.fit_width': 'Mahuta laius', 'track_display.fit_page': 'Mahuta leht', 'track_display.visible_tracks_summary': 'Nähtavad rajad',
    'track_display.actual_zoom_text': 'Tegelik suum: {zoom}%', 'transport.bar_n': 'Takt {number}', 'transport.of_n': '/ {total}',
  },
  de: {
    'track_display.layout_vertical_page': 'Vertikale Seite', 'track_display.layout_horizontal_page': 'Horizontale Seite', 'track_display.layout_grid': 'Raster',
    'track_display.layout_parchment': 'Pergament', 'track_display.layout_vertical_screen': 'Vertikaler Bildschirm', 'track_display.layout_horizontal_screen': 'Horizontaler Bildschirm',
    'track_display.tracks_selected': 'Ausgewählte Spur', 'track_display.tracks_all': 'Alle Spuren', 'track_display.tracks_custom': 'Ausgewählte Spuren',
    'track_display.fit_width': 'Breite anpassen', 'track_display.fit_page': 'Seite anpassen', 'track_display.visible_tracks_summary': 'Sichtbare Spuren',
    'track_display.actual_zoom_text': 'Tatsächlicher Zoom: {zoom}%', 'transport.bar_n': 'Takt {number}', 'transport.of_n': 'von {total}',
  },
} as const;

describe('the toolbar captions the measured widths rest on',()=>{
  for(const language of ['en','et','de'] as const)it(`are unchanged in ${language}`,()=>{
    const now=Object.fromEntries(Object.keys(measuredWith[language]).map(key=>[key,(catalogs[language] as Record<string,string>)[key]]));
    expect(now,'a toolbar caption changed — re-measure with tests/desktop/parity-key-shift.mjs and update toolbar-fit.ts (then update this list)').toEqual(measuredWith[language]);
  });
});
