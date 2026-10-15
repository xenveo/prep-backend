// Voice delivery metrics from STT word timestamps (plan §6 "Metrics"). Pure functions.
import type { VoiceMetrics, Word } from '../types.js';

/** Filler lexicon. Multi-word entries match consecutive words; "like" only counts as a filler (see isFillerLike). */
export const FILLER_LEXICON: readonly string[] = [
  'um',
  'uh',
  'er',
  'like',
  'you know',
  'kind of',
  'sort of',
  'basically',
  'actually',
  'i mean',
];

/** A gap between words longer than this (seconds) is a pause. */
export const PAUSE_THRESHOLD_S = 1.0;

// "I like", "would like", "to like": verb.
const LIKE_VERB_BEFORE = new Set([
  'i',
  'you',
  'we',
  'they',
  'would',
  'do',
  "don't",
  'did',
  "didn't",
  'does',
  "doesn't",
  'to',
  'really',
  'might',
  'will',
  "i'd",
  "we'd",
  "you'd",
  "they'd",
  'people',
  'customers',
]);
// "looks like", "something like", "just like": preposition or comparison.
const LIKE_PREPOSITION_BEFORE = new Set([
  'look',
  'looks',
  'looked',
  'looking',
  'feel',
  'feels',
  'felt',
  'seem',
  'seems',
  'seemed',
  'sound',
  'sounds',
  'sounded',
  'something',
  'things',
  'anything',
  'nothing',
  'more',
  'much',
  'exactly',
  'just',
  'thing',
  'person',
  'people',
]);
// "it was like, …", "and like we …": filler.
const LIKE_FILLER_BEFORE = new Set([
  'was',
  'is',
  'were',
  'are',
  "it's",
  "i'm",
  "he's",
  "she's",
  "they're",
  "we're",
  'and',
  'so',
  'but',
  'um',
  'uh',
  'er',
  'then',
  'its',
  'literally',
]);
// "a kind of tool", "what sort of issue": a real noun phrase, not a hedge.
const KIND_OF_NOUN_BEFORE = new Set([
  'a',
  'the',
  'what',
  'this',
  'that',
  'some',
  'any',
  'every',
  'which',
  'one',
  'same',
  'different',
  'right',
  'wrong',
]);
// "do you know", "if you know": a real question or clause.
const YOU_KNOW_LITERAL_BEFORE = new Set([
  'do',
  'did',
  "don't",
  "didn't",
  'if',
  'whether',
  'as',
]);

type Token = { text: string; trailingComma: boolean; leadingComma: boolean };

function tokenize(words: Word[]): Token[] {
  return words.map((w) => {
    const raw = w.w.trim();
    return {
      text: raw
        .toLowerCase()
        .replace(/’/g, "'")
        .replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, ''),
      trailingComma: /[,.;:!?—-]$/.test(raw),
      leadingComma: /^[,—-]/.test(raw),
    };
  });
}

function isFillerLike(tokens: Token[], i: number): boolean {
  const prev = i > 0 ? tokens[i - 1] : undefined;
  if (
    !prev ||
    prev.trailingComma ||
    tokens[i].trailingComma ||
    tokens[i].leadingComma
  )
    return true;
  if (LIKE_VERB_BEFORE.has(prev.text) || LIKE_PREPOSITION_BEFORE.has(prev.text))
    return false;
  return LIKE_FILLER_BEFORE.has(prev.text);
}

/** Counts filler words. Multi-word fillers are matched first and consume their words. */
export function countFillers(words: Word[]): number {
  const tokens = tokenize(words);
  const phrases = FILLER_LEXICON.map((f) => f.split(' ')).sort(
    (a, b) => b.length - a.length,
  );
  let count = 0;
  let i = 0;
  while (i < tokens.length) {
    const match = phrases.find((p) =>
      p.every((part, k) => tokens[i + k]?.text === part),
    );
    if (!match) {
      i++;
      continue;
    }
    const phrase = match.join(' ');
    const prev = i > 0 ? tokens[i - 1].text : '';
    let isFiller = true;
    if (phrase === 'like') isFiller = isFillerLike(tokens, i);
    else if (phrase === 'kind of' || phrase === 'sort of')
      isFiller = !KIND_OF_NOUN_BEFORE.has(prev);
    else if (phrase === 'you know')
      isFiller = !YOU_KNOW_LITERAL_BEFORE.has(prev);
    if (isFiller) count++;
    i += isFiller ? match.length : 1;
  }
  return count;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * wpm = words ÷ (last end − first start) × 60; pauses = gaps > 1.0 s; longest pause = longest gap.
 * `durationS` is the audio length, passed through.
 */
export function computeMetrics(words: Word[], durationS: number): VoiceMetrics {
  const spoken = words.filter((w) => w.w.trim().length > 0);
  let wpm = 0;
  let pauseCount = 0;
  let longestPauseS = 0;
  if (spoken.length > 0) {
    const span = spoken[spoken.length - 1].end - spoken[0].start;
    wpm = span > 0 ? Math.round((spoken.length / span) * 60) : 0;
    for (let i = 1; i < spoken.length; i++) {
      const gap = spoken[i].start - spoken[i - 1].end;
      if (gap > PAUSE_THRESHOLD_S) pauseCount++;
      if (gap > longestPauseS) longestPauseS = gap;
    }
  }
  return {
    wpm,
    fillerCount: countFillers(spoken),
    pauseCount,
    longestPauseS: round1(longestPauseS),
    durationS: round1(durationS),
  };
}
