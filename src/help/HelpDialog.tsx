import { useId, useState } from 'react';
import { getHelpTopics, updateStatus, type HelpTopicId } from './help-topics';
import { Dialog } from '../ui/Dialog';
import { useI18n } from '../i18n';

/** The help viewer: a topic list and the chosen topic, opened on the topic for what had focus. */
export function HelpDialog({ initial, onClose }: { initial: HelpTopicId; onClose: () => void }) {
  const { t } = useI18n();
  const [topic, setTopic] = useState<HelpTopicId>(initial), [checked, setChecked] = useState<string | null>(null);
  const list = useId(), title = useId();
  const topics = getHelpTopics(t);
  const current = topics.find(entry => entry.id === topic) ?? topics[0];
  return <Dialog title={t('help.dialog_title')} onClose={onClose} dismissOnBackdrop className="help-dialog">
    <div className="help-layout">
      <nav aria-labelledby={list}><h3 id={list}>{t('help.topics_heading')}</h3><ul>{topics.map(entry => <li key={entry.id}>
        <button type="button" data-autofocus={entry.id === topic || undefined} aria-current={entry.id === topic ? 'true' : undefined} onClick={() => { setTopic(entry.id); setChecked(null); }}>{entry.title}</button>
      </li>)}</ul></nav>
      <article aria-labelledby={title}>
        <h3 id={title}>{current.title}</h3>
        {current.paragraphs.map(text => <p key={text}>{text}</p>)}
        {topic === 'about' && <><button type="button" onClick={() => setChecked(updateStatus(t))}>{t('help.check_for_updates')}</button>
          <p role="status">{checked ?? ''}</p></>}
      </article>
    </div>
  </Dialog>;
}
