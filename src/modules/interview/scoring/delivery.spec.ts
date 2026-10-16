import type { VoiceMetrics } from '../types.js';
import {
  DEFAULT_DELIVERY_TARGETS,
  toAdminDelivery,
  toDeliveryMetrics,
} from './delivery.js';

const metrics = (m: Partial<VoiceMetrics>): VoiceMetrics => ({
  wpm: 140,
  fillerCount: 2,
  pauseCount: 4,
  longestPauseS: 1.8,
  durationS: 60,
  ...m,
});

describe('toDeliveryMetrics', () => {
  it('returns [] for typed answers', () => {
    expect(toDeliveryMetrics(null)).toEqual([]);
  });

  it('builds pace, fillers and pauses in the candidate UI shape', () => {
    const [pace, fillers, pauses] = toDeliveryMetrics(
      metrics({ wpm: 172, fillerCount: 6, pauseCount: 1 }),
    );
    expect(pace).toEqual({
      key: 'pace',
      label: 'Pace',
      value: 172,
      valueText: '172 wpm · a bit fast',
      scale: { min: 80, max: 200 },
      target: { min: 120, max: 160 },
      targetText: 'Target 120–160',
      note: 'Slow down a little so each point lands.',
      inTarget: false,
    });
    expect(fillers.valueText).toBe('6 filler words · a few too many');
    expect(fillers.targetText).toBe('Target 4 or fewer');
    expect(fillers.inTarget).toBe(false);
    expect(pauses.valueText).toBe('1 pause · could use more');
    expect(pauses.targetText).toBe('Target 3–6');
    expect(pauses.scale).toEqual({ min: 0, max: 8 });
  });

  it('marks in-target values at the edges', () => {
    const [pace, fillers, pauses] = toDeliveryMetrics(
      metrics({ wpm: 120, fillerCount: 4, pauseCount: 6 }),
    );
    expect(pace.valueText).toBe('120 wpm · steady');
    expect([pace.inTarget, fillers.inTarget, pauses.inTarget]).toEqual([
      true,
      true,
      true,
    ]);
    expect(fillers.valueText).toBe('4 filler words · few');
    expect(pauses.valueText).toBe('6 pauses · well placed');
  });

  it('omits pauses (rather than showing 0) when they were not measured', () => {
    const out = toDeliveryMetrics(
      metrics({ pauseCount: null, longestPauseS: null }),
    );
    expect(out.map((m) => m.key)).toEqual(['pace', 'fillers']);
  });

  it('uses configured targets', () => {
    const [pace] = toDeliveryMetrics(metrics({ wpm: 110 }), {
      ...DEFAULT_DELIVERY_TARGETS,
      pace: { min: 100, max: 140, scaleMin: 60, scaleMax: 180 },
    });
    expect(pace.inTarget).toBe(true);
    expect(pace.targetText).toBe('Target 100–140');
  });
});

describe('toAdminDelivery', () => {
  it('maps to the admin UI shape', () => {
    expect(
      toAdminDelivery({ wpm: 100, fillerCount: 2, longestPauseS: 1.8 }),
    ).toEqual({
      wpm: 100,
      paceLabel: 'slow',
      fillerWords: 2,
      longestPauseSec: 1.8,
    });
    expect(
      toAdminDelivery({ wpm: 140, fillerCount: 0, longestPauseS: null })
        .longestPauseSec,
    ).toBeNull();
  });
});
