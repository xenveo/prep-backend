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

const config = { env: { MAIL_FROM: 'no-reply@preppilot.local' } } as AppConfig;

function settingsWith(senderName: string, replyTo: string) {
  return {
    get: vi
      .fn()
      .mockResolvedValue({ senderName, replyTo, inviteLinkExpiryDays: 7 }),
  } as unknown as SettingsService;
}

describe('EmailService', () => {
  it('enqueues on the email queue with 3 attempts and 2 s backoff', async () => {
    const queue = fakeQueue();
    const job = {
      template: 'login-code',
      to: 'a@example.com',
      vars: { code: '123456', minutes: 10 },
    } as const;
    await new EmailService(queue).send(job);
    expect(queue.add).toHaveBeenCalledWith('email', job, {
      attempts: 3,
      backoffMs: 2000,
    });
  });
});

describe('EmailProcessor', () => {
  it('registers the email processor on init', () => {
    const queue = fakeQueue();
    new EmailProcessor(
      queue,
      new ConsoleMailAdapter(),
      settingsWith('PrepPilot', ''),
      config,
    ).onModuleInit();
    expect(queue.process).toHaveBeenCalledWith('email', expect.any(Function));
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

  it('accepts only plain addresses', () => {
    expect(validReplyTo('help@acme.com')).toBe('help@acme.com');
    expect(validReplyTo('[reply-to@company.com]')).toBeUndefined();
    expect(validReplyTo('')).toBeUndefined();
    expect(validReplyTo(undefined)).toBeUndefined();
  });
});
