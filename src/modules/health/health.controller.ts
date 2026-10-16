import { Controller, Get, Header, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../../common/auth/public.decorator.js';
import { HealthService, type ReadyStatus } from './health.service.js';

@Controller()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** Liveness: 200 while the process is up, whatever the dependencies report. */
  @Public()
  @Get('health')
  check() {
    return this.health.check();
  }

  /** Readiness for load balancers: 200 when DB, Redis (if configured) and storage answer, else 503. */
  @Public()
  @Get('ready')
  @Header('Cache-Control', 'no-store')
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadyStatus> {
    const status = await this.health.ready();
    res.status(status.status === 'ready' ? 200 : 503);
    return status;
  }
}
