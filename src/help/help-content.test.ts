// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { catalogs, getMessage, type MessageKey, type SupportedLanguage } from '../i18n';
import { gpWarning } from '../export/gp-warning';
import { appVersion, getHelpTopics, helpContexts, helpSpec, helpTargetFor, labelKeysIn, specKeys, topicFor, type HelpTopicId } from './help-topics';

const languages: readonly SupportedLanguage[] = ['en', 'et', 'de'];
const table = (lang: SupportedLanguage) => catalogs[lang] as Record<string, string>;
const placeholders = (text: string) => [...text.matchAll(/\{(@?[\w.]+)\}/g)].map(match => match[1]).sort();

describe('help catalog', () => {
  it('has every help key in en, et and de with a non-empty value', () => {
    expect(specKeys().length).toBeGreaterThan(100);
    for (const lang of languages) for (const key of specKeys()) {
      const value = table(lang)[key];
      expect(typeof value, `${lang} ${key}`).toBe('string');
      expect(value.trim().length, `${lang} ${key} is empty`).toBeGreaterThan(0);
    }
  });

  it('keeps the same placeholders and label references in every language', () => {
    for (const key of specKeys()) {
      const english = placeholders(table('en')[key]);
      for (const lang of ['et', 'de'] as const) expect(placeholders(table(lang)[key]), `${lang} ${key}`).toEqual(english);
    }
  });

  it('references only UI labels that exist, with a value, in every language', () => {
    const referenced = new Set<string>();
    for (const key of specKeys()) for (const label of labelKeysIn(table('en')[key])) referenced.add(label);
    expect(referenced.size).toBeGreaterThan(80);
    for (const lang of languages) for (const label of referenced) {
      const value = table(lang)[label];
      expect(typeof value, `${lang} label ${label}`).toBe('string');
      expect(value.trim().length, `${lang} label ${label} is empty`).toBeGreaterThan(0);
    }
  });

  it('writes each quoted UI name with the language of the interface', () => {
    for (const lang of languages) {
      const t = (key: MessageKey, params?: Record<string, string | number>) => getMessage(lang, key, params);
      const topics = getHelpTopics(t);
      const text = topics.flatMap(topic => topic.paragraphs).join('\n');
      expect(text, lang).not.toMatch(/\{@|\{version\}/);
      for (const key of specKeys()) for (const label of labelKeysIn(table(lang)[key])) {
        expect(text, `${lang}: ${label}`).toContain(t(label as MessageKey));
      }
    }
  });

  it('never types a menu path or a label by hand: arrows join references only (quotes allowed around them)', () => {
    for (const lang of languages) for (const key of specKeys()) {
      const raw = table(lang)[key];
      expect(raw, `${lang} ${key}`).not.toMatch(/[^}\s“”]\s*→|→\s*[^{\s„“]/);
    }
  });

  it('uses the platform key names of each language (no Ctrl in German)', () => {
    for (const key of specKeys()) expect(table('de')[key], key).not.toContain('Ctrl');
  });

  it('names the version only through the placeholder', () => {
    const about = getHelpTopics(key => table('en')[key]).find(topic => topic.id === 'about')!;
    expect(about.paragraphs.join(' ')).toContain('{version}');
    expect(getHelpTopics(key => getMessage('en', key, key === 'help.topic.about.version.p1' ? { version: appVersion } : undefined)).find(topic => topic.id === 'about')!.paragraphs[0]).toContain(appVersion);
  });
});

describe('help coverage', () => {
  const sections = helpSpec.flatMap(topic => topic.sections.map(section => `${topic.id}#${section.id}`));

  it('has unique topic and section ids', () => {
    expect(new Set(helpSpec.map(topic => topic.id)).size).toBe(helpSpec.length);
    expect(new Set(sections).size).toBe(sections.length);
  });

  it('keeps every topic the viewer had', () => {
    expect(helpSpec.map(topic => topic.id)).toEqual(expect.arrayContaining(['start', 'editing', 'tracks', 'inspector', 'playback', 'files', 'shortcuts', 'about']));
  });

  it('describes the parts of the app a new user looks for', () => {
    expect(sections).toEqual(expect.arrayContaining([
      'files#open', 'files#import', 'files#batch', 'files#save', 'files#recovery',
      'display#modes', 'display#zoom', 'display#small',
      'playback#loop', 'playback#speed', 'playback#practice', 'playback#backing', 'playback#mixing', 'playback#tuner',
      'editing#entry', 'editing#keys', 'editing#palette',
      'selection#select', 'selection#clipboard',
      'tracks#tuning', 'tracks#sound', 'tracks#nam', 'tracks#midi',
      'instruments#views', 'engraving#panel', 'engraving#page',
      'export#formats', 'export#audio', 'export#guitar-pro',
      'palette#commands',
    ]));
  });

  it('gives every section a heading and at least one paragraph in every language', () => {
    for (const lang of languages) {
      const topics = getHelpTopics((key, params) => getMessage(lang, key, params));
      for (const topic of topics) {
        expect(topic.title.trim(), `${lang} ${topic.id}`).not.toBe('');
        for (const section of topic.sections) {
          expect(section.title.trim(), `${lang} ${topic.id}#${section.id}`).not.toBe('');
          expect(section.paragraphs.length, `${lang} ${topic.id}#${section.id}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('flattens the sections into the topic paragraphs', () => {
    for (const topic of getHelpTopics(key => table('en')[key])) expect(topic.paragraphs).toEqual(topic.sections.flatMap(section => section.paragraphs));
  });

  it('names the Guitar Pro export question by the title the app gives it', () => {
    for (const lang of languages) {
      const section = getHelpTopics((key, params) => getMessage(lang, key, params)).find(topic => topic.id === 'export')!.sections.find(entry => entry.id === 'guitar-pro')!;
      expect(section.paragraphs.join(' '), lang).toContain(gpWarning(['x']).title);
    }
  });

  it('refers to the score display button and the fret label through the catalog', () => {
    const small = table('en')['help.topic.display.small.p1'];
    expect(labelKeysIn(table('en')['help.topic.start.window.p2'])).toContain('dock.keyboard');
    expect(labelKeysIn(table('en')['help.topic.display.small.p2'])).toContain('dock.keyboard');
    for (const key of ['instruments.click_to_edit', 'dock.keyboard', 'instruments.note_names', 'instruments.note_names_octave', 'instruments.note_names_letter', 'instruments.focus_beat', 'instruments.focus_bar']) {
      expect(labelKeysIn(['p4', 'p5', 'p6', 'p7'].map(name => table('en')[`help.topic.instruments.views.${name}`]).join(' ')), key).toContain(key);
    }
    expect(labelKeysIn(small)).toContain('track_display.toolbar_aria');
    const text = (key: string) => table('en')[key].replace(/\{@[^}]+\}/g, '');
    for (const lang of languages) for (const key of specKeys()) {
      const raw = table(lang)[key].replace(/\{@[^}]+\}/g, '');
      if (lang === 'et') expect(raw, key).not.toMatch(/krihv/i);
      if (lang === 'de') expect(raw, key).not.toMatch(/\bBund/);
      if (lang === 'en' && key !== 'help.topic.editing.p3') expect(text(key), key).not.toMatch(/\bfrets?\b/i);
    }
    for (const lang of languages) for (const key of ['help.topic.editing.move.p1', 'help.topic.export.formats.p5'] as const) {
      expect(labelKeysIn(table(lang)[key]), `${lang} ${key}`).toContain('editor.fret');
      const shown = getHelpTopics((k, params) => getMessage(lang, k, params)).flatMap(topic => topic.paragraphs).join('\n');
      expect(shown, lang).toContain(table(lang)['editor.fret']);
    }
    expect(table('en')['help.topic.editing.move.p1']).toContain('“{@editor.fret}”');
    expect(table('en')['help.topic.export.formats.p5']).toContain('“{@editor.fret}”');
  });

  it('tells the Guitar Pro export warning heading as the app writes it, in every language', () => {
    const phrase = 'Differences in this file';
    expect(gpWarning(['x']).message).toContain(phrase);
    for (const lang of languages) {
      const topics = getHelpTopics((key, params) => getMessage(lang, key, params));
      const section = topics.find(topic => topic.id === 'export')!.sections.find(entry => entry.id === 'guitar-pro')!;
      expect(section.paragraphs.join(' '), lang).toContain(phrase);
    }
  });
});

describe('context help', () => {
  const topicIds = new Set<HelpTopicId>(helpSpec.map(topic => topic.id));
  const sectionIds = (topic: HelpTopicId) => new Set(helpSpec.find(entry => entry.id === topic)!.sections.map(section => section.id));

  it('maps every context to an existing topic and section', () => {
    expect(helpContexts.length).toBeGreaterThan(12);
    for (const [selector, topic, section] of helpContexts) {
      expect(topicIds.has(topic), `${selector} -> ${topic}`).toBe(true);
      if (section !== undefined) expect(sectionIds(topic).has(section), `${selector} -> ${topic}#${section}`).toBe(true);
    }
  });

  it('uses selectors the browser accepts', () => {
    for (const [selector] of helpContexts) expect(() => document.querySelector(selector), selector).not.toThrow();
  });

  it('does not map one selector twice', () => {
    const selectors = helpContexts.map(([selector]) => selector);
    expect(new Set(selectors).size).toBe(selectors.length);
  });

  it('reaches the topic and section for the new panels from their controls', () => {
    document.body.innerHTML = `
      <div class="workstation-inspector">
        <div role="tabpanel" id="inspector-panel-track">
          <section aria-labelledby="inspector-track-midi-out"><select id="midi"></select></section>
          <section aria-labelledby="inspector-track-sounds"><select id="sound"></select></section>
          <section aria-labelledby="inspector-track-interpretation"><select id="interp"></select></section>
          <section aria-labelledby="inspector-track-info"><input id="info"></section>
        </div>
        <div role="tabpanel" id="inspector-panel-song"><section aria-labelledby=":r1:-song-notation"><input id="notation"></section></div>
        <div role="tabpanel" id="inspector-panel-selection"><input id="selection"></div>
      </div>
      <header class="gp-toolbar"><div class="gp-toolbar-display"><select id="mode"></select></div>
        <div class="transport"><div class="transport-loop"><input id="loop"></div><div class="transport-speed"><input id="speed"></div><button id="play"></button></div>
        <details class="gp-practice"><div class="gp-practice-body"><input id="practice"><div class="tuner"><button id="tuner"></button></div><div class="line-in"><button id="linein"></button></div></div></details></header>
      <section class="workstation-dock"><div class="backing-panel"><input id="backing"></div><section class="live-instrument-view"><input id="instrument"></section><button id="dock"></button></section>
      <section class="score-workspace"><aside class="score-palette"><button id="palette"></button></aside><div id="score" tabindex="0"></div></section>
      <section class="sound-view"><button id="rig"></button></section><section class="mixer-view"><button id="mixer"></button></section>`;
    const at = (id: string) => helpTargetFor(document.getElementById(id));
    expect(at('midi')).toEqual({ topic: 'tracks', section: 'midi' });
    expect(at('sound')).toEqual({ topic: 'tracks', section: 'sound' });
    expect(at('interp')).toEqual({ topic: 'tracks', section: 'interpretation' });
    expect(at('info')).toEqual({ topic: 'tracks', section: 'settings' });
    expect(at('notation')).toEqual({ topic: 'engraving', section: 'panel' });
    expect(at('selection')).toEqual({ topic: 'editing', section: 'tools' });
    expect(at('mode')).toEqual({ topic: 'display', section: 'modes' });
    expect(at('loop')).toEqual({ topic: 'playback', section: 'loop' });
    expect(at('speed')).toEqual({ topic: 'playback', section: 'speed' });
    expect(at('play').topic).toBe('playback');
    expect(at('practice')).toEqual({ topic: 'playback', section: 'practice' });
    expect(at('tuner')).toEqual({ topic: 'playback', section: 'tuner' });
    expect(at('linein')).toEqual({ topic: 'playback', section: 'tuner' });
    expect(at('backing')).toEqual({ topic: 'playback', section: 'backing' });
    expect(at('instrument')).toEqual({ topic: 'instruments', section: 'views' });
    expect(at('dock').topic).toBe('playback');
    expect(at('palette')).toEqual({ topic: 'editing', section: 'palette' });
    expect(at('score').topic).toBe('editing');
    expect(at('rig')).toEqual({ topic: 'tracks', section: 'sound' });
    expect(at('mixer')).toEqual({ topic: 'playback', section: 'mixing' });
    expect(topicFor(document.getElementById('midi'))).toBe('tracks');
    expect(helpTargetFor(null)).toEqual({ topic: 'start' });
    document.body.innerHTML = '';
  });
});
