// Transactional email contract. Templates are rendered before the adapter is called.

export const MAIL_ADAPTER = Symbol('MAIL_ADAPTER');

export type MailMessage = {
  to: string;
  from: string;
  replyTo?: string;
  subject: string;
  text: string;
  html: string;
};

export interface MailAdapter {
  readonly provider: string;
  send(message: MailMessage): Promise<{ messageId: string }>;
}
