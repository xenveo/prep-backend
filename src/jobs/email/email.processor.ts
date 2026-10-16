import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  MAIL_ADAPTER,
  type MailAdapter,
} from '../../adapters/mail/mail.adapter.js';
import {
  QUEUE_SERVICE,
  type QueueService,
} from '../../common/queue/queue.types.js';
import { AppConfig } from '../../config/app-config.js';
import { SettingsService } from '../../modules/settings/settings.service.js';
import { renderEmail, type EmailJob } from './templates/templates.js';

const PLAIN_EMAIL = /^[^\s@<>[\]",;]+@[^\s@<>[\]",;]+\.[^\s@<>[\]",;]+$/;

const NAMED_ADDRESS = /^(.*)<([^<>]+)>\s*$/;

/**
 * `"Sender Name" <address>`, with the display name quoted and stripped of header-breaking
 * characters. `mailFrom` may be a bare address or `Name <address>`; the address always comes from
 * it, and the name from `senderName` when set, else from `mailFrom`.
 */
export function formatFrom(senderName: string, mailFrom: string): string {
  const named = NAMED_ADDRESS.exec(mailFrom);
  const address = named ? named[2].trim() : mailFrom.trim();
  const clean = (s: string) => s.replace(/[\r\n"\\]/g, '').trim();
  const name = clean(senderName) || clean(named?.[1] ?? '');
  return name ? `"${name}" <${address}>` : address;
}

/** Workspace reply-to, only when it is a plain address (the fixture placeholder "[reply-to@company.com]" is not). */
export function validReplyTo(
  replyTo: string | null | undefined,
): string | undefined {
  const value = replyTo?.trim();
  return value && PLAIN_EMAIL.test(value) ? value : undefined;
}

@Injectable()
export class EmailProcessor implements OnModuleInit {
  private readonly logger = new Logger(EmailProcessor.name);

  constructor(
    @Inject(QUEUE_SERVICE) private readonly queue: QueueService,
    @Inject(MAIL_ADAPTER) private readonly mail: MailAdapter,
    private readonly settings: SettingsService,
    private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.queue.process<EmailJob, void>(
      'email',
      (job, meta) => this.handle(job, meta.jobId),
      {
        limiter: {
          max: this.config.env.MAIL_RATE_PER_SECOND,
          durationMs: 1000,
        },
      },
    );
  }

  async handle(job: EmailJob, jobId: string): Promise<void> {
    const settings = await this.settings.get();
    const rendered = renderEmail(job.template, job.vars);
    const { messageId } = await this.mail.send({
      to: job.to,
      from: formatFrom(settings.senderName, this.config.env.MAIL_FROM),
      replyTo: validReplyTo(settings.replyTo),
      ...rendered,
      idempotencyKey: jobId,
    });
    this.logger.log(
      `Email job ${jobId} (${job.template}) sent as ${messageId}`,
    );
  }
}
