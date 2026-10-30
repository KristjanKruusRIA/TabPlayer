import { useRef, useState, type KeyboardEvent } from 'react';
import { model } from '@coderline/alphatab';
import { describePartialCapo, getPartialCapo } from '../editor/partial-capo';
import type { ChordDiagramPreviewProps, HarmonyChord } from '../editor/harmony-types';

const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const harmonyPitchName = (pitch: number) => `${noteNames[((pitch % 12) + 12) % 12]}${Math.floor(pitch / 12) - 1}`;

export function soundingChordPitches(chord: HarmonyChord, staff: model.Staff): Array<number | null> {
  const bar = new model.Bar();
  const voice = new model.Voice();
  const beat = new model.Beat();
  const note = new model.Note();
  bar.staff = staff;
  voice.bar = bar;
  beat.voice = voice;
  note.beat = beat;
  return chord.frets.map((fret, index) => {
    if (fret < 0 || staff.isPercussion || staff.tuning.length !== chord.frets.length) return null;
    note.string = chord.frets.length - index;
    note.fret = fret;
    const pitch = note.realValue;
    return Number.isInteger(pitch) && pitch >= 0 && pitch <= 127 ? pitch : null;
  });
}

export function ChordDiagramPreview({ chord, staff, highlightRoot, onToggle }: ChordDiagramPreviewProps) {
  if (chord.frets.length === 0) return <p className="muted">Name-only chord; no strings.</p>;
  const svgRef = useRef<SVGSVGElement>(null);
  const pitches = soundingChordPitches(chord, staff);
  const first = Math.max(1, chord.firstFret);
  const rows = [
    ...new Set([
      ...Array.from({ length: Math.min(5, 128 - first) }, (_, i) => first + i),
      ...chord.frets.filter(fret => fret > 0),
    ]),
  ].sort((a, b) => a - b);
  const allFrets = [-1, 0, ...rows];
  const [focusedString, setFocusedString] = useState(0);
  const [focusedFret, setFocusedFret] = useState<number | null>(null);
  const activeFret =
    focusedFret ?? (allFrets.includes(chord.frets[focusedString]) ? chord.frets[focusedString] : allFrets[0]);

  const navigate = (s: number, f: number) => {
    setFocusedString(s);
    setFocusedFret(f);
    const target = svgRef.current?.querySelector<SVGElement>(`[data-string="${s}"][data-fret="${f}"]`);
    target?.focus();
  };

  const width = Math.max(160, chord.frets.length * 40 + 44);
  const nutY = 58;
  const rowStep = 30;
  const bottomY = nutY + rows.length * rowStep;
  const height = bottomY + 28;
  const root = chord.recipe ? ([0, 2, 4, 5, 7, 9, 11][chord.recipe.root.step] + chord.recipe.root.alteration + 12) % 12 : null;

  const label = (index: number, fret: number) => {
    if (fret < 0) return `String ${index + 1} muted`;
    const candidate = { ...chord, frets: chord.frets.map((value, i) => (i === index ? fret : value)) };
    const pitch = soundingChordPitches(candidate, staff)[index];
    return `String ${index + 1} ${fret === 0 ? 'open' : `fret ${fret}`}: ${pitch === null ? 'unavailable' : harmonyPitchName(pitch)}${highlightRoot && pitch !== null && pitch % 12 === root ? ', root' : ''}`;
  };

  const firstX = 42;
  const lastX = 42 + (chord.frets.length - 1) * 40;

  return (
    <span className="harmony-diagram">
      <svg
        ref={svgRef}
        role="group"
        aria-label="Chord diagram preview"
        viewBox={`0 0 ${width} ${height}`}
        className="tp-chord-diagram-svg"
      >
        <rect x="0" y="0" width={width} height={height} rx="6" className="tp-chord-bg" />
        <text x={10} y={16} className="tp-chord-header-label">
          First fret {chord.firstFret}
        </text>
        {chord.name && (
          <text x={width - 10} y={16} textAnchor="end" className="tp-chord-title-label">
            {chord.name}
          </text>
        )}

        <rect
          x={firstX}
          y={nutY}
          width={Math.max(0, lastX - firstX)}
          height={Math.max(0, bottomY - nutY)}
          className="tp-chord-fretboard"
        />

        <line
          x1={firstX - 2}
          x2={lastX + 2}
          y1={nutY}
          y2={nutY}
          className={first <= 1 ? 'tp-chord-nut-bar' : 'tp-chord-fret-wire'}
        />

        {rows.map((fret, row) => {
          const wireY = nutY + (row + 1) * rowStep;
          const midY = nutY + row * rowStep + rowStep / 2;
          return (
            <g key={fret}>
              <line x1={firstX} x2={lastX} y1={wireY} y2={wireY} className="tp-chord-fret-wire" />
              <text x={12} y={midY + 4} className="tp-chord-fret-num">
                {fret}
              </text>
            </g>
          );
        })}

        {chord.barreFrets.map((fret, index) => {
          const positions = chord.frets.flatMap((value, i) => (value >= fret ? [i] : []));
          const row = rows.indexOf(fret);
          if (row < 0 || positions.length < 2) return null;
          const y = nutY + row * rowStep + rowStep / 2;
          return (
            <line
              key={index}
              x1={firstX + positions[0] * 40}
              x2={firstX + positions.at(-1)! * 40}
              y1={y}
              y2={y}
              className="tp-chord-barre"
            />
          );
        })}

        {chord.frets.map((current, index) => {
          const x = firstX + index * 40;
          const gauge = 1 + (index / Math.max(1, chord.frets.length - 1)) * 1.1;
          return (
            <g key={index}>
              <line x1={x} x2={x} y1={nutY} y2={bottomY} className="tp-chord-string" strokeWidth={gauge} />
              {allFrets.map(fret => {
                const selected = current === fret;
                if (!selected && !onToggle) return null;
                const isFocusedNode = index === focusedString && fret === activeFret;
                const y = fret === -1 ? 28 : fret === 0 ? 44 : nutY + rows.indexOf(fret) * rowStep + rowStep / 2;
                const pitch = selected && fret >= 0 ? pitches[index] : null;
                const isRoot = Boolean(highlightRoot && pitch !== null && pitch % 12 === root);
                const r = fret <= 0 ? 8.5 : 11;
                return (
                  <g
                    key={fret}
                    role={onToggle ? 'button' : undefined}
                    tabIndex={onToggle ? (isFocusedNode ? 0 : -1) : undefined}
                    aria-pressed={onToggle ? (selected ? 'true' : 'false') : undefined}
                    aria-label={label(index, fret)}
                    data-string={index}
                    data-fret={fret}
                    className={`tp-chord-node${selected ? ' is-selected' : ''}${isRoot ? ' is-root' : ''}${fret === -1 ? ' is-mute' : ''}${fret === 0 ? ' is-open' : ''}`}
                    onClick={onToggle ? () => onToggle(index, fret) : undefined}
                    onFocus={onToggle ? () => { setFocusedString(index); setFocusedFret(fret); } : undefined}
                    onKeyDown={
                      onToggle
                        ? (event: KeyboardEvent<SVGElement>) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              onToggle(index, fret);
                            } else if (event.key === 'ArrowLeft') {
                              event.preventDefault();
                              navigate(Math.max(0, index - 1), fret);
                            } else if (event.key === 'ArrowRight') {
                              event.preventDefault();
                              navigate(Math.min(chord.frets.length - 1, index + 1), fret);
                            } else if (event.key === 'ArrowUp') {
                              event.preventDefault();
                              const fretIdx = allFrets.indexOf(fret);
                              navigate(index, allFrets[Math.max(0, fretIdx - 1)]);
                            } else if (event.key === 'ArrowDown') {
                              event.preventDefault();
                              const fretIdx = allFrets.indexOf(fret);
                              navigate(index, allFrets[Math.min(allFrets.length - 1, fretIdx + 1)]);
                            } else if (event.key === 'Home') {
                              event.preventDefault();
                              navigate(0, fret);
                            } else if (event.key === 'End') {
                              event.preventDefault();
                              navigate(chord.frets.length - 1, fret);
                            }
                          }
                        : undefined
                    }
                  >
                    <circle cx={x} cy={y} r={r} className="tp-chord-node-circle" />
                    {selected ? (
                      <text x={x} y={y + 3.5} textAnchor="middle" className="tp-chord-node-glyph">
                        {fret === -1
                          ? '×'
                          : chord.showFingering && chord.fingers[index] >= 0
                            ? chord.fingers[index] === 0
                              ? 'T'
                              : chord.fingers[index]
                            : fret === 0
                              ? 'O'
                              : '●'}
                      </text>
                    ) : (
                      fret <= 0 && (
                        <text x={x} y={y + 3} textAnchor="middle" className="tp-chord-node-hint" aria-hidden="true">
                          {fret === -1 ? '×' : 'O'}
                        </text>
                      )
                    )}
                  </g>
                );
              })}
              <text x={x} y={height - 8} textAnchor="middle" className="tp-chord-pitch-label">
                {pitches[index] === null ? '×' : harmonyPitchName(pitches[index])}
              </text>
            </g>
          );
        })}
      </svg>
      <span className="harmony-diagram-caption muted">
        Sounding pitches · capo {staff.capo}
        {describePartialCapo(getPartialCapo(staff)) ? ` · ${describePartialCapo(getPartialCapo(staff)).toLowerCase()}` : ''} ·
        sounding offset {staff.transpositionPitch}. Strings run high to low in diagram order.
        {!chord.showDiagram ? ' Diagram hidden in score.' : ''}
      </span>
    </span>
  );
}
