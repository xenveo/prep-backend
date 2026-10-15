import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { CsrfGuard } from './auth/csrf.guard.js';
import { RolesGuard } from './auth/roles.guard.js';
import { SessionGuard } from './auth/session.guard.js';
import { HttpExceptionFilter } from './errors/http-exception.filter.js';

/** Global HTTP plumbing. Guards run in registration order: CSRF, session, roles. */
@Global()
@Module({
  providers: [
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class CommonModule {}
