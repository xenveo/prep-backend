// Transactional email contract. Templates are rendered before the adapter is called.

export const MAIL_ADAPTER = Symbol('MAIL_ADAPTER');

export type MailMessage = {
  to: string;
  from: string;
  replyTo?: string;
  subject: string;
  text: string;
  html: string;
  /** Provider-side dedupe for retries (Resend keeps it 24 h). SES's SendEmail has no equivalent, so it ignores this. */
  idempotencyKey?: string;
};

export interface MailAdapter {
  readonly provider: string;
  send(message: MailMessage): Promise<{ messageId: string }>;
}
