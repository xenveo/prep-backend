import { Injectable } from '@nestjs/common';
import type { Question } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

export type ApprovedQuestion = Question & {
  card: { position: number } | null;
};

/** Read-only content queries for downstream modules (interview, reports). */
@Injectable()
export class ContentQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /** Approved questions of a role, oldest first, with their linked card's position. */
  listApprovedQuestions(jobRoleId: string): Promise<ApprovedQuestion[]> {
    return this.prisma.question.findMany({
      where: { jobRoleId, status: 'approved' },
      include: { card: { select: { position: true } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  approvedCardCount(jobRoleId: string): Promise<number> {
    return this.prisma.flashCard.count({
      where: { jobRoleId, status: 'approved' },
    });
  }

  /** Approved cards of the role that the user has viewed. */
  viewedApprovedCardCount(userId: string, jobRoleId: string): Promise<number> {
    return this.prisma.cardView.count({
      where: { userId, card: { jobRoleId, status: 'approved' } },
    });
  }
}
