import { Body, Controller, Get, Param, Patch, Redirect } from '@nestjs/common';
import type { AuthUser } from '../../common/auth/auth.types.js';
import {
  ClientIp,
  CurrentUser,
} from '../../common/auth/current-user.decorator.js';
import { Roles } from '../../common/auth/roles.decorator.js';
import { ZodPipe } from '../../common/validation/zod.pipe.js';
import { SettingsAdminService } from './settings-admin.service.js';
import {
  settingsPatchSchema,
  type AdminWorkspaceSettings,
  type SettingsPatch,
} from './settings.schema.js';

@Controller('admin/settings')
@Roles('admin', 'super_admin')
export class SettingsController {
  constructor(private readonly service: SettingsAdminService) {}

  @Get()
  get(): Promise<AdminWorkspaceSettings> {
    return this.service.view();
  }

  /** Super admin only: AI and voice, privacy and email settings (spec "UI vs SRS gaps"). */
  @Patch()
  @Roles('super_admin')
  update(
    @Body(new ZodPipe(settingsPatchSchema)) body: SettingsPatch,
    @CurrentUser() user: AuthUser,
    @ClientIp() ip: string,
  ): Promise<AdminWorkspaceSettings> {
    return this.service.update(body, user.id, ip);
  }

  /** "Play sample": redirects to a short-lived signed URL of the sample audio. */
  @Get('voices/:voice/sample')
  @Redirect()
  async voiceSample(
    @Param('voice') voice: string,
  ): Promise<{ url: string; statusCode: number }> {
    return { url: await this.service.voiceSampleUrl(voice), statusCode: 302 };
  }
}
