import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Module } from '@nestjs/common';
import { LoggerModule, type Params } from 'nestjs-pino';
import { AppConfig } from '../../config/app-config.js';

const REQUEST_ID = 'x-request-id';
const REQUEST_ID_PATTERN = /^[\w.-]{1,128}$/;

function requestId(req: IncomingMessage, res: ServerResponse): string {
  const incoming = req.headers[REQUEST_ID];
  const id =
    typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming)
      ? incoming
      : randomUUID();
  res.setHeader(REQUEST_ID, id);
  return id;
}

/** Path without the query string: queries can carry search terms (names, emails). */
const pathOf = (url: string | undefined) => (url ?? '').split('?')[0];

const PROBE_PATHS = new Set(['/api/health', '/api/ready']);

function loggerParams({ env }: AppConfig): Params {
  return {
    pinoHttp: {
      level: env.LOG_LEVEL,
      transport: env.LOG_PRETTY
        ? { target: 'pino-pretty', options: { singleLine: true } }
        : undefined,
      genReqId: requestId,
      // Probes poll these every few seconds; logging each request would drown the real traffic.
      autoLogging: { ignore: (req) => PROBE_PATHS.has(pathOf(req.url)) },
      // Ids, method and path only. Bodies are never logged; headers only through the redaction below.
      serializers: {
        req: (req: { id: unknown; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          path: pathOf(req.url),
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
      redact: {
        paths: [
          'req.headers.cookie',
          'req.headers.authorization',
          'res.headers["set-cookie"]',
          'headers.cookie',
          'headers.authorization',
        ],
        censor: '[redacted]',
      },
    },
  };
}

/** JSON logs via pino (pretty in dev with LOG_PRETTY=true). Never log transcripts, names or emails. */
@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: loggerParams,
    }),
  ],
})
export class LoggingModule {}
