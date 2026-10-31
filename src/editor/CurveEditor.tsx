import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { model } from '@coderline/alphatab';
import type { PitchCurve } from '../edit-types';
import { EnumInput } from './controls';
import { BusyFieldset } from '../ui/BusyFieldset';
import { busyGuard } from '../ui/useBusyGuard';

type PitchPoint = PitchCurve['points'][number];

type CurvePreset = {
  id: string;
  name: string;
  type: number;
  points: PitchPoint[];
  svgPath: string;
};

export const BEND_PRESETS: readonly CurvePreset[] = [
  {
    id: 'bend',
    name: 'Bend',
    type: model.BendType.Bend,
    points: [
      { offset: 0, value: 0 },
      { offset: 60, value: 4 },
    ],
    svgPath: 'M2 12 Q10 12 16 3',
  },
  {
    id: 'bend-release',
    name: 'Bend & release',
    type: model.BendType.BendRelease,
    points: [
      { offset: 0, value: 0 },
      { offset: 30, value: 4 },
      { offset: 60, value: 0 },
    ],
    svgPath: 'M2 12 L9 3 L16 12',
  },
  {
    id: 'prebend',
    name: 'Pre-bend',
    type: model.BendType.Prebend,
    points: [
      { offset: 0, value: 4 },
      { offset: 60, value: 4 },
    ],
    svgPath: 'M2 4 L16 4',
  },
  {
    id: 'prebend-release',
    name: 'Pre-bend & release',
    type: model.BendType.PrebendRelease,
    points: [
      { offset: 0, value: 4 },
      { offset: 60, value: 0 },
    ],
    svgPath: 'M2 3 L16 12',
  },
];

export const WHAMMY_PRESETS: readonly CurvePreset[] = [
  {
    id: 'dip',
    name: 'Dip',
    type: model.WhammyType.Dip,
    points: [
      { offset: 0, value: 0 },
      { offset: 30, value: -4 },
      { offset: 60, value: 0 },
    ],
    svgPath: 'M2 4 L9 13 L16 4',
  },
  {
    id: 'dive',
    name: 'Dive',
    type: model.WhammyType.Dive,
    points: [
      { offset: 0, value: 0 },
      { offset: 60, value: -8 },
    ],
    svgPath: 'M2 3 Q10 4 16 13',
  },
  {
    id: 'predive-dive',
    name: 'Scoop',
    type: model.WhammyType.PrediveDive,
    points: [
      { offset: 0, value: -4 },
      { offset: 60, value: 0 },
    ],
    svgPath: 'M2 13 L16 4',
  },
  {
    id: 'hold',
    name: 'Hold',
    // Sent as Custom so alphaTab classifies it: Hold after a whammy, Predive on a lone beat.
    type: model.WhammyType.Custom,
    points: [
      { offset: 0, value: -4 },
      { offset: 60, value: -4 },
    ],
    svgPath: 'M2 11 L16 11',
  },
];

function areCurvesEqual(a: PitchCurve | null, b: PitchCurve | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.style !== b.style || a.points.length !== b.points.length) return false;
  return a.points.every((p, i) => p.offset === b.points[i].offset && p.value === b.points[i].value);
}

function isSameCurve(a: PitchCurve | null, b: PitchCurve | null): boolean {
  return areCurvesEqual(a, b) && a?.type === b?.type;
}

function matchingPresetType(points: PitchPoint[], whammy: boolean): number | null {
  const presets = whammy ? WHAMMY_PRESETS : BEND_PRESETS;
  const match = presets.find(
    preset =>
      preset.points.length === points.length &&
      preset.points.every((p, i) => p.offset === points[i].offset && p.value === points[i].value),
  );
  return match ? match.type : null;
}

function resolveCurveType(points: PitchPoint[], whammy: boolean): number {
  const matched = matchingPresetType(points, whammy);
  if (matched !== null) return matched;
  return whammy ? model.WhammyType.Custom : model.BendType.Custom;
}

const PLOT_LEFT = 32;
const PLOT_RIGHT = 224;
const PLOT_TOP = 12;
const PLOT_BOTTOM = 104;
const PLOT_WIDTH = PLOT_RIGHT - PLOT_LEFT;
const PLOT_HEIGHT = PLOT_BOTTOM - PLOT_TOP;

export function formatQuarterTones(q: number): string {
  if (q === 0) return '0';
  const sign = q < 0 ? '−' : '+';
  const abs = Math.abs(q);
  const whole = Math.floor(abs / 4);
  const rem = abs % 4;
  const frac = rem === 1 ? '¼' : rem === 2 ? '½' : rem === 3 ? '¾' : '';
  if (whole === 0) return `${sign}${frac} step`;
  return `${sign}${whole}${frac} step${whole > 1 || frac ? 's' : ''}`;
}

export function CurveEditor({
  label,
  value,
  onChange,
  disabled = false,
  whammy = false,
}: {
  label: string;
  value: PitchCurve | null;
  onChange: (curve: PitchCurve | null) => void;
  disabled?: boolean;
  whammy?: boolean;
}) {
  const [curve, setCurve] = useState<PitchCurve | null>(value);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<{ index: number; initial: PitchCurve; latest: PitchCurve } | null>(null);
  const pendingKeyCommitRef = useRef<{ initial: PitchCurve; latest: PitchCurve } | null>(null);

  useEffect(() => setCurve(value), [value]);

  const point = (index: number, key: 'offset' | 'value', nextVal: number) =>
    setCurve(current => {
      if (!current) return null;
      const nextPoints = current.points.map((p, i) => (i === index ? { ...p, [key]: nextVal } : p));
      return {
        ...current,
        points: nextPoints,
      };
    });

  const presets = whammy ? WHAMMY_PRESETS : BEND_PRESETS;
  const maxAbs = Math.max(
    12,
    ...(curve?.points.map(p => (Number.isFinite(p.value) ? Math.abs(p.value) : 0)) ?? [12]),
  );
  const minPitch = whammy ? -maxAbs : 0;
  const maxPitch = maxAbs;

  const toX = (offset: number) => PLOT_LEFT + (Math.max(0, Math.min(60, offset)) / 60) * PLOT_WIDTH;
  const toY = (val: number) =>
    PLOT_BOTTOM - ((Math.max(minPitch, Math.min(maxPitch, val)) - minPitch) / (maxPitch - minPitch)) * PLOT_HEIGHT;

  const fromPointer = (clientX: number, clientY: number): { offset: number; value: number } => {
    const svg = svgRef.current;
    if (!svg) return { offset: 30, value: 0 };
    let svgX: number;
    let svgY: number;
    const ctm = svg.getScreenCTM?.();
    if (ctm && svg.createSVGPoint) {
      const pt = svg.createSVGPoint();
      pt.x = clientX;
      pt.y = clientY;
      const transformed = pt.matrixTransform(ctm.inverse());
      svgX = transformed.x;
      svgY = transformed.y;
    } else if (ctm) {
      const inv = ctm.inverse();
      svgX = clientX * inv.a + clientY * inv.c + inv.e;
      svgY = clientX * inv.b + clientY * inv.d + inv.f;
    } else {
      const rect = svg.getBoundingClientRect();
      const width = rect.width || 240;
      const height = rect.height || 124;
      svgX = ((clientX - rect.left) / width) * 240;
      svgY = ((clientY - rect.top) / height) * 124;
    }
    const rawOffset = Math.round(((svgX - PLOT_LEFT) / PLOT_WIDTH) * 60);
    const offset = Math.max(0, Math.min(60, rawOffset));
    const ratio = 1 - (svgY - PLOT_TOP) / PLOT_HEIGHT;
    const rawValue = Math.round(minPitch + ratio * (maxPitch - minPitch));
    const valueClamped = Math.max(minPitch, Math.min(maxPitch, rawValue));
    return { offset, value: valueClamped };
  };

  const updatePointGesture = (current: PitchCurve, index: number, nextOffset: number, nextValue: number): PitchCurve => {
    const last = current.points.length - 1;
    const minOffset = index === 0 ? 0 : index === last ? 60 : current.points[index - 1].offset + 1;
    const maxOffset = index === 0 ? 0 : index === last ? 60 : current.points[index + 1].offset - 1;
    const clampedOffset = Math.max(minOffset, Math.min(maxOffset, Math.round(nextOffset)));
    const clampedValue = Math.max(minPitch, Math.min(maxPitch, Math.round(nextValue)));
    const nextPoints = current.points.map((p, i) => (i === index ? { offset: clampedOffset, value: clampedValue } : p));
    return {
      ...current,
      points: nextPoints,
      type: resolveCurveType(nextPoints, whammy),
    };
  };

  const handlePointPointerDown = (index: number, event: ReactPointerEvent<SVGGElement>) => {
    if (disabled || !curve || event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = { index, initial: curve, latest: curve };
  };

  const handlePointPointerMove = (index: number, event: ReactPointerEvent<SVGGElement>) => {
    if (!dragRef.current || dragRef.current.index !== index || !curve || disabled) return;
    const coords = fromPointer(event.clientX, event.clientY);
    const updated = updatePointGesture(dragRef.current.latest, index, coords.offset, coords.value);
    dragRef.current = { ...dragRef.current, latest: updated };
    setCurve(updated);
  };

  const handlePointPointerUp = (index: number, event: ReactPointerEvent<SVGGElement>) => {
    if (!dragRef.current || dragRef.current.index !== index) return;
    const { initial, latest } = dragRef.current;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {}
    }
    if (disabled) {
      setCurve(initial);
      return;
    }
    setCurve(latest);
    if (!areCurvesEqual(latest, initial)) {
      onChange(latest);
    }
  };

  const handlePointPointerCancel = (index: number, event: ReactPointerEvent<SVGGElement>) => {
    if (!dragRef.current || dragRef.current.index !== index) return;
    const initial = dragRef.current.initial;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {}
    }
    setCurve(initial);
  };

  const handlePointKeyDown = (index: number, event: ReactKeyboardEvent<SVGGElement>) => {
    if (disabled || !curve) return;
    const currentPoint = curve.points[index];
    if (!currentPoint) return;
    const isInterior = index > 0 && index < curve.points.length - 1;
    if (event.key === 'Escape') {
      if (pendingKeyCommitRef.current) {
        event.preventDefault();
        const initial = pendingKeyCommitRef.current.initial;
        pendingKeyCommitRef.current = null;
        setCurve(initial);
      }
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && isInterior) {
      event.preventDefault();
      pendingKeyCommitRef.current = null;
      const nextPoints = curve.points.filter((_, i) => i !== index);
      const next: PitchCurve = {
        ...curve,
        points: nextPoints,
        type: resolveCurveType(nextPoints, whammy),
      };
      setCurve(next);
      onChange(next);
      return;
    }
    const pitchStep = event.shiftKey ? 2 : 1;
    const offsetStep = event.shiftKey ? 5 : 1;
    let nextOffset = currentPoint.offset;
    let nextValue = currentPoint.value;
    if (event.key === 'ArrowUp') nextValue += pitchStep;
    else if (event.key === 'ArrowDown') nextValue -= pitchStep;
    else if (event.key === 'ArrowRight' && isInterior) nextOffset += offsetStep;
    else if (event.key === 'ArrowLeft' && isInterior) nextOffset -= offsetStep;
    else return;

    event.preventDefault();
    const updated = updatePointGesture(curve, index, nextOffset, nextValue);
    if (areCurvesEqual(updated, curve)) return;

    if (!pendingKeyCommitRef.current) {
      pendingKeyCommitRef.current = { initial: curve, latest: updated };
    } else {
      pendingKeyCommitRef.current.latest = updated;
    }
    setCurve(updated);
  };

  const revertPendingKey = () => {
    const pending = pendingKeyCommitRef.current;
    pendingKeyCommitRef.current = null;
    if (pending) setCurve(pending.initial);
  };

  const handlePointKeyUp = (index: number, event: ReactKeyboardEvent<SVGGElement>) => {
    if (disabled) {
      revertPendingKey();
      return;
    }
    if (pendingKeyCommitRef.current) {
      const { initial, latest } = pendingKeyCommitRef.current;
      pendingKeyCommitRef.current = null;
      if (!areCurvesEqual(latest, initial)) {
        onChange(latest);
      }
    }
  };

  const handlePointBlur = () => {
    if (disabled) {
      revertPendingKey();
      return;
    }
    if (pendingKeyCommitRef.current) {
      const { initial, latest } = pendingKeyCommitRef.current;
      pendingKeyCommitRef.current = null;
      if (!areCurvesEqual(latest, initial)) {
        onChange(latest);
      }
    }
  };

  const handleSurfaceClick = (event: ReactPointerEvent<SVGRectElement>) => {
    if (disabled || !curve || event.button !== 0) return;
    const coords = fromPointer(event.clientX, event.clientY);
    const clampedOffset = Math.max(1, Math.min(59, coords.offset));
    const existingIdx = curve.points.findIndex(p => p.offset === clampedOffset);
    if (existingIdx >= 0 && curve.points[existingIdx].value === coords.value) {
      return;
    }
    let nextPoints: PitchPoint[];
    if (existingIdx >= 0) {
      nextPoints = curve.points.map((p, i) => (i === existingIdx ? { ...p, value: coords.value } : p));
    } else {
      nextPoints = [...curve.points, { offset: clampedOffset, value: coords.value }].sort((a, b) => a.offset - b.offset);
    }
    const nextCurve: PitchCurve = {
      ...curve,
      points: nextPoints,
      type: resolveCurveType(nextPoints, whammy),
    };
    setCurve(nextCurve);
    onChange(nextCurve);
  };

  const applyPreset = (preset: CurvePreset) => {
    if (disabled) return;
    if (
      curve !== null &&
      curve.points.length === preset.points.length &&
      curve.points.every((p, i) => p.offset === preset.points[i].offset && p.value === preset.points[i].value)
    ) {
      return;
    }
    const nextCurve: PitchCurve = {
      type: preset.type,
      style: curve?.style ?? 0,
      points: preset.points.map(p => ({ ...p })),
    };
    setCurve(nextCurve);
    onChange(nextCurve);
  };

  const validPoints = curve?.points.filter(p => Number.isFinite(p.offset) && Number.isFinite(p.value)) ?? [];
  const polylinePoints = validPoints.map(p => `${toX(p.offset)},${toY(p.value)}`).join(' ');
  const zeroY = toY(0);
  const areaPoints =
    validPoints.length >= 2
      ? `${toX(validPoints[0].offset)},${zeroY} ${polylinePoints} ${toX(validPoints[validPoints.length - 1].offset)},${zeroY}`
      : '';

  const gridValues = whammy ? [-12, -8, -4, 0, 4, 8, 12] : [0, 2, 4, 6, 8, 10, 12];

  return (
    <details className="curve-editor">
      <summary>{label} curve</summary>
      <BusyFieldset busy={disabled}>
        <label className="check">
          <input
            type="checkbox"
            checked={curve !== null}
            onChange={e =>
              setCurve(
                e.target.checked
                  ? {
                      type: 1,
                      style: 0,
                      points: [
                        { offset: 0, value: 0 },
                        { offset: 60, value: 0 },
                      ],
                    }
                  : null,
              )
            }
          />
          Enable {label}
        </label>
      </BusyFieldset>

      <div className="tp-curve-presets" role="group" aria-label={`${label} presets`}>
        {presets.map(preset => {
            const isCurrent =
              curve !== null &&
              curve.points.length === preset.points.length &&
              curve.points.every((p, i) => p.offset === preset.points[i].offset && p.value === preset.points[i].value);
            return (
              <button
                key={preset.id}
                type="button"
                aria-label={`${label} preset: ${preset.name}`}
                aria-pressed={isCurrent}
                {...busyGuard({ busy: disabled, className: 'tp-curve-preset-btn', onClick: () => applyPreset(preset) })}
              >
                <svg viewBox="0 0 18 16" width="16" height="14" aria-hidden="true">
                  <path
                    d={preset.svgPath}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span>{preset.name}</span>
              </button>
            );
          })}
        </div>

        {curve && (
          <>
            <BusyFieldset busy={disabled}>
              <div className="pair">
                <EnumInput
                  label={`${label} type`}
                  value={curve.type}
                  enumeration={whammy ? model.WhammyType : model.BendType}
                  onValue={type => setCurve({ ...curve, type })}
                />
                <EnumInput
                  label={`${label} style`}
                  value={curve.style}
                  enumeration={model.BendStyle}
                  onValue={style => setCurve({ ...curve, style })}
                />
              </div>
            </BusyFieldset>

            <svg
              ref={svgRef}
              viewBox="0 0 240 124"
              role="group"
              aria-label={`${label} pitch curve preview`}
              className="tp-curve-graph"
            >
              <rect
                x={PLOT_LEFT}
                y={PLOT_TOP}
                width={PLOT_WIDTH}
                height={PLOT_HEIGHT}
                rx="3"
                className="tp-curve-plot-bg"
                data-testid={`${label.toLowerCase()}-graph-surface`}
                onPointerDown={handleSurfaceClick}
              />

              {[0, 15, 30, 45, 60].map(offset => {
                const x = toX(offset);
                return (
                  <g key={`x-${offset}`} aria-hidden="true">
                    <line
                      x1={x}
                      y1={PLOT_TOP}
                      x2={x}
                      y2={PLOT_BOTTOM}
                      className="tp-curve-grid-line"
                      strokeDasharray={offset % 30 === 0 ? undefined : '2 2'}
                    />
                    <text x={x} y={118} textAnchor="middle" className="tp-curve-axis-label">
                      {offset === 0 ? '0' : offset === 15 ? '¼' : offset === 30 ? '½' : offset === 45 ? '¾' : '1'}
                    </text>
                  </g>
                );
              })}

              {gridValues.map(val => {
                const y = toY(val);
                const isZero = val === 0;
                const isWholeStep = val % 4 === 0;
                const stepText =
                  val === 0
                    ? '0'
                    : val === 2
                      ? '½'
                      : val === 6
                        ? '1½'
                        : val === 10
                          ? '2½'
                          : `${val > 0 && whammy ? '+' : ''}${val / 4}`;
                return (
                  <g key={`y-${val}`} aria-hidden="true">
                    <line
                      x1={PLOT_LEFT}
                      y1={y}
                      x2={PLOT_RIGHT}
                      y2={y}
                      className={isZero ? 'tp-curve-zero-line' : 'tp-curve-grid-line'}
                      strokeDasharray={isWholeStep ? undefined : '2 3'}
                    />
                    {(isWholeStep || (!whammy && val === 2)) && (
                      <text x={PLOT_LEFT - 5} y={y + 3} textAnchor="end" className="tp-curve-axis-label">
                        {stepText}
                      </text>
                    )}
                  </g>
                );
              })}

              {areaPoints && <polygon points={areaPoints} className="tp-curve-area" />}
              {polylinePoints && (
                <polyline fill="none" stroke="currentColor" strokeWidth="2.2" points={polylinePoints} className="tp-curve-line" />
              )}

              {curve.points.map((p, index) => {
                if (!Number.isFinite(p.offset) || !Number.isFinite(p.value)) return null;
                const cx = toX(p.offset);
                const cy = toY(p.value);
                return (
                  <g
                    key={index}
                    role="slider"
                    tabIndex={0}
                    aria-label={`${label} graph point ${index + 1}`}
                    aria-valuemin={minPitch}
                    aria-valuemax={maxPitch}
                    aria-valuenow={p.value}
                    aria-valuetext={`offset ${p.offset}, ${formatQuarterTones(p.value)}`}
                    aria-disabled={disabled ? 'true' : undefined}
                    className="tp-curve-handle"
                    onPointerDown={e => handlePointPointerDown(index, e)}
                    onPointerMove={e => handlePointPointerMove(index, e)}
                    onPointerUp={e => handlePointPointerUp(index, e)}
                    onPointerCancel={e => handlePointPointerCancel(index, e)}
                    onLostPointerCapture={e => handlePointPointerCancel(index, e)}
                    onKeyDown={e => handlePointKeyDown(index, e)}
                    onKeyUp={e => handlePointKeyUp(index, e)}
                    onBlur={handlePointBlur}
                  >
                    <circle cx={cx} cy={cy} r={8} className="tp-curve-handle-hit" />
                    <circle cx={cx} cy={cy} r={4.5} className="tp-curve-handle-dot" />
                  </g>
                );
              })}
            </svg>

            <BusyFieldset busy={disabled}>
              <p className="muted">
                Drag points or click the graph to shape pitch. Position 0–60; pitch in quarter tones
                {whammy ? ', including negative values' : ''}.
              </p>
              {curve.points.map((p, index) => (
                <div className="curve-point" key={index}>
                  <label>
                    Position
                    <input
                      aria-label={`${label} point ${index + 1} position`}
                      type="number"
                      min={0}
                      max={60}
                      value={p.offset}
                      disabled={index === 0 || index === curve.points.length - 1}
                      onChange={e => point(index, 'offset', Number(e.target.value))}
                    />
                  </label>
                  <label>
                    Pitch
                    <input
                      aria-label={`${label} point ${index + 1} value`}
                      type="number"
                      min={whammy ? undefined : 0}
                      step={1}
                      value={p.value}
                      onChange={e => point(index, 'value', Number(e.target.value))}
                    />
                  </label>
                  <button
                    aria-label={`Remove ${label} point ${index + 1}`}
                    disabled={index === 0 || index === curve.points.length - 1}
                    onClick={() => setCurve({ ...curve, points: curve.points.filter((_, i) => i !== index) })}
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                onClick={() => {
                  const last = curve.points.length - 1;
                  const offset = (curve.points[last - 1].offset + 60) / 2;
                  setCurve({
                    ...curve,
                    points: [
                      ...curve.points.slice(0, -1),
                      { offset, value: curve.points[last - 1].value },
                      curve.points[last],
                    ],
                  });
                }}
              >
                Add {label} point
              </button>
            </BusyFieldset>
          </>
        )}
        <BusyFieldset busy={disabled}>
          <button
            {...busyGuard({
              busy: disabled,
              onClick: () => {
                if (!isSameCurve(curve, value)) onChange(curve);
              },
            })}
          >
            Apply {label} curve
          </button>
        </BusyFieldset>
      </details>
  );
}
