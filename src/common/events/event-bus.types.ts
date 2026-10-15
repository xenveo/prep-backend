// Pub/sub contract. Workers publish; the interview WS gateway relays to sockets (plan §6).
// Backed by Redis pub/sub when REDIS_URL is set, otherwise an in-process emitter.

export const EVENT_BUS = Symbol('EVENT_BUS');

/** Channel names. */
export const sessionChannel = (sessionId: string) => `session:${sessionId}`;
export const USER_REVOKED_CHANNEL = 'user.revoked';

/** Events on `session:{id}`. `attempt` payloads are the candidate UI shapes (serializers). */
export type SessionEvent =
  | { type: 'attempt.transcribed'; attemptId: string; questionId: string; attemptNo: number; transcript: string }
  | {
      type: 'attempt.evaluated';
      attemptId: string;
      questionId: string;
      attemptNo: number;
      attempt: unknown;
      applied: unknown[];
      followUp: string | null;
    }
  | { type: 'feedback.audio_ready'; attemptId: string; url: string }
  | { type: 'attempt.failed'; attemptId: string; code: string; retryable: boolean; textModeOffered: boolean };

/** Event on USER_REVOKED_CHANNEL: deactivation or erasure. The gateway closes the user's sockets. */
export type UserRevokedEvent = { userId: string };

export type Unsubscribe = () => Promise<void>;

export interface EventBus {
  publish(channel: string, event: object): Promise<void>;
  subscribe(channel: string, handler: (event: any) => void): Promise<Unsubscribe>;
}
