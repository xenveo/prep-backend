import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import type { AuthUser } from '../../common/auth/auth.types.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Roles } from '../../common/auth/roles.decorator.js';
import { PrivacyService } from './privacy.service.js';

/** Candidate privacy rights (NFR-06): export my data, ask for deletion. */
@Controller('me')
@Roles('candidate')
export class PrivacyController {
  constructor(private readonly service: PrivacyService) {}

  /** The JSON bundle is built asynchronously and emailed as a 24 h link. */
  @Get('export')
  @HttpCode(202)
  export(@CurrentUser() user: AuthUser): Promise<{ requestId: string }> {
    return this.service.requestExport(user.id);
  }

  @Post('deletion-request')
  @HttpCode(202)
  requestDeletion(
    @CurrentUser() user: AuthUser,
  ): Promise<{ requestId: string }> {
    return this.service.requestDeletion(user.id);
  }
}
