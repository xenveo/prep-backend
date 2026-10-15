import {
  BadRequestException,
  Logger,
  ForbiddenException,
  NotFoundException,
  PayloadTooLargeException,
  UnauthorizedException,
} from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { AppError, conflict } from './app-error.js';
import {
  HttpExceptionFilter,
  toErrorResponse,
} from './http-exception.filter.js';

const prismaError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('db', {
    code,
    clientVersion: 'test',
  });

describe('toErrorResponse', () => {
  it('renders AppError with extra beside error', () => {
    expect(toErrorResponse(conflict('Busy', { sessionId: 's1' }))).toEqual({
      status: 409,
      body: { sessionId: 's1', error: { code: 'conflict', message: 'Busy' } },
    });
    expect(
      toErrorResponse(new AppError('access_expired', 403, 'Expired'))?.body,
    ).toEqual({
      error: { code: 'access_expired', message: 'Expired' },
    });
  });

  it('maps Prisma P2002 and P2025', () => {
    expect(toErrorResponse(prismaError('P2002'))).toMatchObject({
      status: 409,
      body: { error: { code: 'conflict' } },
    });
    expect(toErrorResponse(prismaError('P2025'))).toMatchObject({
      status: 404,
      body: { error: { code: 'not_found' } },
    });
    expect(toErrorResponse(prismaError('P1001'))).toBeNull();
  });

  it('maps Nest HttpExceptions', () => {
    expect(toErrorResponse(new NotFoundException())?.body.error.code).toBe(
      'not_found',
    );
    expect(toErrorResponse(new UnauthorizedException())?.body.error.code).toBe(
      'unauthenticated',
    );
    expect(toErrorResponse(new ForbiddenException())?.body.error.code).toBe(
      'forbidden',
    );
    expect(toErrorResponse(new BadRequestException('bad'))).toEqual({
      status: 400,
      body: { error: { code: 'validation_failed', message: 'bad' } },
    });
    expect(toErrorResponse(new PayloadTooLargeException())?.status).toBe(413);
    expect(
      toErrorResponse(new PayloadTooLargeException())?.body.error.code,
    ).toBe('validation_failed');
  });

  it('returns null for unknown errors', () => {
    expect(toErrorResponse(new Error('boom'))).toBeNull();
  });
});

describe('HttpExceptionFilter', () => {
  beforeEach(() =>
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined),
  );
  afterEach(() => vi.restoreAllMocks());

  function host() {
    const res = { headersSent: false, status: vi.fn(), json: vi.fn() };
    res.status.mockReturnValue(res);
    const req = { id: 'r1', method: 'GET', path: '/x' };
    const h = {
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    } as unknown as ArgumentsHost;
    return { h, res };
  }

  it('writes the mapped error', () => {
    const { h, res } = host();
    new HttpExceptionFilter().catch(new NotFoundException(), h);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'not_found', message: 'Not Found' },
    });
  });

  it('hides unknown errors behind a generic 500', () => {
    const { h, res } = host();
    new HttpExceptionFilter().catch(new Error('secret detail'), h);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'internal', message: 'Something went wrong' },
    });
  });
});
