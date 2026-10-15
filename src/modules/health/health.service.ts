import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

export type HealthStatus = { status: 'ok'; db: 'ok' | 'error' };

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(private readonly prisma: PrismaService) {}

  async check(): Promise<HealthStatus> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', db: 'ok' };
    } catch (err) {
      this.logger.warn({ err }, 'Database health check failed');
      return { status: 'ok', db: 'error' };
    }
  }
}
