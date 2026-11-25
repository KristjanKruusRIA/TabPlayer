import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useI18n, type MessageKey } from '../i18n';
import { Dialog } from '../ui/Dialog';
import './inspector-compact.css';

type Group = 'style' | 'layout' | 'page';
const groups: readonly Group[] = ['style', 'layout', 'page'];
const labels: Record<Group, MessageKey> = { style: 'score_style.group_style', layout: 'score_style.group_layout', page: 'score_style.group_page' };

/**
 * Everything that decides how the score looks, in one dialog: engraving, typography and saved styles; the spacing and
 * grouping of bars, systems and staves; the page and the default view. Each control keeps the apply rule it had in the
 * inspector (its own Apply, Reset or Save button, or a change that applies at once); opening or closing the dialog records nothing.
 */
export function ScoreStyleDialog({ style, layout, page, onClose }: { style: ReactNode; layout: ReactNode; page: ReactNode; onClose: () => void }) {
  const { t } = useI18n();
  const [group, setGroup] = useState<Group>('style');
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = groups[(groups.indexOf(group) + step + groups.length) % groups.length];
    setGroup(next);
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`.score-style-dialog [data-style-group="${next}"]`)?.focus());
  };
  // On the document body, not inside the inspector: the inspector hides itself at short window heights, and a dialog inside it would go with it while the app stays inert.
  return createPortal(<Dialog title={t('score_style.title')} className="score-style-dialog" onClose={onClose} dismissOnBackdrop>
    <div className="properties-tabs" role="tablist" aria-label={t('score_style.groups')} onKeyDown={keys}>
      {groups.map(item => <button key={item} type="button" role="tab" data-style-group={item} data-autofocus={group===item||undefined} aria-selected={group === item} tabIndex={group === item ? 0 : -1} aria-controls="score-style-panel" onClick={() => setGroup(item)}>{t(labels[item])}</button>)}
    </div>
    <div className="properties-body" id="score-style-panel" role="tabpanel">
      {/* Each group stays mounted, so a half-typed value survives a look at another group. */}
      <div hidden={group !== 'style'}>{style}</div>
      <div hidden={group !== 'layout'}>{layout}</div>
      <div hidden={group !== 'page'}>{page}</div>
    </div>
  </Dialog>, document.body);
}
