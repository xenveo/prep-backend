import { Logger } from '@nestjs/common';
import { Resend, type ErrorResponse } from 'resend';
import { PermanentJobError } from '../../common/queue/queue.types.js';
import type { ConsoleMailAdapter } from './console-mail.adapter.js';
import type { MailAdapter, MailMessage } from './mail.adapter.js';

type ResendEmails = Pick<Resend['emails'], 'send'>;

/** Requests Resend has judged invalid: they fail the same way on every retry (e.g. an unverified sending domain). */
const PERMANENT = new Set<string>([
  'validation_error',
  'invalid_parameter',
  'missing_required_field',
  'invalid_from_address',
  'invalid_attachment',
  'not_found',
  'method_not_allowed',
  'missing_api_key',
  'invalid_api_key',
  'restricted_api_key',
  'invalid_access',
  'invalid_region',
  'security_error',
  'invalid_idempotency_key',
  'invalid_idempotent_request',
] satisfies ErrorResponse['name'][]);

/** Rate limits, quotas and server faults. The SDK also reports a failed fetch as `application_error`. */
const RETRYABLE = new Set<string>([
  'rate_limit_exceeded',
  'daily_quota_exceeded',
  'monthly_quota_exceeded',
  'concurrent_idempotent_requests',
  'application_error',
  'internal_server_error',
] satisfies ErrorResponse['name'][]);

export function isRetryable(error: ErrorResponse): boolean {
  if (PERMANENT.has(error.name)) return false;
  if (RETRYABLE.has(error.name)) return true;
  // An error name this SDK version doesn't know: a transient fault is the likelier cause.
  return !/invalid|forbidden|unauthorized/i.test(error.message);
}

/** Exact addresses or `@domain` entries (lowercase); an empty list allows everyone. */
export function isAllowlisted(to: string, allowlist: string[]): boolean {
  if (!allowlist.length) return true;
  const address = to.trim().toLowerCase();
  const domain = `@${address.split('@').pop()}`;
  return allowlist.some((entry) =>
    entry.startsWith('@') ? entry === domain : entry === address,
  );
}

/**
 * Resend transport. With an allowlist (dev and test deploys) only allowlisted recipients get real
 * mail; the rest go to the console outbox. Logs message ids and error names only.
 */
export class ResendMailAdapter implements MailAdapter {
  readonly provider = 'resend';
  private readonly logger = new Logger(ResendMailAdapter.name);
  private readonly emails: ResendEmails;

  constructor(
    apiKey: string,
    private readonly allowlist: string[],
    private readonly outbox: ConsoleMailAdapter,
    emails?: ResendEmails,
  ) {
    this.emails = emails ?? new Resend(apiKey).emails;
  }

  async send(message: MailMessage): Promise<{ messageId: string }> {
    if (!isAllowlisted(message.to, this.allowlist)) {
      const { messageId } = await this.outbox.send(message);
      this.logger.log(`suppressed ${messageId}`);
      return { messageId };
    }

    const { data, error } = await this.emails.send(
      {
        from: message.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      },
      // Resend keeps the key for 24 h, so a retry after a lost response can't send twice.
      message.idempotencyKey
        ? { idempotencyKey: message.idempotencyKey.slice(0, 256) }
        : undefined,
    );

    if (error) {
      // Resend's message can quote the request, so only the name and status leave this adapter.
      const reason = `Resend ${error.name} (${error.statusCode ?? 'no response'})`;
      if (isRetryable(error)) {
        this.logger.warn(`send failed (retryable): ${error.name}`);
        throw new Error(reason);
      }
      this.logger.warn(`send failed (permanent): ${error.name}`);
      throw new PermanentJobError(reason);
    }

    this.logger.log(`sent ${data.id}`);
    return { messageId: data.id };
  }
}
