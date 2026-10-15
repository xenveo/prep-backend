import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { AppConfig } from '../../config/app-config.js';
import { forbidden } from '../errors/app-error.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Global guard: state-changing requests from a browser must come from one of our origins.
 * Requests with neither Origin nor Referer (non-browser clients) pass; SameSite=Lax covers the rest.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly allowed: Set<string>;

  constructor(config: AppConfig) {
    const { APP_CANDIDATE_ORIGIN, APP_ADMIN_ORIGIN, PUBLIC_API_URL } =
      config.env;
    this.allowed = new Set(
      [APP_CANDIDATE_ORIGIN, APP_ADMIN_ORIGIN, PUBLIC_API_URL]
        .map(originOf)
        .filter((o): o is string => !!o),
    );
  }

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method)) return true;
    const origin = req.headers.origin;
    const referer = req.headers.referer;
    const source = origin
      ? originOf(origin)
      : referer
        ? originOf(referer)
        : undefined;
    if (source === undefined) return true;
    if (!source || !this.allowed.has(source))
      throw forbidden('Cross-site request blocked');
    return true;
  }
}
