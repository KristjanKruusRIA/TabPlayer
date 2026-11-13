import { version } from '../../package.json';
import { getMessage, type MessageKey } from '../i18n';

/** The installed version; a test keeps it equal to the native app and package versions. */
export const appVersion: string = version;

export type HelpTopicId = 'start' | 'files' | 'display' | 'playback' | 'editing' | 'selection' | 'tracks' | 'inspector' | 'instruments' | 'engraving' | 'export' | 'palette' | 'shortcuts' | 'about';
export interface HelpSection { id: string; title: string; paragraphs: string[] }
export interface HelpTopic { id: HelpTopicId; title: string; sections: HelpSection[]; paragraphs: string[] }
export type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;
export interface HelpTarget { topic: HelpTopicId; section?: string }

interface SectionSpec { id: string; title: MessageKey; paragraphs: readonly MessageKey[] }
interface TopicSpec { id: HelpTopicId; title: MessageKey; sections: readonly SectionSpec[] }

/**
 * A paragraph name without a dot is `help.topic.<topic>.<section>.<name>`; one with a dot is a full catalog key, kept where
 * an older key must stay (a test pins some of them).
 */
function topic(id: HelpTopicId, sections: ReadonlyArray<readonly [string, readonly string[]]>): TopicSpec {
  return {
    id, title: `help.topic.${id}.title` as MessageKey,
    sections: sections.map(([section, names]) => ({
      id: section, title: `help.topic.${id}.${section}.title` as MessageKey,
      paragraphs: names.map(name => (name.includes('.') ? name : `help.topic.${id}.${section}.${name}`) as MessageKey),
    })),
  };
}

/** Every topic, section and paragraph key of the help, in reading order. The text lives in the catalogs. */
export const helpSpec: readonly TopicSpec[] = [
  topic('start', [['window', ['p1', 'p2']], ['first', ['p1']], ['help', ['p1', 'p2']]]),
  topic('files', [['open', ['p1', 'p2', 'p3', 'p4', 'p5']], ['import', ['ascii', 'midi']], ['batch', ['p1']], ['save', ['p1', 'p2', 'p3', 'p4']], ['recovery', ['p1', 'p2', 'p3']]]),
  topic('display', [['modes', ['p1', 'p2']], ['tracks', ['p1']], ['zoom', ['p1', 'p2', 'p3']], ['small', ['p1', 'p2']], ['defaults', ['p1']]]),
  topic('playback', [['play', ['p1', 'p2', 'p3']], ['loop', ['p1', 'p2', 'p3']], ['speed', ['p1', 'p2']], ['practice', ['p1', 'p2', 'p3', 'p4']], ['backing', ['p1', 'p2']], ['mixing', ['p1', 'p2', 'p3']], ['tuner', ['p1', 'p2', 'p3']]]),
  topic('editing', [['move', ['p1']], ['entry', ['p1', 'p2', 'p3', 'p4']], ['keys', ['intro', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6']], ['palette', ['help.topic.editing.p3', 'p2']], ['tools', ['p1']], ['undo', ['p1']]]),
  topic('selection', [['select', ['p1', 'p2']], ['clipboard', ['p1', 'p2', 'p3', 'p4']]]),
  topic('tracks', [['settings', ['p1', 'p2']], ['tuning', ['p1', 'p2', 'p3', 'p4']], ['sound', ['p1', 'p2', 'p3']], ['nam', ['p1', 'p2']], ['interpretation', ['p1']], ['midi', ['p1', 'p2']]]),
  topic('inspector', [['tabs', ['p1']], ['apply', ['p1']], ['practice', ['p1']]]),
  topic('instruments', [['views', ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']]]),
  topic('engraving', [['panel', ['p1', 'p2']], ['page', ['p1']]]),
  topic('export', [['start', ['p1']], ['formats', ['p1', 'p2', 'p3', 'p4', 'p5']], ['audio', ['p1', 'p2', 'p3']], ['guitar-pro', ['p1', 'p2', 'p3']]]),
  topic('palette', [['commands', ['p1', 'p2', 'p3']]]),
  topic('shortcuts', [['files', ['p1', 'p2']], ['practice', ['help.topic.shortcuts.practice']], ['clipboard', ['p3', 'help.topic.shortcuts.tie']], ['palette', ['p1']]]),
  topic('about', [['version', ['p1', 'p2']]]),
];

/** Every catalog key the help reads. */
export function specKeys(): MessageKey[] {
  return [...new Set(helpSpec.flatMap(entry => [entry.title, ...entry.sections.flatMap(section => [section.title, ...section.paragraphs])]))];
}

const marker = /\{@([A-Za-z0-9_.]+)\}/g;
/** The UI label keys a help text quotes, as `{@key}`. The help never types a control name by hand. */
export function labelKeysIn(text: string): string[] {
  return [...text.matchAll(marker)].map(match => match[1]);
}
/** Replaces each `{@key}` with that key's text in the language of `t`, so a quoted name always equals the interface's own. */
export function resolveLabels(text: string, t: Translate): string {
  return text.replace(marker, (_, key: string) => t(key as MessageKey));
}

export function getHelpTopics(t: Translate): readonly HelpTopic[] {
  const text = (key: MessageKey) => resolveLabels(t(key, { version: appVersion }), t);
  return helpSpec.map(entry => {
    const sections = entry.sections.map(section => ({ id: section.id, title: text(section.title), paragraphs: section.paragraphs.map(text) }));
    return { id: entry.id, title: text(entry.title), sections, paragraphs: sections.flatMap(section => section.paragraphs) };
  });
}

const english: Translate = (key, params) => getMessage('en', key, params);
export const helpTopics: readonly HelpTopic[] = getHelpTopics(english);

/** Areas of the window and the help they open; the first selector that holds an ancestor of the focused element wins. */
export const helpContexts: readonly (readonly [string, HelpTopicId, string?])[] = [
  ['.tuner', 'playback', 'tuner'],
  ['.line-in', 'playback', 'tuner'],
  ['.gp-practice-body', 'playback', 'practice'],
  ['.backing-panel', 'playback', 'backing'],
  ['.live-instrument-view', 'instruments', 'views'],
  ['.mixer-view', 'playback', 'mixing'],
  ['.sound-view', 'tracks', 'sound'],
  ['.score-palette', 'editing', 'palette'],
  ['.score-workspace', 'editing'],
  ['[aria-labelledby="inspector-track-midi-out"]', 'tracks', 'midi'],
  ['[aria-labelledby="inspector-track-sounds"]', 'tracks', 'sound'],
  ['[aria-labelledby="inspector-track-interpretation"]', 'tracks', 'interpretation'],
  ['[aria-labelledby="inspector-track-info"]', 'tracks', 'settings'],
  ['[aria-labelledby$="-song-notation"]', 'engraving', 'panel'],
  ['#inspector-panel-selection', 'editing', 'tools'],
  ['#inspector-panel-track', 'tracks'],
  ['.workstation-inspector', 'inspector'],
  ['.workstation-dock', 'playback'],
  ['.transport-loop', 'playback', 'loop'],
  ['.transport-speed', 'playback', 'speed'],
  ['.transport', 'playback'],
  ['.gp-toolbar-display', 'display', 'modes'],
  ['.toolbar', 'files'],
  ['.document-tabs', 'files'],
];

/** Picks the help topic, and the section when there is one, for the part of the window that had focus. */
export function helpTargetFor(element: Element | null): HelpTarget {
  for (const [selector, topic, section] of helpContexts) if (element?.closest(selector)) return section ? { topic, section } : { topic };
  return { topic: 'start' };
}
export function topicFor(element: Element | null): HelpTopicId {
  return helpTargetFor(element).topic;
}

/** What "Check for updates" reports: this build cannot check, so it says so plainly. */
export function updateStatus(t?: Translate): string {
  return (t ?? english)('help.update_status', { version: appVersion });
}

// ---- Search ----

/** Lower case without accents, so "Rückgängig" is found by "ruckgangig". ß becomes ss. */
export function foldText(text: string): string {
  return folded(text).text;
}
function folded(text: string): { text: string; start: number[]; end: number[] } {
  let out = '';
  const start: number[] = [], end: number[] = [];
  let at = 0;
  for (const char of text) {
    const piece = char.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/ß/g, 'ss');
    for (let i = 0; i < piece.length; i++) { start.push(at); end.push(at + char.length); }
    out += piece;
    at += char.length;
  }
  return { text: out, start, end };
}

export interface ExcerptPart { text: string; match: boolean }
export interface HelpResult { topic: HelpTopicId; topicTitle: string; whereParts: ExcerptPart[]; section: string; heading: string; excerpt: ExcerptPart[] }
export const MAX_RESULTS = 40;
const BEFORE = 50, AFTER = 110, HEAD = 160;

function ranges(source: ReturnType<typeof folded>, tokens: readonly string[]): Array<[number, number]> {
  const found: Array<[number, number]> = [];
  for (const token of tokens) for (let from = source.text.indexOf(token); from >= 0; from = source.text.indexOf(token, from + token.length)) {
    found.push([source.start[from], source.end[from + token.length - 1]]);
  }
  found.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of found) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]); else merged.push([...range]);
  }
  return merged;
}

function excerptOf(paragraphs: readonly string[], tokens: readonly string[]): ExcerptPart[] {
  for (const paragraph of paragraphs) {
    const marks = ranges(folded(paragraph), tokens);
    if (!marks.length) continue;
    const from = Math.max(0, marks[0][0] - BEFORE), to = Math.min(paragraph.length, marks[0][1] + AFTER);
    const parts: ExcerptPart[] = [];
    let cursor = from;
    if (from > 0) parts.push({ text: '…', match: false });
    for (const [a, b] of marks) {
      if (b <= from || a >= to) continue;
      const s = Math.max(a, from), e = Math.min(b, to);
      if (s > cursor) parts.push({ text: paragraph.slice(cursor, s), match: false });
      parts.push({ text: paragraph.slice(s, e), match: true });
      cursor = e;
    }
    if (cursor < to) parts.push({ text: paragraph.slice(cursor, to), match: false });
    if (to < paragraph.length) parts.push({ text: '…', match: false });
    return parts;
  }
  const first = paragraphs[0] ?? '';
  return [{ text: first.length > HEAD ? `${first.slice(0, HEAD)}…` : first, match: false }];
}

/**
 * The words a query searches for, folded. A one-letter word is kept when a longer word comes with it ("ctrl k"), because it then
 * narrows the result; a query of one-letter words alone searches nothing, since it would match nearly every section.
 */
export function searchTokens(query: string): string[] {
  const words = foldText(query).split(/\s+/).filter(Boolean);
  return words.some(word => word.length >= 2) ? words : [];
}
/** The words worth marking in a result: one-letter words would mark every such letter in the text. */
const marked = (tokens: readonly string[]) => tokens.filter(word => word.length >= 2);

function titleParts(title: string, tokens: readonly string[]): ExcerptPart[] {
  const parts: ExcerptPart[] = [];
  let cursor = 0;
  for (const [a, b] of ranges(folded(title), tokens)) {
    if (a > cursor) parts.push({ text: title.slice(cursor, a), match: false });
    parts.push({ text: title.slice(a, b), match: true });
    cursor = b;
  }
  if (cursor < title.length) parts.push({ text: title.slice(cursor), match: false });
  return parts;
}

/**
 * Results for a query: a topic whose title holds every word comes first and opens at its first section, then sections whose heading
 * and text hold every word, headings before text. Words match inside longer words. At most 40 results.
 */
export function searchHelp(topics: readonly HelpTopic[], query: string): HelpResult[] {
  const tokens = searchTokens(query);
  if (!tokens.length) return [];
  const scored: Array<{ score: number; order: number; result: HelpResult }> = [];
  let order = 0;
  for (const entry of topics) {
    const first = entry.sections[0];
    const named = !!first && tokens.every(token => foldText(entry.title).includes(token));
    if (named) scored.push({ score: 1000, order: order++, result: { topic: entry.id, topicTitle: entry.title, whereParts: titleParts(entry.title, marked(tokens)), section: first.id, heading: first.title, excerpt: excerptOf(first.paragraphs.slice(0, 1), []) } });
    for (const section of entry.sections) {
      order++;
      if (named && section === first) continue;
      const heading = foldText(section.title), body = foldText(section.paragraphs.join(String.fromCharCode(10)));
      let score = 0, all = true;
      for (const token of tokens) {
        if (heading.includes(token)) score += 10; else if (body.includes(token)) score += 1; else { all = false; break; }
      }
      if (!all) continue;
      scored.push({ score, order, result: { topic: entry.id, topicTitle: entry.title, whereParts: [{ text: entry.title, match: false }], section: section.id, heading: section.title, excerpt: excerptOf(section.paragraphs, marked(tokens)) } });
    }
  }
  return scored.sort((a, b) => b.score - a.score || a.order - b.order).slice(0, MAX_RESULTS).map(entry => entry.result);
}
