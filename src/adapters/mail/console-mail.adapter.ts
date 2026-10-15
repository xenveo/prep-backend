import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import type { MailAdapter, MailMessage } from './mail.adapter.js';

const OUTBOX_LIMIT = 50;

/**
 * Dev and test mail. Keeps the last 50 messages in memory (`outbox`) for tests; with `writeDir`
 * set (development) it also writes each message as an .eml file so devs can read login codes.
 * Logs only the message id.
 */
export class ConsoleMailAdapter implements MailAdapter {
  readonly provider = 'console';
  readonly outbox: (MailMessage & { messageId: string })[] = [];
  private readonly logger = new Logger(ConsoleMailAdapter.name);

  constructor(private readonly writeDir?: string) {}

  async send(message: MailMessage): Promise<{ messageId: string }> {
    const messageId = randomUUID();
    this.outbox.push({ ...message, messageId });
    if (this.outbox.length > OUTBOX_LIMIT)
      this.outbox.splice(0, this.outbox.length - OUTBOX_LIMIT);
    if (this.writeDir) {
      await mkdir(this.writeDir, { recursive: true });
      await writeFile(
        join(this.writeDir, `${Date.now()}-${messageId}.eml`),
        toEml(message, messageId),
      );
    }
    this.logger.log(`Queued email ${messageId} to the local outbox`);
    return { messageId };
  }

  /** Most recent message to an address, for tests. */
  lastTo(to: string): MailMessage | undefined {
    const wanted = to.toLowerCase();
    return [...this.outbox]
      .reverse()
      .find((m) => m.to.toLowerCase() === wanted);
  }
}

function toEml(m: MailMessage, messageId: string): string {
  const boundary = `b-${messageId}`;
  return [
    `Message-ID: <${messageId}@preppilot.local>`,
    `From: ${m.from}`,
    `To: ${m.to}`,
    ...(m.replyTo ? [`Reply-To: ${m.replyTo}`] : []),
    `Subject: ${m.subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    m.text,
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    '',
    m.html,
    `--${boundary}--`,
    '',
  ].join('\r\n');
}
