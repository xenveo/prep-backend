import { Body, Controller, Get, HttpCode, Post, Res } from '@nestjs/common';
import type { CookieOptions, Response } from 'express';
import { type AuthUser, SESSION_COOKIE } from '../../common/auth/auth.types.js';
import {
  ClientIp,
  CurrentUser,
} from '../../common/auth/current-user.decorator.js';
import { Public } from '../../common/auth/public.decorator.js';
import { Roles } from '../../common/auth/roles.decorator.js';
import { ZodPipe } from '../../common/validation/zod.pipe.js';
import { AppConfig } from '../../config/app-config.js';
import {
  type AdminMeResponse,
  type MeResponse,
  type RequestCodeBody,
  type RequestCodeResponse,
  requestCodeSchema,
  type VerifyBody,
  type VerifyResult,
  verifySchema,
} from './auth.schemas.js';
import { AuthService } from './auth.service.js';

@Controller()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: AppConfig,
  ) {}

  @Public()
  @Post('auth/code')
  @HttpCode(200)
  requestCode(
    @Body(new ZodPipe(requestCodeSchema)) body: RequestCodeBody,
    @ClientIp() ip: string,
  ): Promise<RequestCodeResponse> {
    return this.auth.requestCode(body.email, ip);
  }

  @Public()
  @Post('auth/verify')
  @HttpCode(200)
  async verify(
    @Body(new ZodPipe(verifySchema)) body: VerifyBody,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ result: VerifyResult }> {
    const outcome = await this.auth.verify(body);
    if (outcome.result === 'ok') {
      res.cookie(SESSION_COOKIE, outcome.sessionToken, {
        ...this.cookieOptions(),
        maxAge: outcome.maxAgeMs,
      });
    }
    return { result: outcome.result };
  }

  @Post('auth/logout')
  @HttpCode(204)
  async logout(
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logout(user.authSessionId);
    res.clearCookie(SESSION_COOKIE, this.cookieOptions());
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser): Promise<MeResponse> {
    return this.auth.me(user);
  }

  @Roles('admin', 'super_admin')
  @Get('admin/me')
  adminMe(@CurrentUser() user: AuthUser): Promise<AdminMeResponse> {
    return this.auth.adminMe(user);
  }

  private cookieOptions(): CookieOptions {
    const env = this.config.env;
    return {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      ...(env.SESSION_COOKIE_DOMAIN
        ? { domain: env.SESSION_COOKIE_DOMAIN }
        : {}),
    };
  }
}
