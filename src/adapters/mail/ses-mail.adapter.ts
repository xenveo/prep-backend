import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { Logger } from '@nestjs/common';
import type { MailAdapter, MailMessage } from './mail.adapter.js';

type SesClient = Pick<SESv2Client, 'send'>;

export class SesMailAdapter implements MailAdapter {
  readonly provider = 'ses';
  private readonly logger = new Logger(SesMailAdapter.name);
  private readonly client: SesClient;

  constructor(region: string, client?: SesClient) {
    this.client = client ?? new SESv2Client({ region });
  }

  async send(message: MailMessage): Promise<{ messageId: string }> {
    const out = await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: message.from,
        Destination: { ToAddresses: [message.to] },
        ReplyToAddresses: message.replyTo ? [message.replyTo] : undefined,
        Content: {
          Simple: {
            Subject: { Data: message.subject, Charset: 'UTF-8' },
            Body: {
              Text: { Data: message.text, Charset: 'UTF-8' },
              Html: { Data: message.html, Charset: 'UTF-8' },
            },
          },
        },
      }),
    );
    const messageId = out.MessageId ?? '';
    this.logger.log(`Sent email ${messageId}`);
    return { messageId };
  }
}
