import { useEffect, useRef, useState } from 'react';
import type { ChordDefinition } from '../edit-types';

export function ChordDialog({
  strings,
  value,
  onChange,
  onClose,
  disabled = false,
}: {
  strings: number;
  value: ChordDefinition | null;
  onChange: (chord: ChordDefinition | null) => void;
  onClose: () => void;
  disabled?: boolean;
}) {
  const [name, setName] = useState(value?.name ?? '');
  const [firstFret, setFirstFret] = useState(value?.firstFret ?? 1);
  const [frets, setFrets] = useState(value?.frets ?? Array.from({ length: strings }, () => -1));
  const input = useRef<HTMLInputElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previousFocus.current = document.activeElement as HTMLElement;
    input.current?.focus();
    return () => previousFocus.current?.focus();
  }, []);

  const baseFret = Math.max(1, firstFret);
  const rows = [
    ...new Set([
      ...Array.from({ length: 5 }, (_, i) => baseFret + i),
      ...frets.filter(f => f > 0),
    ]),
  ].sort((a, b) => a - b);
  const width = Math.max(160, strings * 34 + 40);
  const nutY = 52;
  const rowStep = 26;
  const bottomY = nutY + rows.length * rowStep;
  const height = bottomY + 16;
  const firstX = 36;
  const lastX = firstX + Math.max(0, strings - 1) * 34;

  const setStringFret = (index: number, nextFret: number) => {
    if (disabled) return;
    setFrets(current => current.map((f, i) => (i === index ? nextFret : f)));
  };

  return (
    <div className="dialog-backdrop">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Chord diagram"
        className="chord-dialog"
        onKeyDown={e => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
          if (e.key === 'Tab') {
            const focusable = Array.from(
              e.currentTarget.querySelectorAll<HTMLElement>(
                'input:not(:disabled),button:not(:disabled),[role="button"][tabindex="0"]',
              ),
            );
            const first = focusable[0];
            const last = focusable.at(-1);
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last?.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <h2>Chord diagram</h2>
        <fieldset disabled={disabled}>
          <label>
            Chord name
            <input ref={input} value={name} onChange={e => setName(e.target.value)} />
          </label>
          <label>
            First fret
            <input type="number" min={0} value={firstFret} onChange={e => setFirstFret(Number(e.target.value))} />
          </label>

          {strings > 0 && (
            <svg
              role="group"
              aria-label="Chord diagram grid"
              viewBox={`0 0 ${width} ${height}`}
              className="tp-chord-diagram-svg"
            >
              <rect x="0" y="0" width={width} height={height} rx="6" className="tp-chord-bg" />
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
                className={baseFret <= 1 ? 'tp-chord-nut-bar' : 'tp-chord-fret-wire'}
              />
              {rows.map((fret, row) => {
                const wireY = nutY + (row + 1) * rowStep;
                const midY = nutY + row * rowStep + rowStep / 2;
                return (
                  <g key={fret} aria-hidden="true">
                    <line x1={firstX} x2={lastX} y1={wireY} y2={wireY} className="tp-chord-fret-wire" />
                    <text x={12} y={midY + 4} className="tp-chord-fret-num">
                      {fret}
                    </text>
                  </g>
                );
              })}
              {frets.map((current, index) => {
                const x = firstX + index * 34;
                return (
                  <g key={index}>
                    <line x1={x} x2={x} y1={nutY} y2={bottomY} className="tp-chord-string" />
                    {[-1, 0, ...rows].map(fret => {
                      const selected = current === fret;
                      const y = fret === -1 ? 22 : fret === 0 ? 38 : nutY + rows.indexOf(fret) * rowStep + rowStep / 2;
                      const posLabel =
                        fret === -1
                          ? `Diagram string ${index + 1} mute`
                          : fret === 0
                            ? `Diagram string ${index + 1} open`
                            : `Diagram string ${index + 1} fret ${fret}`;
                      return (
                        <g
                          key={fret}
                          role="button"
                          tabIndex={disabled ? -1 : 0}
                          aria-label={posLabel}
                          aria-pressed={selected}
                          className={`tp-chord-node${selected ? ' is-selected' : ''}${fret === -1 ? ' is-mute' : ''}`}
                          onClick={() => setStringFret(index, fret)}
                          onKeyDown={ev => {
                            if (ev.key === 'Enter' || ev.key === ' ') {
                              ev.preventDefault();
                              setStringFret(index, fret);
                            }
                          }}
                        >
                          <circle cx={x} cy={y} r={fret <= 0 ? 7.5 : 9.5} className="tp-chord-node-circle" />
                          {selected ? (
                            <text x={x} y={y + 3.5} textAnchor="middle" className="tp-chord-node-glyph">
                              {fret === -1 ? '×' : fret === 0 ? 'O' : '●'}
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
                  </g>
                );
              })}
            </svg>
          )}

          <p className="muted">High to low strings: -1 mute, 0 open, positive fret.</p>
          {frets.map((fret, index) => (
            <label key={index}>
              Diagram string {index + 1}
              <input
                type="number"
                min={-1}
                max={127}
                value={fret}
                onChange={e => setFrets(frets.map((f, i) => (i === index ? Number(e.target.value) : f)))}
              />
            </label>
          ))}
          <div className="pair">
            <button
              onClick={() => {
                onChange({ name, firstFret, frets });
                onClose();
              }}
            >
              Apply chord
            </button>
            <button
              onClick={() => {
                onChange(null);
                onClose();
              }}
            >
              Remove chord
            </button>
          </div>
        </fieldset>
        <button onClick={onClose}>Cancel</button>
      </section>
    </div>
  );
}
