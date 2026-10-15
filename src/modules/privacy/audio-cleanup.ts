import type { PrismaClient } from '../../generated/prisma/client.js';

/** TTS output cached by content hash (plan §6). One object can back many attempts and questions. */
export const SHARED_TTS_PREFIX = 'tts/';

/**
 * Of the given feedback-audio keys, the ones safe to delete for the attempts `ownAttemptIds`.
 * Keys outside the shared `tts/` cache belong to those attempts alone. A `tts/` key is deleted only
 * when no other attempt (any user, erased or not) and no question still points at it, so erasing
 * or expiring one candidate's feedback never breaks someone else's audio.
 */
export async function unsharedAudioKeys(
  db: PrismaClient,
  keys: readonly string[],
  ownAttemptIds: readonly string[],
): Promise<string[]> {
  const unique = [...new Set(keys)];
  const shared = unique.filter((k) => k.startsWith(SHARED_TTS_PREFIX));
  if (shared.length === 0) return unique;

  const [attempts, questions] = await Promise.all([
    db.attempt.findMany({
      where: {
        feedbackAudioKey: { in: shared },
        id: { notIn: [...ownAttemptIds] },
      },
      select: { feedbackAudioKey: true },
    }),
    db.question.findMany({
      where: { audioKey: { in: shared } },
      select: { audioKey: true },
    }),
  ]);
  const inUse = new Set<string | null>([
    ...attempts.map((a) => a.feedbackAudioKey),
    ...questions.map((q) => q.audioKey),
  ]);
  return unique.filter((k) => !inUse.has(k));
}
