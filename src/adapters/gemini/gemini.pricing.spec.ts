import { geminiCostUsd } from './gemini.pricing.js';

describe('geminiCostUsd', () => {
  const lastOld = new Date('2026-12-31T23:59:59Z');
  const firstNew = new Date('2027-01-01T00:00:00Z');

  it('prices flash at $0.75/$3.75 per million until the end of 2026', () => {
    expect(
      geminiCostUsd('gemini-3.8-flash', 1_000_000, 1_000_000, lastOld),
    ).toBeCloseTo(4.5);
  });

  it('doubles flash prices from 2027-01-01', () => {
    expect(
      geminiCostUsd('gemini-3.8-flash', 1_000_000, 1_000_000, firstNew),
    ).toBeCloseTo(9);
  });

  it('prices TTS text in and audio out, doubling in 2027', () => {
    expect(
      geminiCostUsd('gemini-3.8-flash-tts', 1_000_000, 1_000_000, lastOld),
    ).toBeCloseTo(9.5);
    expect(
      geminiCostUsd('gemini-3.8-flash-tts', 1_000_000, 1_000_000, firstNew),
    ).toBeCloseTo(19);
  });

  it('returns null for an unknown model', () => {
    expect(geminiCostUsd('gemini-9', 10, 10)).toBeNull();
  });
});
