import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { getHelpTopics, searchHelp, searchTokens, updateStatus, type HelpResult, type HelpTopicId } from './help-topics';
import { Dialog } from '../ui/Dialog';
import { useI18n } from '../i18n';

interface Jump { section: string; focus: boolean }

/**
 * The help viewer: a search field, a topic list and the chosen topic, opened on the topic (and section) for what had focus.
 * While a search is on, the list shows the matching topics and the text is replaced by the matching sections.
 */
export function HelpDialog({ initial, initialSection, onClose }: { initial: HelpTopicId; initialSection?: string; onClose: () => void }) {
  const { t } = useI18n();
  const [topic, setTopic] = useState<HelpTopicId>(initial), [checked, setChecked] = useState<string | null>(null);
  const [query, setQuery] = useState(''), [jump, setJump] = useState<Jump | null>(initialSection ? { section: initialSection, focus: false } : null);
  const list = useId(), title = useId(), prefix = useId(), searchId = useId();
  const input = useRef<HTMLInputElement>(null), results = useRef<HTMLUListElement>(null), pending = useRef(query);
  pending.current = query;
  const topics = useMemo(() => getHelpTopics(t), [t]);
  const current = topics.find(entry => entry.id === topic) ?? topics[0];
  const searching = searchTokens(query).length > 0;
  const found = useMemo(() => (searching ? searchHelp(topics, query) : []), [topics, query, searching]);
  const matching = new Set(found.map(result => result.topic));
  const shown = searching ? topics.filter(entry => matching.has(entry.id)) : topics;
  const anchor = (id: string, section: string) => `${prefix}-${id}-${section}`;

  // Escape clears a search before it closes the dialog; the dialog's own handler listens on the document, so this one is earlier.
  useEffect(() => {
    const clear = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || !pending.current.trim()) return;
      event.preventDefault(); event.stopPropagation();
      setQuery('');
      input.current?.focus({ preventScroll: true });
    };
    window.addEventListener('keydown', clear, true);
    return () => window.removeEventListener('keydown', clear, true);
  }, []);

  useEffect(() => {
    if (!jump) return;
    const heading = document.getElementById(anchor(topic, jump.section));
    heading?.scrollIntoView?.({ block: 'start' });
    if (jump.focus) heading?.focus({ preventScroll: true });
    setJump(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump]);

  const open = (result: HelpResult) => { setTopic(result.topic); setChecked(null); setQuery(''); setJump({ section: result.section, focus: true }); };
  const announcement = !searching ? '' : found.length === 0 ? t('help.no_results', { query: query.trim() }) : found.length === 1 ? t('help.results_one') : t('help.results_other', { count: found.length });
  const fromField = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') { event.preventDefault(); if (found.length) open(found[0]); }
    else if (event.key === 'ArrowDown' && found.length) { event.preventDefault(); results.current?.querySelector<HTMLElement>('button')?.focus(); }
  };
  const fromResults = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLElement>('button')], at = buttons.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    event.preventDefault();
    if (event.key === 'ArrowDown') buttons[Math.min(at + 1, buttons.length - 1)].focus();
    else if (at === 0) input.current?.focus(); else buttons[at - 1].focus();
  };

  return <Dialog title={t('help.dialog_title')} onClose={onClose} dismissOnBackdrop className="help-dialog">
    <div className="help-layout">
      <nav aria-labelledby={list}>
        <div role="search" className="help-search"><label htmlFor={searchId} className="tp-sr">{t('help.search_label')}</label>
          <input ref={input} id={searchId} type="search" value={query} placeholder={t('help.search_placeholder')} aria-label={t('help.search_label')} autoComplete="off" spellCheck={false} onChange={event => setQuery(event.target.value)} onKeyDown={fromField} /></div>
        <h3 id={list}>{t('help.topics_heading')}</h3>
        <ul>{shown.map(entry => <li key={entry.id}>
          <button type="button" data-autofocus={(!searching && entry.id === topic) || undefined} aria-current={entry.id === topic ? 'true' : undefined} onClick={() => { setTopic(entry.id); setChecked(null); setQuery(''); setJump(null); }}>{entry.title}</button>
        </li>)}</ul>
      </nav>
      <div className="help-main">
        <p className="help-live" aria-live="polite" aria-atomic="true">{announcement}</p>
        {searching ? (found.length > 0 && <ul ref={results} className="help-results" aria-label={t('help.results_heading')} onKeyDown={fromResults}>{found.map(result => <li key={`${result.topic}/${result.section}`}>
          <button type="button" onClick={() => open(result)}>
            <span className="help-result-where">{result.whereParts.map((part, index) => part.match ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>)}</span>
            <span className="help-result-heading">{result.heading}</span>
            <span className="help-result-excerpt">{result.excerpt.map((part, index) => part.match ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>)}</span>
          </button>
        </li>)}</ul>) : <article aria-labelledby={title}>
          <h3 id={title}>{current.title}</h3>
          {current.sections.map(section => <section key={section.id} aria-labelledby={anchor(current.id, section.id)}>
            <h4 id={anchor(current.id, section.id)} tabIndex={-1}>{section.title}</h4>
            {section.paragraphs.map((text, index) => <p key={index}>{text}</p>)}
          </section>)}
          {topic === 'about' && <><button type="button" onClick={() => setChecked(updateStatus(t))}>{t('help.check_for_updates')}</button>
            <p role="status">{checked ?? ''}</p></>}
        </article>}
      </div>
    </div>
  </Dialog>;
}
