// Paid-tier list prices, USD per million tokens, by date (plan 01-gemini "P0 results"). Output
// includes thinking tokens. Flash input includes audio; TTS input is text and its output is audio.
// Prices double from 2027-01-01.

type PricePeriod = {
  /** UTC epoch ms the period starts at. */
  from: number;
  inputUsd: number;
  outputUsd: number;
};

const DOUBLING = Date.UTC(2027, 0, 1);

/** Oldest period first. Unknown models cost `null`. */
export const GEMINI_PRICES: Record<string, PricePeriod[]> = {
  'gemini-3.8-flash': [
    { from: 0, inputUsd: 0.75, outputUsd: 3.75 },
    { from: DOUBLING, inputUsd: 1.5, outputUsd: 7.5 },
  ],
  'gemini-3.8-flash-tts': [
    { from: 0, inputUsd: 0.5, outputUsd: 9 },
    { from: DOUBLING, inputUsd: 1, outputUsd: 18 },
  ],
};

export function geminiCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  at: Date = new Date(),
): number | null {
  const price = GEMINI_PRICES[model]?.findLast((p) => p.from <= at.getTime());
  if (!price) return null;
  return (
    (inputTokens * price.inputUsd + outputTokens * price.outputUsd) / 1_000_000
  );
}
