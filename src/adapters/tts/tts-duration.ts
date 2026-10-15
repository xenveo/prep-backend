const WORDS_PER_MINUTE = 150;

/** Spoken length estimate at ~150 wpm, for providers that don't report duration. */
export function estimateSpeechSeconds(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.round((words / WORDS_PER_MINUTE) * 60 * 10) / 10;
}
