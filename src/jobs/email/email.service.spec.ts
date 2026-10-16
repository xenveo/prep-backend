import { ConsoleMailAdapter } from '../../adapters/mail/console-mail.adapter.js';
import type { QueueService } from '../../common/queue/queue.types.js';
import type { AppConfig } from '../../config/app-config.js';
import type { SettingsService } from '../../modules/settings/settings.service.js';
import { EmailProcessor, formatFrom, validReplyTo } from './email.processor.js';
import { EmailService } from './email.service.js';

function fakeQueue() {
  return {
    add: vi.fn().mockResolvedValue({ jobId: 'j1' }),
    process: vi.fn(),
  } as unknown as QueueService & {
    add: ReturnType<typeof vi.fn>;
    process: ReturnType<typeof vi.fn>;
  };
}

const config = {
  env: { MAIL_FROM: 'no-reply@preppilot.local', MAIL_RATE_PER_SECOND: 2 },
} as AppConfig;

function settingsWith(senderName: string, replyTo: string) {
  return {
    get: vi
      .fn()
      .mockResolvedValue({ senderName, replyTo, inviteLinkExpiryDays: 7 }),
  } as unknown as SettingsService;
}

describe('EmailService', () => {
  it('enqueues on the email queue with a unique id, 3 attempts and 2 s backoff', async () => {
    const queue = fakeQueue();
    const job = {
      template: 'login-code',
      to: 'a@example.com',
      vars: { code: '123456', minutes: 10 },
    } as const;
    await new EmailService(queue).send(job);
    expect(queue.add).toHaveBeenCalledWith('email', job, {
      jobId: expect.stringMatching(/^email-[0-9a-f-]{36}$/),
      attempts: 3,
      backoffMs: 2000,
    });
  });
});

describe('EmailProcessor', () => {
  it('registers the email processor on init, limited to the provider send rate', () => {
    const queue = fakeQueue();
    new EmailProcessor(
      queue,
      new ConsoleMailAdapter(),
      settingsWith('PrepPilot', ''),
      config,
    ).onModuleInit();
    expect(queue.process).toHaveBeenCalledWith('email', expect.any(Function), {
      limiter: { max: 2, durationMs: 1000 },
    });
  });

  it('passes the job id as the idempotency key', async () => {
    const queue = fakeQueue();
    const mail = new ConsoleMailAdapter();
    new EmailProcessor(
      queue,
      mail,
      settingsWith('PrepPilot', ''),
      config,
    ).onModuleInit();
    const handler = queue.process.mock.calls[0][1];
    await handler(
      { template: 'erasure-complete', to: 'c@example.com', vars: {} },
      { jobId: 'job-42', attempt: 1 },
    );
    expect(mail.lastTo('c@example.com')!.idempotencyKey).toBe('job-42');
  });

  it('renders the template and sends with sender name and reply-to from settings', async () => {
    const mail = new ConsoleMailAdapter();
    const processor = new EmailProcessor(
      fakeQueue(),
      mail,
      settingsWith('PrepPilot for Acme', 'help@acme.com'),
      config,
    );
    await processor.handle(
      {
        template: 'login-code',
        to: 'a@example.com',
        vars: { code: '654321', minutes: 10 },
      },
      'j1',
    );
    const sent = mail.lastTo('a@example.com')!;
    expect(sent.from).toBe('"PrepPilot for Acme" <no-reply@preppilot.local>');
    expect(sent.replyTo).toBe('help@acme.com');
    expect(sent.text).toContain('654321');
  });

  it('drops a placeholder reply-to', async () => {
    const mail = new ConsoleMailAdapter();
    const processor = new EmailProcessor(
      fakeQueue(),
      mail,
      settingsWith('PrepPilot', '[reply-to@company.com]'),
      config,
    );
    await processor.handle(
      { template: 'erasure-complete', to: 'b@example.com', vars: {} },
      'j2',
    );
    expect(mail.lastTo('b@example.com')!.replyTo).toBeUndefined();
  });
});

describe('formatFrom / validReplyTo', () => {
  it('quotes the display name and strips header-breaking characters', () => {
    expect(formatFrom('PrepPilot for [Company]', 'x@y.z')).toBe(
      '"PrepPilot for [Company]" <x@y.z>',
    );
    expect(formatFrom('Evil"\r\nBcc: a@b.c', 'x@y.z')).toBe(
      '"EvilBcc: a@b.c" <x@y.z>',
    );
    expect(formatFrom('  ', 'x@y.z')).toBe('x@y.z');
  });

  it('takes only the address from a named MAIL_FROM, falling back to its name', () => {
    const named = 'Xenveo <noreply@emails.xenveo.com>';
    expect(formatFrom('PrepPilot', named)).toBe(
      '"PrepPilot" <noreply@emails.xenveo.com>',
    );
    expect(formatFrom('', named)).toBe('"Xenveo" <noreply@emails.xenveo.com>');
    expect(formatFrom('', '"Xenveo Mail" <noreply@emails.xenveo.com>')).toBe(
      '"Xenveo Mail" <noreply@emails.xenveo.com>',
    );
    expect(formatFrom('', '<noreply@emails.xenveo.com>')).toBe(
      'noreply@emails.xenveo.com',
    );
  });

  it('accepts only plain addresses', () => {
    expect(validReplyTo('help@acme.com')).toBe('help@acme.com');
    expect(validReplyTo('[reply-to@company.com]')).toBeUndefined();
    expect(validReplyTo('')).toBeUndefined();
    expect(validReplyTo(undefined)).toBeUndefined();
  });
});
