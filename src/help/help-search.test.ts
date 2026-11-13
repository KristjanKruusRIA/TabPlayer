import { describe, expect, it } from 'vitest';
import { getMessage, type SupportedLanguage } from '../i18n';
import { foldText, getHelpTopics, searchHelp, searchTokens, type HelpTopic } from './help-topics';

const topic = (id: string, title: string, sections: Array<[string, string, string[]]>): HelpTopic => ({
  id: id as HelpTopic['id'], title,
  sections: sections.map(([sectionId, heading, paragraphs]) => ({ id: sectionId, title: heading, paragraphs })),
  paragraphs: sections.flatMap(([, , paragraphs]) => paragraphs),
});
const sample = [
  topic('files', 'Files', [
    ['open', 'Opening scores', ['Open a score with the File menu.', 'Drag files onto the window.']],
    ['recovery', 'Recovery', ['Unsaved work is restored after a crash. Rückgängig machen is the German word.']],
  ]),
  topic('playback', 'Playback', [
    ['loop', 'Looping a passage', ['Set the loop start and end, then press Loop.']],
    ['speed', 'Speed', ['The metronome follows the speed. Looping also works here.']],
  ]),
];

describe('foldText', () => {
  it('lowers case and removes accents', () => {
    expect(foldText('Rückgängig')).toBe('ruckgangig');
    expect(foldText('Löök ÕÄÖÜ')).toBe('look oaou');
    expect(foldText('Straße')).toBe('strasse');
  });
});

describe('searchHelp', () => {
  it('finds nothing for an empty or one-letter query', () => {
    expect(searchHelp(sample, '')).toEqual([]);
    expect(searchHelp(sample, '   ')).toEqual([]);
    expect(searchHelp(sample, 'm')).toEqual([]);
  });

  it('matches any case and without accents, in the heading or the text', () => {
    expect(searchHelp(sample, 'ruckgangig').map(result => `${result.topic}#${result.section}`)).toEqual(['files#recovery']);
    expect(searchHelp(sample, 'RÜCKGÄNGIG').map(result => `${result.topic}#${result.section}`)).toEqual(['files#recovery']);
    expect(searchHelp(sample, 'crash').map(result => result.section)).toEqual(['recovery']);
  });

  it('matches inside longer words, as German and Estonian compounds need', () => {
    expect(searchHelp(sample, 'passag').map(result => result.section)).toEqual(['loop']);
  });

  it('needs every word of the query', () => {
    expect(searchHelp(sample, 'loop speed').map(result => result.section)).toEqual(['speed']);
    expect(searchHelp(sample, 'loop crash')).toEqual([]);
  });

  it('puts heading matches before text matches', () => {
    const found = searchHelp(sample, 'loop').map(result => result.section);
    expect(found).toEqual(['loop', 'speed']);
    expect(searchHelp(sample, 'looping').map(result => result.section)).toEqual(['loop', 'speed']);
  });

  it('reports the topic, the heading and an excerpt that shows the match', () => {
    const [result] = searchHelp(sample, 'metronome');
    expect(result).toMatchObject({ topic: 'playback', topicTitle: 'Playback', section: 'speed', heading: 'Speed' });
    const shown = result.excerpt.map(part => part.text).join('');
    expect(shown).toContain('metronome');
    expect(result.excerpt.filter(part => part.match).map(part => part.text.toLowerCase())).toEqual(['metronome']);
  });

  it('keeps the accents of the text in the highlighted part', () => {
    const [result] = searchHelp(sample, 'ruckgangig');
    expect(result.excerpt.filter(part => part.match).map(part => part.text)).toEqual(['Rückgängig']);
  });

  it('shows the start of the section when only the heading matches, and bounds the excerpt', () => {
    const long = topic('start', 'Start', [['x', 'Zebra', ['A'.repeat(500)]]]);
    const [result] = searchHelp([long], 'zebra');
    const shown = result.excerpt.map(part => part.text).join('');
    expect(shown.length).toBeLessThanOrEqual(190);
    expect(result.excerpt.some(part => part.match)).toBe(false);
    const deep = topic('start', 'Start', [['x', 'Heading', [`${'word '.repeat(80)}needle ${'word '.repeat(80)}`]]]);
    const text = searchHelp([deep], 'needle')[0].excerpt.map(part => part.text).join('');
    expect(text.length).toBeLessThanOrEqual(190);
    expect(text).toContain('needle');
  });

  it('limits the number of results', () => {
    const many = topic('start', 'Start', Array.from({ length: 80 }, (_, index) => [`s${index}`, `Section ${index}`, ['common word']] as [string, string, string[]]));
    expect(searchHelp([many], 'common').length).toBe(40);
  });
});

describe('search words', () => {
  it('drops words of one letter and searches nothing when none is left', () => {
    expect(searchTokens('a b')).toEqual([]);
    expect(searchTokens(' Á  bc d ')).toEqual(['bc']);
    expect(searchHelp(sample, 'a b')).toEqual([]);
    expect(searchHelp(sample, 'a loop').map(result => result.section)).toEqual(searchHelp(sample, 'loop').map(result => result.section));
    const many = topic('start', 'Start', Array.from({ length: 80 }, (_, index) => [`s${index}`, `Section ${index}`, ['a b c']] as [string, string, string[]]));
    expect(searchHelp([many], 'a b')).toEqual([]);
  });
});

describe('topic titles', () => {
  it('finds a topic by its own name, ahead of section matches, and opens it at its first section', () => {
    const found = searchHelp(sample, 'playback');
    expect(found[0]).toMatchObject({ topic: 'playback', section: 'loop', topicTitle: 'Playback' });
    expect(found[0].whereParts.filter(part => part.match).map(part => part.text)).toEqual(['Playback']);
    expect(searchHelp(sample, 'files')[0]).toMatchObject({ topic: 'files', section: 'open' });
  });
});

describe('searchHelp in the real help', () => {
  const topicsIn = (lang: SupportedLanguage) => getHelpTopics((key, params) => getMessage(lang, key, params));
  const where = (lang: SupportedLanguage, query: string) => searchHelp(topicsIn(lang), query).map(result => `${result.topic}#${result.section}`);

  it('finds the words of each language', () => {
    expect(where('en', 'metronome')).toContain('playback#practice');
    expect(where('et', 'metronoom')).toContain('playback#practice');
    expect(where('de', 'metronom')).toContain('playback#practice');
    expect(where('en', 'capture')).toContain('tracks#nam');
    expect(where('en', 'differences in this file')).toContain('export#guitar-pro');
  });

  it('finds German and Estonian text without typing the accents', () => {
    expect(where('de', 'ruckgangig').length).toBeGreaterThan(0);
    expect(where('de', 'Rückgängig')).toEqual(where('de', 'ruckgangig'));
    expect(where('et', 'vota tagasi').length).toBeGreaterThan(0);
  });

  it('finds the same section by the name the interface uses for its control', () => {
    for (const lang of ['en', 'et', 'de'] as const) {
      const loop = getMessage(lang, 'transport.loop_selection');
      expect(where(lang, loop), `${lang} ${loop}`).toContain('playback#loop');
    }
  });

  it('returns every topic, in every language, as the first result for its own title', () => {
    for (const lang of ['en', 'et', 'de'] as const) for (const entry of topicsIn(lang)) {
      const first = searchHelp(topicsIn(lang), entry.title)[0];
      expect(first?.topic, `${lang}: ${entry.title}`).toBe(entry.id);
      expect(first.section, `${lang}: ${entry.title}`).toBe(entry.sections[0].id);
    }
  });

  it('finds the small-window text by its own words in each language', () => {
    expect(where('en', 'small window')).toContain('display#small');
    expect(where('et', 'väike aken')).toContain('display#small');
    expect(where('de', 'kleines fenster')).toContain('display#small');
  });

  it('says nothing for words the help does not use', () => {
    expect(where('en', 'xylophonequartz')).toEqual([]);
  });
});
