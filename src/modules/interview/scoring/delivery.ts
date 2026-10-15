// Voice metrics → UI delivery shapes (plan §6, §10). Targets are config (NFR-12). Pure functions.
import type { DeliveryMetric, VoiceMetrics } from '../types.js';

export type DeliveryTarget = {
  min: number;
  max: number;
  scaleMin: number;
  scaleMax: number;
};
export type DeliveryTargets = {
  pace: DeliveryTarget;
  fillers: DeliveryTarget;
  pauses: DeliveryTarget;
};

export const DEFAULT_DELIVERY_TARGETS: DeliveryTargets = {
  pace: { min: 120, max: 160, scaleMin: 80, scaleMax: 200 },
  fillers: { min: 0, max: 4, scaleMin: 0, scaleMax: 12 },
  pauses: { min: 3, max: 6, scaleMin: 0, scaleMax: 8 },
};

export type PaceLabel = 'slow' | 'steady' | 'fast';

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;
const inRange = (v: number, t: DeliveryTarget) => v >= t.min && v <= t.max;

function base(
  key: DeliveryMetric['key'],
  label: string,
  value: number,
  t: DeliveryTarget,
) {
  return {
    key,
    label,
    value,
    scale: { min: t.scaleMin, max: t.scaleMax },
    target: { min: t.min, max: t.max },
    inTarget: inRange(value, t),
  };
}

export function paceLabel(
  wpm: number,
  target: DeliveryTarget = DEFAULT_DELIVERY_TARGETS.pace,
): PaceLabel {
  if (wpm < target.min) return 'slow';
  if (wpm > target.max) return 'fast';
  return 'steady';
}

function pace(wpm: number, t: DeliveryTarget): DeliveryMetric {
  const label = paceLabel(wpm, t);
  const words = { slow: 'a bit slow', fast: 'a bit fast', steady: 'steady' }[
    label
  ];
  const notes = {
    slow: 'Pick up the pace a little so your answer keeps its energy.',
    fast: 'Slow down a little so each point lands.',
    steady: 'A comfortable pace that is easy to follow.',
  };
  return {
    ...base('pace', 'Pace', wpm, t),
    valueText: `${wpm} wpm · ${words}`,
    targetText: `Target ${t.min}–${t.max}`,
    note: notes[label],
  };
}

function fillers(count: number, t: DeliveryTarget): DeliveryMetric {
  const ok = count <= t.max;
  return {
    ...base('fillers', 'Filler words', count, t),
    valueText: `${plural(count, 'filler word', 'filler words')} · ${ok ? 'few' : 'a few too many'}`,
    targetText:
      t.min === 0 ? `Target ${t.max} or fewer` : `Target ${t.min}–${t.max}`,
    note: ok
      ? 'Clean and clear.'
      : "Try a short pause instead of 'um' or 'you know'.",
  };
}

function pauses(count: number, t: DeliveryTarget): DeliveryMetric {
  const words =
    count < t.min
      ? 'could use more'
      : count > t.max
        ? 'quite a lot'
        : 'well placed';
  const note =
    count < t.min
      ? 'Pause briefly after each step.'
      : count > t.max
        ? 'A few long gaps. Plan your next point before you start it.'
        : 'Good breathing room between steps.';
  return {
    ...base('pauses', 'Pauses', count, t),
    valueText: `${plural(count, 'pause', 'pauses')} · ${words}`,
    targetText: `Target ${t.min}–${t.max}`,
    note,
  };
}

/** Candidate UI `DeliveryMetric[3]` (pace, fillers, pauses). Typed answers (null metrics) → []. */
export function toDeliveryMetrics(
  metrics: VoiceMetrics | null,
  targets: DeliveryTargets = DEFAULT_DELIVERY_TARGETS,
): DeliveryMetric[] {
  if (!metrics) return [];
  return [
    pace(metrics.wpm, targets.pace),
    fillers(metrics.fillerCount, targets.fillers),
    pauses(metrics.pauseCount, targets.pauses),
  ];
}

/** Admin UI `DeliveryMetrics`. */
export function toAdminDelivery(
  metrics: VoiceMetrics,
  targets: DeliveryTargets = DEFAULT_DELIVERY_TARGETS,
): {
  wpm: number;
  paceLabel: PaceLabel;
  fillerWords: number;
  longestPauseSec: number;
} {
  return {
    wpm: metrics.wpm,
    paceLabel: paceLabel(metrics.wpm, targets.pace),
    fillerWords: metrics.fillerCount,
    longestPauseSec: metrics.longestPauseS,
  };
}
