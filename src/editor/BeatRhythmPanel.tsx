import { useEffect, useState } from 'react';
import { model } from '@coderline/alphatab';
import { useI18n } from '../i18n';
import type { BeatTarget } from '../project';
import type { EditCommand } from '../edit-types';
import { describeSelection } from '../engine';
import { EnumInput } from './controls';
import { BusyFieldset } from '../ui/BusyFieldset';
import { busyGuard } from '../ui/useBusyGuard';

/**
 * The rhythm of one beat that the palette's duration, dot and tuplet buttons cannot say: a tuplet of any ratio and the
 * grace type. The duration and dots stay the beat's own. Applying the values the beat already has records nothing.
 */
export function BeatRhythmPanel({ score, target, busy, onEdit }: { score: model.Score; target: BeatTarget; busy: boolean; onEdit: (command: EditCommand) => void | Promise<boolean> }) {
  const { t } = useI18n();
  const { beat } = describeSelection(score, target);
  const saved = { numerator: beat && beat.tupletNumerator > 0 ? beat.tupletNumerator : 1, denominator: beat && beat.tupletDenominator > 0 ? beat.tupletDenominator : 1, grace: beat?.graceType ?? 0 };
  const [numerator, setNumerator] = useState(saved.numerator);
  const [denominator, setDenominator] = useState(saved.denominator);
  const [grace, setGrace] = useState(saved.grace);
  useEffect(() => { setNumerator(saved.numerator); setDenominator(saved.denominator); setGrace(saved.grace); }, [score, beat, target.track, target.staff, target.voice, target.bar, target.beat, saved.numerator, saved.denominator, saved.grace]);
  const unchanged = numerator === saved.numerator && denominator === saved.denominator && grace === saved.grace;
  const apply = () => {
    if (!beat || unchanged) return;
    void onEdit({ type: 'setBeatRhythm', target, duration: beat.duration, dots: beat.dots, tupletNumerator: numerator, tupletDenominator: denominator, graceType: grace });
  };
  return <details className="editor-section" open><summary>{t('editor.advanced_rhythm')}</summary><BusyFieldset busy={busy} disabled={!beat}>
    <div className="pair">
      <label>{t('editor.tuplet_numerator')}<input type="number" min={1} value={numerator} onChange={event => setNumerator(Number(event.target.value))} /></label>
      <label>{t('editor.tuplet_denominator')}<input type="number" min={1} value={denominator} onChange={event => setDenominator(Number(event.target.value))} /></label>
    </div>
    <EnumInput label={t('editor.grace_type')} value={grace} enumeration={model.GraceType} onValue={setGrace} />
    <button type="button" {...busyGuard({ busy, unavailable: unchanged, onClick: apply })}>{t('editor.apply_rhythm')}</button>
  </BusyFieldset></details>;
}
