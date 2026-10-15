import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthedRequest, AuthUser } from './auth.types.js';

/** The authenticated user. Only valid on non-public routes. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const user = ctx.switchToHttp().getRequest<AuthedRequest>().user;
    if (!user)
      throw new Error(
        'CurrentUser used on a route without an authenticated user',
      );
    return user;
  },
);

/** Client IP as Express resolves it (honours the app's `trust proxy` setting). */
export const ClientIp = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string =>
    ctx.switchToHttp().getRequest<AuthedRequest>().ip ?? 'unknown',
);
