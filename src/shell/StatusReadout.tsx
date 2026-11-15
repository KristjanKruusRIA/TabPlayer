import type { model } from '@coderline/alphatab';
import { useI18n, type MessageKey } from '../i18n';
import type { BeatTarget } from '../project';
import { describeSelection } from '../engine';
import { formatPitch } from '../tuning';
import { durationLabel } from '../editor/common';
import { displayedBpm, shownBpm, quarterUnit, tempoUnitKeys, tempoUnitOf } from '../editor/tempo-unit';
import type { MusicSelection } from '../editor/range-types';
import { rangeExtent } from '../editor/range-edge';
import { rangeCutsBeat } from '../editor/clipboard-subdivide';

/** The short names of the techniques a note carries, in the order the old inspector's context card listed them. */
function techniques(note: model.Note | undefined): MessageKey[] {
  if (!note) return [];
  const names: MessageKey[] = [];
  if ((note.bendType ?? 0) !== 0) names.push('status.tech_bend');
  if ((note.slideOutType ?? 0) !== 0 || (note.slideInType ?? 0) !== 0) names.push('status.tech_slide');
  if ((note.vibrato ?? 0) !== 0) names.push('status.tech_vibrato');
  if (note.isHammerPullOrigin || note.isHammerPullDestination) names.push('status.tech_hammer_pull');
  if (note.isTieOrigin || note.isTieDestination) names.push('status.tech_tie');
  if (note.isPalmMute) names.push('status.tech_palm_mute');
  if (note.isLetRing) names.push('status.tech_let_ring');
  if ((note.harmonicType ?? 0) !== 0) names.push('status.tech_harmonic');
  if (note.isDead) names.push('status.tech_dead');
  if (note.isGhost) names.push('status.tech_ghost');
  if (note.isStaccato) names.push('status.tech_staccato');
  if (note.isTrill) names.push('status.tech_trill');
  return names;
}

/**
 * The cursor's place and what is under it, for the status bar: the track and staff, the bar, beat, string and voice, then the
 * note's fret and pitch (or the rest, or the selected range), its techniques, the time signature, tempo and chord. This
 * replaces the context card the inspector's Selection tab used to show.
 */
export function StatusReadout({ score, target, string, noteIndex, selection, indexed }: {
  score: model.Score;
  target: BeatTarget;
  string: number;
  noteIndex: number | null;
  selection: MusicSelection | null;
  indexed: boolean;
}) {
  const { t } = useI18n();
  const { staff, master, beat } = describeSelection(score, target);
  const note = indexed ? (noteIndex === null ? undefined : beat?.notes[noteIndex]) : beat?.notes.find(candidate => candidate.string === string);
  const track = score.tracks[target.track];
  const opening = score.masterBars[0].tempoAutomations.find(automation => automation.ratioPosition === 0);
  const tempo = opening && tempoUnitOf(opening) !== quarterUnit
    ? t('editor.context_tempo_unit', { bpm: shownBpm(displayedBpm(opening)), unit: t(tempoUnitKeys[tempoUnitOf(opening)]) })
    : `${score.tempo} BPM`;
  const value = selection
    ? selection.kind === 'range'
      ? rangeCutsBeat(score, selection.range)
        ? t('editor.range_extent', rangeExtent(score, selection.range))
        : t('status.selection_bars', { first: selection.range.start.bar + 1, last: selection.range.end.bar + 1 })
      : selection.kind === 'bars'
        ? t('status.selection_bars', { first: selection.firstBar + 1, last: selection.lastBar + 1 })
        : t(selection.notes.length === 1 ? 'status.selection_notes_one' : 'status.selection_notes_other', { count: selection.notes.length })
    : note
      ? indexed
        ? staff.isPercussion ? t('status.note_selected') : t('status.note_pitch', { pitch: formatPitch(note.realValue) })
        : t('status.note_fret', { fret: note.fret, pitch: formatPitch(note.realValue) })
      : beat?.isRest
        ? t('status.rest', { duration: `${durationLabel(beat.duration)}${beat.dots ? '.'.repeat(beat.dots) : ''}` })
        : t(indexed ? 'status.no_note' : 'status.no_note_string');
  const meta = [`${master.timeSignatureNumerator}/${master.timeSignatureDenominator}`, tempo, ...(beat?.chord?.name ? [t('editor.context_chord', { name: beat.chord.name })] : [])].join(' · ');
  const tags = techniques(note).map(key => t(key));
  return <>
    <span className="statusbar-track" title={t('status.track_title')}>{track.name || t('track_display.track_fallback', { index: target.track + 1 })}{track.staves.length > 1 ? ` · ${t('editor.staff_n', { staff: target.staff + 1 })}` : ''}</span>
    <span className="score-hint statusbar-position" title={indexed ? t('status.hint_note') : t('status.hint_score')}>{indexed
      ? t('status.position_note', { bar: target.bar + 1, beat: target.beat + 1, note: noteIndex === null ? '–' : noteIndex + 1, voice: target.voice + 1 })
      : t('status.position', { bar: target.bar + 1, beat: target.beat + 1, string, voice: target.voice + 1 })}</span>
    <span className="statusbar-value" data-testid="status-value">{value}{tags.length > 0 && <span className="statusbar-tags" aria-label={t('status.techniques')}> · {tags.join(', ')}</span>}</span>
    <span className="statusbar-meta" data-testid="status-meta">{meta}</span>
  </>;
}
