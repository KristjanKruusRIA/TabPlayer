import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { model } from '@coderline/alphatab';
import type { EditCommand } from '../edit-types';
import type { RatioTempoPoint } from './tempo-types';
import { useI18n } from '../i18n';
import { Dialog, BusyFieldset, busyGuard } from '../ui';
import { quarterUnit, shownBpm, tempoUnitKeys, tempoUnits, unitQuarters, type TempoUnit } from './tempo-unit';
import {
  beatNumberToRatio,
  pointUnit,
  ratioToBeatNumber,
  readTempoPoints,
  removeExtraTempoPoints,
  removeTempoPoint,
  snapRatioToBeats,
  soundingBpm,
  tapTempoBpm,
  tempoPointsEqual,
  upsertTempoPoint,
} from './tempo-editor-model';
import './tempo-editor-dialog.css';

export interface TempoEditorDialogProps {
  score: model.Score;
  initialBar: number;
  busy?: boolean;
  locked?: boolean;
  onApply: (command: EditCommand) => void | Promise<unknown>;
  onClose: () => void;
}

const HEADER_H = 38;
const PLOT_H = 228;
const PLOT_BOTTOM_PAD = 18;
const Y_AXIS_W = 42;
const MIN_BPM = 1;
const MAX_BPM = 999;

export function TempoEditorDialog({ score, initialBar, busy = false, locked = false, onApply, onClose }: TempoEditorDialogProps) {
  const { t } = useI18n();
  const basePoints = useMemo(() => readTempoPoints(score), [score]);
  const [points, setPoints] = useState<RatioTempoPoint[]>(basePoints);
  const initialIndex = useMemo(() => {
    const exact = basePoints.findIndex(p => p.bar === initialBar);
    if (exact >= 0) return exact;
    let lastBefore = 0;
    basePoints.forEach((p, i) => {
      if (p.bar <= initialBar) lastBefore = i;
    });
    return lastBefore;
  }, [basePoints, initialBar]);
  const [selectedIndex, setSelectedIndex] = useState(initialIndex);
  const [bpmDraft, setBpmDraft] = useState(() => String(shownBpm(basePoints[initialIndex]?.bpm ?? 120)));
  const [snapToGrid, setSnapToGrid] = useState(true);
  const [barWidth, setBarWidth] = useState(84);
  const tapTimestamps = useRef<number[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<SVGSVGElement>(null);
  const unitId = useId(), tempoId = useId(), barId = useId(), beatId = useId();
  const readOnly = busy || locked;

  useEffect(() => {
    setPoints(basePoints);
    setSelectedIndex(initialIndex);
    setBpmDraft(String(shownBpm(basePoints[initialIndex]?.bpm ?? 120)));
  }, [basePoints, initialIndex]);

  const safeIndex = Math.min(Math.max(0, selectedIndex), Math.max(0, points.length - 1));
  const selected = points[safeIndex] ?? { bar: 0, ratio: 0, bpm: 120, linear: false };

  useEffect(() => {
    setBpmDraft(String(shownBpm(selected.bpm)));
  }, [safeIndex, selected.bpm]);

  const barCount = Math.max(1, score.masterBars.length);
  const effectiveBarWidth = Math.max(barWidth, Math.floor(540 / barCount));

  useEffect(() => {
    const host = scrollRef.current;
    if (!host) return;
    const targetLeft = Math.max(0, initialBar * effectiveBarWidth - host.clientWidth * 0.35);
    host.scrollLeft = targetLeft;
  }, [initialBar, effectiveBarWidth]);

  const totalWidth = Y_AXIS_W + barCount * effectiveBarWidth + 16;
  const totalHeight = HEADER_H + PLOT_H + PLOT_BOTTOM_PAD;

  const yBounds = useMemo(() => {
    const bpms = points.map(soundingBpm);
    const maxVal = Math.max(240, ...bpms);
    const minVal = Math.min(30, ...bpms);
    const ceil = Math.ceil((maxVal + 20) / 20) * 20;
    const floor = Math.max(0, Math.floor((minVal - 10) / 20) * 20);
    return { min: floor, max: Math.max(ceil, floor + 60) };
  }, [points]);

  const xOf = (bar: number, ratio: number) => Y_AXIS_W + (bar + ratio) * effectiveBarWidth;
  const yOf = (bpm: number) => {
    const norm = (bpm - yBounds.min) / (yBounds.max - yBounds.min);
    return HEADER_H + PLOT_H - Math.min(1, Math.max(0, norm)) * PLOT_H;
  };
  const bpmFromY = (clientY: number): number => {
    const rect = graphRef.current?.getBoundingClientRect();
    if (!rect || rect.height === 0) return soundingBpm(selected);
    const svgY = ((clientY - rect.top) / rect.height) * totalHeight;
    const norm = Math.min(1, Math.max(0, (HEADER_H + PLOT_H - svgY) / PLOT_H));
    const raw = yBounds.min + norm * (yBounds.max - yBounds.min);
    return Math.max(MIN_BPM, Math.min(MAX_BPM, Math.round(raw)));
  };
  const positionFromX = (clientX: number): { bar: number; ratio: number } => {
    const rect = graphRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return { bar: selected.bar, ratio: selected.ratio };
    const svgX = ((clientX - rect.left) / rect.width) * totalWidth;
    const rawBars = Math.min(barCount - 0.001, Math.max(0, (svgX - Y_AXIS_W) / effectiveBarWidth));
    const bar = Math.min(barCount - 1, Math.max(0, Math.floor(rawBars)));
    const rawRatio = Math.min(0.999, Math.max(0, rawBars - bar));
    const num = score.masterBars[bar]?.timeSignatureNumerator ?? 4;
    const ratio = snapToGrid ? snapRatioToBeats(rawRatio, num) : Math.round(rawRatio * 1000) / 1000;
    return { bar, ratio };
  };

  const updateSelected = (patch: Partial<RatioTempoPoint>) => {
    if (readOnly) return;
    const nextPoint: RatioTempoPoint = { ...selected, ...patch };
    const result = upsertTempoPoint(
      points.filter((_, i) => i !== safeIndex),
      nextPoint,
    );
    setPoints(result.points);
    setSelectedIndex(result.index);
  };

  const selectedUnit = pointUnit(selected);
  const numeratorForSelected = score.masterBars[selected.bar]?.timeSignatureNumerator ?? 4;
  const beatValue = ratioToBeatNumber(selected.ratio, numeratorForSelected);

  const parsedDraft = Number(bpmDraft.trim());
  const bpmValid = bpmDraft.trim() !== '' && Number.isFinite(parsedDraft) && parsedDraft >= MIN_BPM && parsedDraft <= MAX_BPM;
  const changed = !tempoPointsEqual(points, basePoints);

  const commitDraftBpm = (text: string) => {
    setBpmDraft(text);
    const val = Number(text.trim());
    if (text.trim() !== '' && Number.isFinite(val) && val >= MIN_BPM && val <= MAX_BPM) {
      updateSelected({ bpm: val });
    }
  };

  const handleUnitChange = (nextUnit: TempoUnit) => {
    if (readOnly || nextUnit === selectedUnit) return;
    const currentQuarter = selected.bpm * unitQuarters[selectedUnit];
    const nextBpm = Math.max(MIN_BPM, Math.min(MAX_BPM, currentQuarter / unitQuarters[nextUnit]));
    updateSelected({ unit: nextUnit === quarterUnit ? undefined : nextUnit, bpm: nextBpm });
  };

  const handleTap = () => {
    if (readOnly) return;
    const now = Date.now();
    tapTimestamps.current = [...tapTimestamps.current.filter(ts => now - ts <= 2500), now].slice(-8);
    const detected = tapTempoBpm(tapTimestamps.current);
    if (detected !== null) {
      updateSelected({ bpm: detected });
      setBpmDraft(String(detected));
    }
  };

  const handleAddPoint = () => {
    if (readOnly) return;
    let targetBar = Math.min(Math.max(0, initialBar), barCount - 1);
    let ratio = 0;
    const hasPointAt = (b: number, r: number) => points.some(p => p.bar === b && Math.abs(p.ratio - r) < 1e-4);
    if (hasPointAt(targetBar, ratio)) {
      const nextUnusedBar = Array.from({ length: barCount }, (_, i) => i).find(b => !hasPointAt(b, 0));
      if (nextUnusedBar !== undefined) {
        targetBar = nextUnusedBar;
        ratio = 0;
      } else {
        const num = score.masterBars[targetBar]?.timeSignatureNumerator ?? 4;
        const step = Array.from({ length: num }, (_, i) => beatNumberToRatio(i + 1, num)).find(r => !hasPointAt(targetBar, r));
        ratio = step ?? Math.min(0.95, Math.round((selected.ratio + 0.125) * 1000) / 1000);
      }
    }
    const result = upsertTempoPoint(points, {
      bar: targetBar,
      ratio,
      bpm: selected.bpm,
      linear: false,
      ...(selectedUnit !== quarterUnit ? { unit: selectedUnit } : {}),
    });
    setPoints(result.points);
    setSelectedIndex(result.index);
  };

  const startDrag = (index: number, event: ReactPointerEvent<SVGCircleElement>) => {
    event.stopPropagation();
    setSelectedIndex(index);
    if (readOnly) return;
    const svg = graphRef.current;
    if (!svg) return;
    let currentIdx = index;
    const onMove = (moveEvent: PointerEvent) => {
      const targetPoint = points[currentIdx];
      if (!targetPoint) return;
      const quarterBpm = bpmFromY(moveEvent.clientY);
      const u = pointUnit(targetPoint);
      const nextBpm = Math.max(MIN_BPM, Math.min(MAX_BPM, Math.round((quarterBpm / unitQuarters[u]) * 10) / 10));
      if (currentIdx === 0) {
        setPoints(prev => prev.map((p, i) => (i === 0 ? { ...p, bpm: nextBpm } : p)));
        setBpmDraft(String(nextBpm));
        return;
      }
      const pos = positionFromX(moveEvent.clientX);
      const safePos = pos.bar === 0 && pos.ratio < 1e-4 ? { bar: 0, ratio: beatNumberToRatio(2, score.masterBars[0]?.timeSignatureNumerator ?? 4) } : pos;
      setPoints(prev => {
        const updated = upsertTempoPoint(prev.filter((_, i) => i !== currentIdx), { ...targetPoint, ...safePos, bpm: nextBpm });
        currentIdx = updated.index;
        setSelectedIndex(updated.index);
        return updated.points;
      });
      setBpmDraft(String(nextBpm));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const handlePlotClick = (event: React.MouseEvent<SVGSVGElement>) => {
    if (readOnly) return;
    const target = event.target as Element | null;
    if (target?.closest('.tempo-point-handle')) return;
    const pos = positionFromX(event.clientX);
    const quarterBpm = bpmFromY(event.clientY);
    const existing = points.findIndex(p => p.bar === pos.bar && Math.abs(p.ratio - pos.ratio) < 1e-4);
    const nextBpm = existing >= 0
      ? Math.max(MIN_BPM, Math.min(MAX_BPM, Math.round(quarterBpm / unitQuarters[pointUnit(points[existing])])))
      : quarterBpm;
    const result = upsertTempoPoint(points, {
      bar: pos.bar,
      ratio: pos.ratio,
      bpm: nextBpm,
      linear: existing >= 0 ? points[existing].linear : false,
      ...(existing >= 0 && points[existing].unit !== undefined ? { unit: points[existing].unit } : {}),
    });
    setPoints(result.points);
    setSelectedIndex(result.index);
  };

  const handlePointKey = (index: number, event: ReactKeyboardEvent<SVGCircleElement>) => {
    setSelectedIndex(index);
    if (readOnly) return;
    const pt = points[index];
    if (!pt) return;
    const step = event.shiftKey ? 10 : 1;
    if (event.key === 'ArrowUp' || event.key === 'ArrowRight') {
      event.preventDefault();
      const next = Math.min(MAX_BPM, pt.bpm + step);
      setPoints(prev => prev.map((p, i) => (i === index ? { ...p, bpm: next } : p)));
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const next = Math.max(MIN_BPM, pt.bpm - step);
      setPoints(prev => prev.map((p, i) => (i === index ? { ...p, bpm: next } : p)));
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && index > 0) {
      event.preventDefault();
      setPoints(removeTempoPoint(points, index));
      setSelectedIndex(Math.max(0, index - 1));
    }
  };

  const curveGeometry = useMemo(() => {
    const endX = xOf(barCount, 0);
    const baselineY = HEADER_H + PLOT_H;
    const coords = points.map(p => ({ x: xOf(p.bar, p.ratio), y: yOf(soundingBpm(p)), linear: p.linear }));
    if (!coords.length) return { line: '', area: '' };
    const lineParts: string[] = [`M ${coords[0].x} ${coords[0].y}`];
    for (let i = 0; i < coords.length - 1; i++) {
      const curr = coords[i], next = coords[i + 1];
      if (curr.linear) {
        lineParts.push(`L ${next.x} ${next.y}`);
      } else {
        lineParts.push(`L ${next.x} ${curr.y}`, `L ${next.x} ${next.y}`);
      }
    }
    const last = coords[coords.length - 1];
    lineParts.push(`L ${endX} ${last.y}`);
    const line = lineParts.join(' ');
    const area = `${line} L ${endX} ${baselineY} L ${coords[0].x} ${baselineY} Z`;
    return { line, area };
  }, [points, barCount, effectiveBarWidth, yBounds]);

  const yTicks = useMemo(() => {
    const ticks: number[] = [];
    const span = yBounds.max - yBounds.min;
    const step = span <= 160 ? 20 : span <= 320 ? 40 : 100;
    for (let val = yBounds.min + step; val < yBounds.max; val += step) ticks.push(val);
    return ticks;
  }, [yBounds]);

  const submitApply = async (closeAfter: boolean) => {
    if (readOnly || !bpmValid) return;
    if (changed) {
      await Promise.resolve(onApply({ type: 'replaceTempoAutomations', points }));
    }
    if (closeAfter) onClose();
  };

  return (
    <Dialog
      title={t('tempo_editor.title')}
      className="tempo-editor-dialog"
      onClose={onClose}
      dismissOnBackdrop
      busy={busy}
      actions={
        <>
          <button type="button" onClick={onClose}>{t('tempo_editor.cancel')}</button>
          <button type="button" {...busyGuard({ busy, disabled: readOnly || !changed || !bpmValid, onClick: () => void submitApply(false) })}>{t('tempo_editor.apply')}</button>
          <button type="button" data-autofocus {...busyGuard({ busy, disabled: !bpmValid || (locked && changed), className: 'primary', onClick: () => void submitApply(true) })}>{t('tempo_editor.ok')}</button>
        </>
      }
    >
      <div className="tempo-editor-topbar">
        <div className="tempo-editor-type">
          <span className="tempo-editor-type-label">{t('tempo_editor.type_label')}</span>
          <span className="tempo-editor-type-pill">{t('tempo_editor.type_tempo')}</span>
        </div>
        <button
          type="button"
          {...busyGuard({
            busy,
            disabled: readOnly || points.length <= 1,
            onClick: () => {
              setPoints(removeExtraTempoPoints(points));
              setSelectedIndex(0);
            },
          })}
        >
          {t('tempo_editor.remove_automations')}
        </button>
      </div>

      <div className="tempo-editor-main">
        <BusyFieldset busy={busy} disabled={locked} className="tempo-editor-settings">
          <h3>{t('tempo_editor.point_settings')}</h3>
          <div className="tempo-editor-pos-row">
            <label htmlFor={barId}>
              <span>{t('tempo_editor.bar')}</span>
              <select
                id={barId}
                disabled={readOnly || safeIndex === 0}
                value={selected.bar}
                onChange={e => {
                  const nextBar = Number(e.target.value);
                  const num = score.masterBars[nextBar]?.timeSignatureNumerator ?? 4;
                  const ratio = nextBar === 0 && safeIndex > 0 ? beatNumberToRatio(Math.max(2, beatValue), num) : selected.ratio;
                  updateSelected({ bar: nextBar, ratio });
                }}
              >
                {Array.from({ length: barCount }, (_, i) => (
                  <option key={i} value={i}>{i + 1}</option>
                ))}
              </select>
            </label>
            <label htmlFor={beatId}>
              <span>{t('tempo_editor.beat')}</span>
              <select
                id={beatId}
                disabled={readOnly || safeIndex === 0}
                value={beatValue}
                onChange={e => {
                  const nextBeat = Number(e.target.value);
                  const minBeat = selected.bar === 0 && safeIndex > 0 ? Math.max(2, nextBeat) : nextBeat;
                  updateSelected({ ratio: beatNumberToRatio(minBeat, numeratorForSelected) });
                }}
              >
                {Array.from({ length: numeratorForSelected }, (_, i) => (
                  <option key={i + 1} value={i + 1} disabled={selected.bar === 0 && safeIndex > 0 && i === 0}>{i + 1}</option>
                ))}
              </select>
            </label>
          </div>

          <label className="tempo-editor-field" htmlFor={unitId}>
            <span>{t('tempo_editor.unit')}</span>
            <select id={unitId} disabled={readOnly} value={selectedUnit} onChange={e => handleUnitChange(Number(e.target.value) as TempoUnit)}>
              {tempoUnits.map(u => <option key={u} value={u}>{t(tempoUnitKeys[u])}</option>)}
            </select>
          </label>

          <div className="tempo-editor-field">
            <label htmlFor={tempoId}>{t('tempo_editor.tempo')}</label>
            <div className="tempo-editor-bpm-row">
              <div className="tempo-editor-bpm-input">
                <input
                  id={tempoId}
                  type="number"
                  min={MIN_BPM}
                  max={MAX_BPM}
                  step="any"
                  disabled={readOnly}
                  aria-invalid={!bpmValid || undefined}
                  value={bpmDraft}
                  onChange={e => commitDraftBpm(e.target.value)}
                />
                <span className="tempo-editor-bpm-suffix">{t('tempo_editor.bpm_unit')}</span>
              </div>
              <button type="button" className="tempo-editor-tap" title={t('tempo_editor.tap_title')} disabled={readOnly} onClick={handleTap}>
                {t('tempo_editor.tap')}
              </button>
            </div>
            {!bpmValid && <p role="alert" className="tempo-editor-error">{t('tempo_editor.invalid_bpm')}</p>}
          </div>

          <fieldset className="tempo-editor-transition" disabled={readOnly}>
            <legend>{t('tempo_editor.transition')}</legend>
            <label className="check">
              <input type="radio" name="tempo-transition" checked={!selected.linear} onChange={() => updateSelected({ linear: false })} />
              <span>{t('tempo_editor.constant')}</span>
            </label>
            <label className="check">
              <input type="radio" name="tempo-transition" checked={selected.linear} onChange={() => updateSelected({ linear: true })} />
              <span>{t('tempo_editor.progressive')}</span>
            </label>
          </fieldset>

          <div className="tempo-editor-point-actions">
            <button type="button" disabled={readOnly} onClick={handleAddPoint}>{t('tempo_editor.add_point')}</button>
            <button
              type="button"
              disabled={readOnly || safeIndex === 0}
              onClick={() => {
                setPoints(removeTempoPoint(points, safeIndex));
                setSelectedIndex(Math.max(0, safeIndex - 1));
              }}
            >
              {t('tempo_editor.remove_point')}
            </button>
          </div>
        </BusyFieldset>

        <div className="tempo-editor-graph-pane">
          <div ref={scrollRef} className="tempo-editor-scroll">
            <svg
              ref={graphRef}
              className="tempo-editor-svg"
              width={totalWidth}
              height={totalHeight}
              viewBox={`0 0 ${totalWidth} ${totalHeight}`}
              role="img"
              aria-label={t('tempo_editor.graph_aria')}
              onClick={handlePlotClick}
            >
              <rect x={Y_AXIS_W} y={0} width={barCount * effectiveBarWidth} height={18} className="tempo-ruler-bg" />
              <rect x={Y_AXIS_W} y={18} width={barCount * effectiveBarWidth} height={20} className="tempo-master-track" />
              <text x={Y_AXIS_W + 8} y={32} className="tempo-master-label">{t('tempo_editor.master_track')}</text>
              {initialBar >= 0 && initialBar < barCount && (
                <rect x={xOf(initialBar, 0)} y={HEADER_H} width={effectiveBarWidth} height={PLOT_H} className="tempo-current-bar" />
              )}
              {Array.from({ length: barCount }, (_, b) => {
                const bx = xOf(b, 0);
                const num = score.masterBars[b]?.timeSignatureNumerator ?? 4;
                return (
                  <g key={b}>
                    <line x1={bx} y1={0} x2={bx} y2={HEADER_H + PLOT_H} className="tempo-grid-bar" />
                    <text x={bx + 4} y={13} className="tempo-ruler-text">{b + 1}</text>
                    {Array.from({ length: Math.max(0, num - 1) }, (_, beatIdx) => {
                      const gx = xOf(b, (beatIdx + 1) / num);
                      return <line key={beatIdx} x1={gx} y1={HEADER_H} x2={gx} y2={HEADER_H + PLOT_H} className="tempo-grid-beat" />;
                    })}
                  </g>
                );
              })}
              <line x1={xOf(barCount, 0)} y1={0} x2={xOf(barCount, 0)} y2={HEADER_H + PLOT_H} className="tempo-grid-bar" />

              {yTicks.map(tick => {
                const ty = yOf(tick);
                return (
                  <g key={tick}>
                    <line x1={Y_AXIS_W} y1={ty} x2={xOf(barCount, 0)} y2={ty} className="tempo-grid-bpm" />
                    <text x={Y_AXIS_W - 6} y={ty + 4} textAnchor="end" className="tempo-axis-text">{tick}</text>
                  </g>
                );
              })}

              {curveGeometry.area && <path d={curveGeometry.area} className="tempo-curve-fill" />}
              {curveGeometry.line && <path d={curveGeometry.line} className="tempo-curve-line" />}

              {points.map((point, index) => {
                const cx = xOf(point.bar, point.ratio);
                const cy = yOf(soundingBpm(point));
                const num = score.masterBars[point.bar]?.timeSignatureNumerator ?? 4;
                const beat = ratioToBeatNumber(point.ratio, num);
                const isSelected = index === safeIndex;
                const label = t('tempo_editor.point_aria', {
                  bar: point.bar + 1,
                  beat,
                  bpm: Math.round(shownBpm(point.bpm)),
                  transition: point.linear ? t('tempo_editor.progressive') : t('tempo_editor.constant'),
                });
                return (
                  <g key={`${point.bar}-${point.ratio}-${index}`}>
                    <text x={cx + 6} y={Math.max(HEADER_H + 12, cy - 8)} className="tempo-point-value">
                      {Math.round(shownBpm(point.bpm))}
                    </text>
                    <circle
                      cx={cx}
                      cy={cy}
                      r={isSelected ? 6 : 5}
                      tabIndex={0}
                      role="slider"
                      aria-label={label}
                      aria-valuemin={MIN_BPM}
                      aria-valuemax={MAX_BPM}
                      aria-valuenow={Math.round(point.bpm)}
                      className={`tempo-point-handle${isSelected ? ' is-selected' : ''}`}
                      onPointerDown={e => startDrag(index, e)}
                      onKeyDown={e => handlePointKey(index, e)}
                      onFocus={() => setSelectedIndex(index)}
                    />
                  </g>
                );
              })}
            </svg>
          </div>
          <div className="tempo-editor-controls">
            <label className="check">
              <input type="checkbox" checked={snapToGrid} onChange={e => setSnapToGrid(e.target.checked)} />
              <span>{t('tempo_editor.snap_to_grid')}</span>
            </label>
            <label className="tempo-editor-zoom">
              <span>{t('tempo_editor.zoom')}</span>
              <input type="range" min={44} max={160} step={4} value={barWidth} onChange={e => setBarWidth(Number(e.target.value))} />
            </label>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
