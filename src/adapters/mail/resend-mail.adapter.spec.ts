import { Logger } from '@nestjs/common';
import { PermanentJobError } from '../../common/queue/queue.types.js';
import type { Env } from '../../config/env.js';
import { createMailAdapter } from '../adapters.module.js';
import { ConsoleMailAdapter } from './console-mail.adapter.js';
import type { MailMessage } from './mail.adapter.js';
import { isAllowlisted, ResendMailAdapter } from './resend-mail.adapter.js';

const msg = (to: string, idempotencyKey?: string): MailMessage => ({
  to,
  from: '"PrepPilot" <noreply@emails.xenveo.com>',
  replyTo: 'help@example.com',
  subject: 'Your code',
  text: 'Body',
  html: '<p>Body</p>',
  idempotencyKey,
});

function setup(
  result: unknown,
  allowlist: string[] = [],
): {
  adapter: ResendMailAdapter;
  outbox: ConsoleMailAdapter;
  send: ReturnType<typeof vi.fn>;
} {
  const send =
    result instanceof Error
      ? vi.fn().mockRejectedValue(result)
      : vi.fn().mockResolvedValue(result);
  const outbox = new ConsoleMailAdapter();
  const adapter = new ResendMailAdapter('re_test', allowlist, outbox, {
    send,
  } as never);
  return { adapter, outbox, send };
}

const ok = (id: string) => ({ data: { id }, error: null, headers: null });
const fail = (name: string, statusCode: number | null, message = 'nope') => ({
  data: null,
  error: { name, statusCode, message },
  headers: null,
});

describe('ResendMailAdapter', () => {
  let logged: string[];

  beforeEach(() => {
    logged = [];
    for (const level of ['log', 'warn', 'error', 'debug'] as const)
      vi.spyOn(Logger.prototype, level).mockImplementation(
        (message: unknown) => {
          logged.push(String(message));
        },
      );
  });

  afterEach(() => vi.restoreAllMocks());

  it('sends, passes the idempotency key as the second argument and returns the id', async () => {
    const { adapter, send } = setup(ok('re-1'));
    const r = await adapter.send(msg('a@example.com', 'job-1'));
    expect(r).toEqual({ messageId: 're-1' });
    expect(send).toHaveBeenCalledWith(
      {
        from: '"PrepPilot" <noreply@emails.xenveo.com>',
        to: 'a@example.com',
        subject: 'Your code',
        html: '<p>Body</p>',
        text: 'Body',
        replyTo: 'help@example.com',
      },
      { idempotencyKey: 'job-1' },
    );
    expect(logged).toContain('sent re-1');
  });

  it('omits the request options without a key and caps the key at 256 chars', async () => {
    const { adapter, send } = setup(ok('re-2'));
    await adapter.send(msg('a@example.com'));
    expect(send.mock.calls[0][1]).toBeUndefined();
    await adapter.send(msg('a@example.com', 'k'.repeat(300)));
    expect(send.mock.calls[1][1]).toEqual({ idempotencyKey: 'k'.repeat(256) });
  });

  it.each([
    ['validation_error', 422],
    ['invalid_from_address', 422],
    ['invalid_api_key', 403],
    ['restricted_api_key', 401],
  ])('%s is permanent', async (name, status) => {
    const { adapter } = setup(fail(name, status));
    await expect(adapter.send(msg('a@example.com'))).rejects.toBeInstanceOf(
      PermanentJobError,
    );
  });

  it.each([
    ['rate_limit_exceeded', 429],
    ['internal_server_error', 500],
    ['application_error', 500],
    // What the SDK returns when fetch itself fails.
    ['application_error', null],
  ])('%s (%s) is retryable', async (name, status) => {
    const { adapter } = setup(fail(name, status));
    const err = await adapter.send(msg('a@example.com')).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PermanentJobError);
  });

  it('lets a thrown network error through as retryable', async () => {
    const { adapter } = setup(new TypeError('fetch failed'));
    const err = await adapter.send(msg('a@example.com')).catch((e) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(err).not.toBeInstanceOf(PermanentJobError);
  });

  it('keeps the provider message out of errors and logs', async () => {
    const { adapter } = setup(
      fail('validation_error', 422, 'Invalid `to` field: a@example.com'),
    );
    const err = await adapter.send(msg('a@example.com')).catch((e) => e);
    expect(err.message).toBe('Resend validation_error (422)');
    expect(logged).toEqual(['send failed (permanent): validation_error']);
  });

  it('sends allowlisted addresses and domains; routes the rest to the outbox', async () => {
    const { adapter, outbox, send } = setup(ok('re-3'), [
      'tester@gmail.com',
      '@xenveo.com',
    ]);
    await adapter.send(msg('Tester@Gmail.com'));
    await adapter.send(msg('dev@xenveo.com'));
    expect(send).toHaveBeenCalledTimes(2);

    const r = await adapter.send(msg('candidate@example.com'));
    expect(send).toHaveBeenCalledTimes(2);
    expect(outbox.lastTo('candidate@example.com')?.subject).toBe('Your code');
    expect(r.messageId).toBe(outbox.outbox[0].messageId);
    expect(logged).toContain(`suppressed ${r.messageId}`);
  });

  it('never logs the recipient', async () => {
    const to = 'secret.person@example.com';
    await setup(ok('re-4')).adapter.send(msg(to));
    await setup(fail('validation_error', 422, to))
      .adapter.send(msg(to))
      .catch(() => undefined);
    await setup(fail('rate_limit_exceeded', 429, to))
      .adapter.send(msg(to))
      .catch(() => undefined);
    await setup(ok('re-5'), ['@xenveo.com']).adapter.send(msg(to));
    expect(logged.length).toBeGreaterThanOrEqual(4);
    for (const line of logged) expect(line).not.toContain('secret.person');
  });
});

describe('isAllowlisted', () => {
  it('allows everyone when empty', () => {
    expect(isAllowlisted('a@example.com', [])).toBe(true);
  });

  it('matches exact addresses and whole domains, case-insensitively', () => {
    const list = ['qa@example.com', '@xenveo.com'];
    expect(isAllowlisted('QA@Example.com', list)).toBe(true);
    expect(isAllowlisted('anyone@XENVEO.com', list)).toBe(true);
    expect(isAllowlisted('other@example.com', list)).toBe(false);
    expect(isAllowlisted('a@notxenveo.com', list)).toBe(false);
    expect(isAllowlisted('a@mail.xenveo.com', list)).toBe(false);
  });
});

describe('createMailAdapter', () => {
  const env = (over: Partial<Env>) =>
    ({
      NODE_ENV: 'test',
      MAIL_PROVIDER: 'console',
      MAIL_ALLOWLIST: [],
      LOCAL_STORAGE_DIR: '/tmp/unused',
      SES_REGION: 'ap-south-1',
      ...over,
    }) as Env;

  it('requires RESEND_API_KEY for the resend provider', () => {
    expect(() => createMailAdapter(env({ MAIL_PROVIDER: 'resend' }))).toThrow(
      'RESEND_API_KEY is required',
    );
    expect(
      createMailAdapter(
        env({ MAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test' }),
      ).provider,
    ).toBe('resend');
  });

  it('defaults to the console outbox', () => {
    expect(createMailAdapter(env({})).provider).toBe('console');
  });
});
