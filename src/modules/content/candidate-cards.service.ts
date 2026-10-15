import { Injectable } from '@nestjs/common';
import { AppError, notFound } from '../../common/errors/app-error.js';
import type { FlashCard } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ActivityService } from '../activity/activity.service.js';
import { AssignmentsService } from '../users/assignments.service.js';
import { ContentQueryService } from './content-query.service.js';
import {
  toCandidateCard,
  type CandidateFlashCard,
} from './content.serializers.js';
import { TtsCacheService } from './tts-cache.service.js';

export const studiedAllText = (n: number) => `Studied ${n} of ${n} flash cards`;

/** Candidate flash-card study (FR-CARD-01..05). Roles not assigned or not approved are 404. */
@Injectable()
export class CandidateCardsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly assignments: AssignmentsService,
    private readonly activity: ActivityService,
    private readonly tts: TtsCacheService,
    private readonly content: ContentQueryService,
  ) {}

  /** Approved cards in set order, and the positions this candidate has viewed. */
  async list(
    userId: string,
    roleRef: string,
  ): Promise<{ cards: CandidateFlashCard[]; viewed: number[] }> {
    const { role } = await this.assignments.findCandidateRole(userId, roleRef);
    const cards = await this.prisma.flashCard.findMany({
      where: { jobRoleId: role.id, status: 'approved' },
      orderBy: { position: 'asc' },
      include: { views: { where: { userId }, select: { userId: true } } },
    });
    return {
      cards: cards.map(toCandidateCard),
      viewed: cards.filter((c) => c.views.length > 0).map((c) => c.position),
    };
  }

  /** Idempotent CardView. The first time every approved card is viewed, logs the activity once. */
  async view(userId: string, roleRef: string, position: number): Promise<void> {
    const { role } = await this.assignments.findCandidateRole(userId, roleRef);
    const card = await this.approvedCard(role.id, position);
    const { count: inserted } = await this.prisma.cardView.createMany({
      data: [{ userId, flashCardId: card.id }],
      skipDuplicates: true,
    });
    if (inserted === 0) return;
    const [total, viewed] = await Promise.all([
      this.content.approvedCardCount(role.id),
      this.content.viewedApprovedCardCount(userId, role.id),
    ]);
    if (viewed < total) return;
    const text = studiedAllText(total);
    const timeline = await this.activity.list(userId);
    if (!timeline.some((a) => a.text === text))
      await this.activity.record(userId, text);
  }

  /** Signed URL of the card question's speech (FR-CARD-05). */
  async audioUrl(
    userId: string,
    roleRef: string,
    position: number,
  ): Promise<string> {
    const { role } = await this.assignments.findCandidateRole(userId, roleRef);
    const card = await this.approvedCard(role.id, position);
    let key: string;
    try {
      ({ key } = await this.tts.getOrCreate(card.question));
    } catch {
      throw new AppError(
        'ai_unavailable',
        503,
        'Audio is unavailable right now. Read the card instead.',
      );
    }
    return this.tts.signedUrl(key);
  }

  private async approvedCard(
    jobRoleId: string,
    position: number,
  ): Promise<FlashCard> {
    const card = await this.prisma.flashCard.findFirst({
      where: { jobRoleId, position, status: 'approved' },
    });
    if (!card) throw notFound('Flash card not found');
    return card;
  }
}
