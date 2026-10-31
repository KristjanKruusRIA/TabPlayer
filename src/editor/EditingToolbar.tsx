import { useI18n } from '../i18n';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { model } from '@coderline/alphatab';
import type { BeatTarget, EditCommand } from '../project';
import type { IndexedNoteTarget, NoteTarget, NoteTechniques } from '../edit-types';
import { describeSelection } from '../engine';
import { nextLinkedNote } from './techniques';

type DurationSpec = readonly [duration: number, label: string, short: string, flags: number, filled: boolean, stem: boolean];

const DURATIONS: readonly DurationSpec[] = [
  [1, 'Whole note (1/1)', '1/1', 0, false, false],
  [2, 'Half note (1/2)', '1/2', 0, false, true],
  [4, 'Quarter note (1/4)', '1/4', 0, true, true],
  [8, 'Eighth note (1/8)', '1/8', 1, true, true],
  [16, 'Sixteenth note (1/16)', '1/16', 2, true, true],
  [32, 'Thirty-second note (1/32)', '1/32', 3, true, true],
  [64, 'Sixty-fourth note (1/64)', '1/64', 4, true, true],
];

function NoteGlyph({ filled, stem, flags }: { filled: boolean; stem: boolean; flags: number }) {
  return (
    <svg viewBox="0 0 18 18" width="15" height="15" aria-hidden="true" className="tp-glyph-svg">
      <ellipse
        cx={stem ? 7 : 9}
        cy={13}
        rx={3.4}
        ry={2.4}
        transform={`rotate(-20 ${stem ? 7 : 9} 13)`}
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.5"
      />
      {stem && <line x1="10" y1="12.5" x2="10" y2="2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />}
      {Array.from({ length: flags }, (_, i) => {
        const y = 2.5 + i * 2.3;
        return (
          <path
            key={i}
            d={`M10 ${y} C12.5 ${y + 0.6}, 14.2 ${y + 1.6}, 14.5 ${y + 3.1}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.35"
            strokeLinecap="round"
          />
        );
      })}
    </svg>
  );
}

function DotGlyph({ count }: { count: 1 | 2 }) {
  return (
    <svg viewBox="0 0 18 18" width="15" height="15" aria-hidden="true" className="tp-glyph-svg">
      <ellipse cx="6" cy="12" rx="2.8" ry="2" transform="rotate(-20 6 12)" fill="currentColor" />
      <line x1="8.5" y1="11.5" x2="8.5" y2="3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="12" cy="11.5" r="1.4" fill="currentColor" />
      {count === 2 && <circle cx="15.5" cy="11.5" r="1.4" fill="currentColor" />}
    </svg>
  );
}

function RestGlyph() {
  return (
    <svg viewBox="0 0 18 18" width="15" height="15" aria-hidden="true" className="tp-glyph-svg">
      <path
        d="M7 3 L11 6.5 L7.5 9.5 L11 13 C9.2 12.6, 7.6 13.8, 8.2 15.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TieGlyph() {
  return (
    <svg viewBox="0 0 18 18" width="15" height="15" aria-hidden="true" className="tp-glyph-svg">
      <circle cx="4.2" cy="11.5" r="2" fill="currentColor" />
      <circle cx="13.8" cy="11.5" r="2" fill="currentColor" />
      <path d="M4.5 8.5 Q9 4.2 13.5 8.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function EditingToolbar({
  score,
  target,
  string,
  fret,
  noteIndex,
  duration,
  dots,
  busy,
  locked,
  onDurationChange,
  onDotsChange,
  onEdit,
}: {

  score: model.Score;
  target: BeatTarget;
  string: number;
  fret: number;
  noteIndex: number | null;
  duration: number;
  dots: number;
  busy: boolean;
  locked: boolean;
  onDurationChange: (duration: number) => void;
  onDotsChange: (dots: number) => void;
  onEdit: (edit: EditCommand) => void;
}) {
  const { t } = useI18n();
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [focusIdx, setFocusIdx] = useState(0);
  const { staff, beat } = describeSelection(score, target);
  const indexed = staff.isPercussion || !staff.tuning.length;
  const stringed = !indexed;
  const note = indexed
    ? noteIndex === null
      ? undefined
      : beat?.notes[noteIndex]
    : beat?.notes.find(n => n.string === string);
  const editDisabled = busy || locked;

  const address = (current: model.Note): NoteTarget | IndexedNoteTarget => {
    const location = {
      track: target.track,
      staff: target.staff,
      voice: target.voice,
      bar: current.beat.voice.bar.index,
      beat: current.beat.index,
    };
    return indexed
      ? { target: location, noteIndex: current.beat.notes.indexOf(current) }
      : { target: location, string: current.string };
  };
  const destination = note ? nextLinkedNote(note) : null;
  const nextTarget = destination ? address(destination) : null;
  const canTie = Boolean(destination && note && destination.realValue === note.realValue);
  const hasSlide = (note?.slideOutType ?? 0) !== 0 || (note?.slideInType ?? 0) !== 0;

  const patchNote = (patch: NoteTechniques) => {
    if (editDisabled || !note) return;
    if (indexed) {
      if (noteIndex !== null) onEdit({ type: 'setNoteTechniquesByIndex', target, noteIndex, patch });
    } else {
      onEdit({ type: 'setNoteTechniques', target, string, patch });
    }
  };

  const toggleLink = (kind: 'tie' | 'hammerPull') => {
    if (editDisabled || !note) return;
    const isOrigin = kind === 'tie' ? note.isTieOrigin : note.isHammerPullOrigin;
    const origin = kind === 'tie' ? note.tieOrigin : note.hammerPullOrigin;
    if (isOrigin) {
      if (indexed) {
        if (noteIndex !== null) onEdit({ type: 'setNoteLinkByIndex', from: { target, noteIndex }, to: null, kind });
      } else {
        onEdit({ type: 'setNoteLink', from: { target, string }, to: null, kind });
      }
    } else if (origin) {
      const from = address(origin);
      if ('noteIndex' in from) onEdit({ type: 'setNoteLinkByIndex', from, to: null, kind });
      else onEdit({ type: 'setNoteLink', from, to: null, kind });
    } else if (nextTarget) {
      if (indexed) {
        if (noteIndex !== null)
          onEdit({ type: 'setNoteLinkByIndex', from: { target, noteIndex }, to: nextTarget as IndexedNoteTarget, kind });
      } else {
        onEdit({ type: 'setNoteLink', from: { target, string }, to: nextTarget as NoteTarget, kind });
      }
    }
  };

  const activeDuration = beat?.duration ?? duration;
  const activeDots = beat?.dots ?? dots;

  useEffect(() => {
    if (!toolbarRef.current || busy) return;
    const allButtons = Array.from(toolbarRef.current.querySelectorAll<HTMLButtonElement>('button.tp-glyph-btn'));
    if (!allButtons.length) return;
    const current = allButtons[focusIdx];
    if (current?.disabled) {
      const firstEnabled = allButtons.findIndex(b => !b.disabled);
      if (firstEnabled >= 0) {
        setFocusIdx(firstEnabled);
      }
    }
  }, [score, target, string, fret, noteIndex, duration, dots, busy, locked, focusIdx]);

  const onToolbarKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
    const buttons = Array.from(
      toolbarRef.current?.querySelectorAll<HTMLButtonElement>(
        'button.tp-glyph-btn:not(:disabled):not([aria-disabled="true"])',
      ) ?? [],
    );
    if (!buttons.length) return;
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next = current >= 0 ? current : 0;
    if (event.key === 'ArrowRight') next = (next + 1) % buttons.length;
    else if (event.key === 'ArrowLeft') next = (next - 1 + buttons.length) % buttons.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = buttons.length - 1;
    const targetBtn = buttons[next];
    if (targetBtn) {
      const allButtons = Array.from(toolbarRef.current?.querySelectorAll<HTMLButtonElement>('button.tp-glyph-btn') ?? []);
      const allIndex = allButtons.indexOf(targetBtn);
      if (allIndex >= 0) setFocusIdx(allIndex);
      targetBtn.focus();
    }
  };

  let btnCounter = 0;
  const glyphButton = (opts: {
    key: string;
    label: string;
    pressed: boolean;
    disabled: boolean;
    onClick: () => void;
    children: ReactNode;
    badge?: string;
  }) => {
    const index = btnCounter++;
    const isDisabled = opts.disabled && !busy;
    const isAriaDisabled = opts.disabled || busy;
    return (
      <button
        key={opts.key}
        type="button"
        className="tp-glyph-btn"
        aria-label={opts.label}
        aria-pressed={opts.pressed}
        disabled={isDisabled}
        aria-disabled={isAriaDisabled ? 'true' : undefined}
        tabIndex={index === focusIdx ? 0 : -1}
        onFocus={() => setFocusIdx(index)}
        onClick={() => {
          if (busy || opts.disabled) return;
          opts.onClick();
        }}
        title={opts.label}
      >
        {opts.children}
        {opts.badge && <span className="tp-glyph-badge" aria-hidden="true">{opts.badge}</span>}
      </button>
    );
  };

  return (
    <div
      ref={toolbarRef}
      role="toolbar"
      aria-label={t('toolbar.editing_toolbar')}
      className="tp-editing-toolbar"
      onKeyDown={onToolbarKeyDown}
    >
      <div className="tp-toolbar-group" role="group" aria-label={t('toolbar.durations')}>
        {DURATIONS.map(([d, label, short, flags, filled, stem]) =>
          glyphButton({
            key: `dur-${d}`,
            label,
            pressed: activeDuration === d,
            disabled: editDisabled,
            badge: short,
            onClick: () => {
              onDurationChange(d);
              if (beat && !editDisabled) {
                if (beat.duration === d) return;
                onEdit({ type: 'setDuration', target, duration: d, dots: beat.dots ?? dots });
              }
            },
            children: <NoteGlyph filled={filled} stem={stem} flags={flags} />,
          }),
        )}
      </div>

      <div className="tp-toolbar-group" role="group" aria-label={t('toolbar.dots_rest_tie')}>
        {glyphButton({
          key: 'dot-1',
          label: t('toolbar.dotted'),
          pressed: activeDots === 1,
          disabled: editDisabled,
          badge: '·',
          onClick: () => {
            const next = activeDots === 1 ? 0 : 1;
            onDotsChange(next);
            if (beat && !editDisabled) {
              onEdit({ type: 'setDuration', target, duration: beat.duration ?? duration, dots: next });
            }
          },
          children: <DotGlyph count={1} />,
        })}
        {glyphButton({
          key: 'dot-2',
          label: t('toolbar.double_dotted'),
          pressed: activeDots === 2,
          disabled: editDisabled,
          badge: '··',
          onClick: () => {
            const next = activeDots === 2 ? 0 : 2;
            onDotsChange(next);
            if (beat && !editDisabled) {
              onEdit({ type: 'setDuration', target, duration: beat.duration ?? duration, dots: next });
            }
          },
          children: <DotGlyph count={2} />,
        })}
        {glyphButton({
          key: 'rest',
          label: t('toolbar.toggle_rest'),
          pressed: Boolean(beat?.isRest),
          disabled: editDisabled || !beat || (Boolean(beat?.isRest) && !stringed),
          badge: 'R',
          onClick: () => {
            if (!beat || editDisabled) return;
            if (beat.isRest) {
              if (stringed) {
                onEdit({ type: 'setNote', target, string, fret });
              }
              return;
            }
            onEdit({ type: 'setRest', target });
          },
          children: <RestGlyph />,
        })}
        {glyphButton({
          key: 'tie',
          label: t('toolbar.toggle_tie'),
          pressed: Boolean(note?.isTieOrigin || note?.isTieDestination),
          disabled: editDisabled || !note || (!note.isTieOrigin && !note.isTieDestination && !canTie),
          badge: 'Tie',
          onClick: () => toggleLink('tie'),
          children: <TieGlyph />,
        })}
      </div>

      <div className="tp-toolbar-group" role="group" aria-label={t('toolbar.common_techniques')}>
        {glyphButton({
          key: 'hp',
          label: t('toolbar.toggle_hp'),
          pressed: Boolean(note?.isHammerPullOrigin || note?.isHammerPullDestination),
          disabled:
            editDisabled ||
            !note ||
            !stringed ||
            (!note.isHammerPullOrigin && !note.isHammerPullDestination && !nextTarget),
          badge: 'H/P',
          onClick: () => toggleLink('hammerPull'),
          children: (
            <svg viewBox="0 0 18 18" width="15" height="15" aria-hidden="true" className="tp-glyph-svg">
              <path d="M3 12 Q9 4 15 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <circle cx="3.5" cy="13" r="1.6" fill="currentColor" />
              <circle cx="14.5" cy="13" r="1.6" fill="currentColor" />
            </svg>
          ),
        })}
        {glyphButton({
          key: 'slide',
          label: t('toolbar.toggle_slide'),
          pressed: hasSlide,
          disabled: editDisabled || !note || !stringed || (!hasSlide && !destination),
          badge: 'Sl',
          onClick: () => {
            const active = (note?.slideOutType ?? 0) !== 0 || (note?.slideInType ?? 0) !== 0;
            patchNote(active ? { slideOut: 0, slideIn: 0 } : { slideOut: model.SlideOutType.Shift });
          },
          children: (
            <svg viewBox="0 0 18 18" width="15" height="15" aria-hidden="true" className="tp-glyph-svg">
              <line x1="3.5" y1="13.5" x2="14.5" y2="4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              <circle cx="3.5" cy="13.5" r="1.6" fill="currentColor" />
              <circle cx="14.5" cy="4.5" r="1.6" fill="currentColor" />
            </svg>
          ),
        })}
        {glyphButton({
          key: 'bend',
          label: t('toolbar.toggle_bend'),
          pressed: (note?.bendType ?? 0) !== 0,
          disabled: editDisabled || !note || !stringed,
          badge: 'B',
          onClick: () => {
            const active = (note?.bendType ?? 0) !== 0;
            patchNote({
              bend: active
                ? null
                : {
                    type: 1,
                    style: 0,
                    points: [
                      { offset: 0, value: 0 },
                      { offset: 60, value: 4 },
                    ],
                  },
            });
          },
          children: (
            <svg viewBox="0 0 18 18" width="15" height="15" aria-hidden="true" className="tp-glyph-svg">
              <path d="M4 14 Q12 14 13 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              <polyline
                points="10,6.5 13,3.5 15.5,6.8"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ),
        })}
        {glyphButton({
          key: 'vibrato',
          label: t('toolbar.toggle_vibrato'),
          pressed: (note?.vibrato ?? 0) !== 0,
          disabled: editDisabled || !note || staff.isPercussion,
          badge: 'Vib',
          onClick: () => {
            const active = (note?.vibrato ?? 0) !== 0;
            patchNote({ vibrato: active ? 0 : model.VibratoType.Slight });
          },
          children: (
            <svg viewBox="0 0 18 18" width="15" height="15" aria-hidden="true" className="tp-glyph-svg">
              <polyline
                points="1.5,9 4,6 6.5,12 9,6 11.5,12 14,6 16.5,9"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ),
        })}
        {glyphButton({
          key: 'pm',
          label: t('toolbar.toggle_pm'),
          pressed: Boolean(note?.isPalmMute),
          disabled: editDisabled || !note || !stringed,
          badge: 'PM',
          onClick: () => patchNote({ palmMute: !note?.isPalmMute }),
          children: (
            <svg viewBox="0 0 18 18" width="15" height="15" aria-hidden="true" className="tp-glyph-svg">
              <path d="M2.5 6 H15.5 V11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              <line x1="3" y1="12" x2="11" y2="12" stroke="currentColor" strokeWidth="1.4" strokeDasharray="2 2" />
            </svg>
          ),
        })}
        {glyphButton({
          key: 'lr',
          label: t('toolbar.toggle_lr'),
          pressed: Boolean(note?.isLetRing),
          disabled: editDisabled || !note || !stringed,
          badge: 'LR',
          onClick: () => patchNote({ letRing: !note?.isLetRing }),
          children: (
            <svg viewBox="0 0 18 18" width="15" height="15" aria-hidden="true" className="tp-glyph-svg">
              <circle cx="6" cy="9" r="2.2" fill="currentColor" />
              <path d="M10 6.5 A4 4 0 0 1 10 11.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              <path d="M12.8 4.5 A7 7 0 0 1 12.8 13.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          ),
        })}
        {glyphButton({
          key: 'dead',
          label: t('toolbar.toggle_dead'),
          pressed: Boolean(note?.isDead),
          disabled: editDisabled || !note || !stringed,
          badge: '×',
          onClick: () => patchNote({ dead: !note?.isDead }),
          children: (
            <svg viewBox="0 0 18 18" width="15" height="15" aria-hidden="true" className="tp-glyph-svg">
              <line x1="4.5" y1="4.5" x2="13.5" y2="13.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              <line x1="13.5" y1="4.5" x2="4.5" y2="13.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
          ),
        })}
        {glyphButton({
          key: 'ghost',
          label: t('toolbar.toggle_ghost'),
          pressed: Boolean(note?.isGhost),
          disabled: editDisabled || !note,
          badge: '(n)',
          onClick: () => patchNote({ ghost: !note?.isGhost }),
          children: (
            <svg viewBox="0 0 18 18" width="15" height="15" aria-hidden="true" className="tp-glyph-svg">
              <path d="M5 4.5 C2.5 7, 2.5 11, 5 13.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              <circle cx="9" cy="9" r="2.3" fill="currentColor" />
              <path d="M13 4.5 C15.5 7, 15.5 11, 13 13.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          ),
        })}
        {glyphButton({
          key: 'staccato',
          label: t('toolbar.toggle_staccato'),
          pressed: Boolean(note?.isStaccato),
          disabled: editDisabled || !note,
          badge: 'St',
          onClick: () => patchNote({ staccato: !note?.isStaccato }),
          children: (
            <svg viewBox="0 0 18 18" width="15" height="15" aria-hidden="true" className="tp-glyph-svg">
              <ellipse cx="9" cy="11.5" rx="3.2" ry="2.2" transform="rotate(-20 9 11.5)" fill="currentColor" />
              <circle cx="9" cy="4.5" r="1.6" fill="currentColor" />
            </svg>
          ),
        })}
        {glyphButton({
          key: 'harmonic',
          label: t('toolbar.toggle_harmonic'),
          pressed: (note?.harmonicType ?? 0) !== 0,
          disabled: editDisabled || !note || !stringed,
          badge: 'Harm',
          onClick: () => {
            const active = (note?.harmonicType ?? 0) !== 0;
            patchNote({ harmonic: active ? null : { type: model.HarmonicType.Natural, value: 12 } });
          },
          children: (
            <svg viewBox="0 0 18 18" width="15" height="15" aria-hidden="true" className="tp-glyph-svg">
              <polygon
                points="9,3.5 14,9 9,14.5 4,9"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
            </svg>
          ),
        })}
        {glyphButton({
          key: 'accent',
          label: t('toolbar.toggle_accent'),
          pressed: (note?.accentuated ?? 0) !== 0,
          disabled: editDisabled || !note,
          badge: '>',
          onClick: () => {
            const active = (note?.accentuated ?? 0) !== 0;
            patchNote({ accent: active ? 0 : model.AccentuationType.Normal });
          },
          children: (
            <svg viewBox="0 0 18 18" width="15" height="15" aria-hidden="true" className="tp-glyph-svg">
              <polyline
                points="4,5.5 14,9 4,12.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ),
        })}
      </div>
    </div>
  );
}
