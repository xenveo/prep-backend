import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SendEmailCommand } from '@aws-sdk/client-sesv2';
import { ConsoleMailAdapter } from './console-mail.adapter.js';
import type { MailMessage } from './mail.adapter.js';
import { SesMailAdapter } from './ses-mail.adapter.js';

const msg = (to: string): MailMessage => ({
  to,
  from: 'PrepPilot <no-reply@preppilot.local>',
  replyTo: 'help@example.com',
  subject: 'Hello',
  text: 'Body',
  html: '<p>Body</p>',
});

describe('ConsoleMailAdapter', () => {
  it('keeps only the last 50 messages', async () => {
    const mail = new ConsoleMailAdapter();
    for (let i = 0; i < 55; i++) await mail.send(msg(`u${i}@example.com`));
    expect(mail.outbox).toHaveLength(50);
    expect(mail.outbox[0].to).toBe('u5@example.com');
    expect(mail.lastTo('U54@example.com')?.subject).toBe('Hello');
  });

  it('writes .eml files when a directory is given', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'outbox-'));
    try {
      const mail = new ConsoleMailAdapter(dir);
      const { messageId } = await mail.send(msg('a@example.com'));
      const files = await readdir(dir);
      expect(files).toHaveLength(1);
      expect(files[0]).toContain(messageId);
      const eml = await readFile(join(dir, files[0]), 'utf8');
      expect(eml).toContain('Subject: Hello');
      expect(eml).toContain('Reply-To: help@example.com');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('SesMailAdapter', () => {
  it('sends a simple message and returns the SES id', async () => {
    const send = vi.fn().mockResolvedValue({ MessageId: 'ses-1' });
    const ses = new SesMailAdapter('ap-south-1', { send } as never);
    const r = await ses.send(msg('a@example.com'));
    expect(r.messageId).toBe('ses-1');
    const cmd = send.mock.calls[0][0] as SendEmailCommand;
    expect(cmd.input.Destination?.ToAddresses).toEqual(['a@example.com']);
    expect(cmd.input.ReplyToAddresses).toEqual(['help@example.com']);
    expect(cmd.input.Content?.Simple?.Body?.Html?.Data).toBe('<p>Body</p>');
  });
});
