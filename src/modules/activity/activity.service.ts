import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

export type ActivityItem = { text: string; at: string };

/** Per-user activity timeline (admin candidate detail). The text may hold personal data: never log it. */
@Injectable()
export class ActivityService {
  constructor(private readonly prisma: PrismaService) {}

  async record(
    userId: string,
    text: string,
    at: Date = new Date(),
  ): Promise<void> {
    await this.prisma.activityEvent.create({ data: { userId, text, at } });
  }

  async list(userId: string): Promise<ActivityItem[]> {
    const rows = await this.prisma.activityEvent.findMany({
      where: { userId },
      orderBy: { at: 'desc' },
      select: { text: true, at: true },
    });
    return rows.map((r) => ({ text: r.text, at: r.at.toISOString() }));
  }
}
