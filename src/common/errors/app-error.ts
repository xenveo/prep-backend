// Every API error is `{error: {code, message}}` (spec "Errors"). The global filter renders AppError;
// `extra` is merged into the body beside `error` (e.g. the in-progress session on 409).

export type ErrorCode =
  | 'not_found'
  | 'cards_not_viewed'
  | 'attempt_limit'
  | 'access_expired'
  | 'session_in_progress'
  | 'ai_unavailable'
  | 'rate_limited'
  | 'validation_failed'
  | 'unauthenticated'
  | 'forbidden'
  | 'conflict'
  | 'gone'
  | 'internal';

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
    message: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (message = 'Not found') => new AppError('not_found', 404, message);
export const validationFailed = (message: string) => new AppError('validation_failed', 400, message);
export const conflict = (message: string, extra?: Record<string, unknown>) =>
  new AppError('conflict', 409, message, extra);
export const forbidden = (message = 'Forbidden') => new AppError('forbidden', 403, message);
