import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Prisma } from '../../generated/prisma/client.js';
import { AppError, type ErrorCode } from './app-error.js';

export type ErrorBody = {
  error: { code: ErrorCode; message: string };
} & Record<string, unknown>;

const HTTP_CODES: Record<number, ErrorCode> = {
  400: 'validation_failed',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  410: 'gone',
  413: 'validation_failed',
  429: 'rate_limited',
};

function httpExceptionMessage(e: HttpException): string {
  const res = e.getResponse();
  if (typeof res === 'string') return res;
  const msg = (res as { message?: unknown }).message;
  if (Array.isArray(msg)) return msg.join('; ');
  return typeof msg === 'string' ? msg : e.message;
}

/** Maps any thrown value to `{status, body}` in the spec's error shape. Returns null for unknown errors (500). */
export function toErrorResponse(
  e: unknown,
): { status: number; body: ErrorBody } | null {
  if (e instanceof AppError) {
    return {
      status: e.status,
      body: { ...e.extra, error: { code: e.code, message: e.message } },
    };
  }
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    if (e.code === 'P2002')
      return {
        status: 409,
        body: { error: { code: 'conflict', message: 'Already exists' } },
      };
    if (e.code === 'P2025')
      return {
        status: 404,
        body: { error: { code: 'not_found', message: 'Not found' } },
      };
    return null;
  }
  if (e instanceof HttpException) {
    const status = e.getStatus();
    const code =
      HTTP_CODES[status] ?? (status >= 500 ? 'internal' : 'validation_failed');
    const message =
      status >= 500 ? 'Something went wrong' : httpExceptionMessage(e);
    return { status, body: { error: { code, message } } };
  }
  return null;
}

/** Global filter (registered as APP_FILTER in CommonModule). HTTP only; the WS gateway handles its own errors. */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') return;
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request & { id?: unknown }>();
    const res = ctx.getResponse<Response>();

    let mapped = toErrorResponse(exception);
    if (!mapped || mapped.status >= 500) {
      const err =
        exception instanceof Error ? exception : new Error(String(exception));
      // Request id, route and error only: no bodies, headers or personal data.
      this.logger.error(
        {
          reqId: req.id,
          method: req.method,
          path: req.route?.path ?? req.path,
          err,
        },
        'Unhandled error',
      );
      mapped ??= {
        status: 500,
        body: { error: { code: 'internal', message: 'Something went wrong' } },
      };
    }
    if (res.headersSent) return;
    res.status(mapped.status).json(mapped.body);
  }
}
