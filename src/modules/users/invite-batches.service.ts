import { Injectable } from '@nestjs/common';
import { notFound } from '../../common/errors/app-error.js';
import { PrismaService } from '../../prisma/prisma.service.js';

export type InviteBatchStatus = {
  batchId: string;
  createdAt: string;
  source: string;
  fileName: string | null;
  createdBy: string;
  /** Historical invitation creation count, not a claim that email was delivered. */
  created: number;
  skipped: number;
  /** Current lifecycle for invitations belonging to candidates who have not been erased. */
  lifecycle: {
    pending: number;
    accepted: number;
    expired: number;
    revoked: number;
  };
  delivery: { status: 'unavailable'; reason: string };
};

/** Admin MCP batch read model (FR-ADM-01..03). Invitation creation is not mail delivery. */
@Injectable()
export class InviteBatchesService {
  constructor(private readonly prisma: PrismaService) {}

  async status(id: string): Promise<InviteBatchStatus> {
    const batch = await this.prisma.inviteBatch.findUnique({
      where: { id },
      select: {
        id: true,
        createdAt: true,
        source: true,
        fileName: true,
        createdBy: true,
        sent: true,
        skipped: true,
      },
    });
    if (!batch) throw notFound('Invite batch not found');

    // Invite is not automatically erasure-filtered by PrismaService. Keep the user filter
    // explicit here and never select email, invitation token hashes, or candidate identities.
    const invites = await this.prisma.invite.findMany({
      where: { batchId: id, user: { deletedAt: null } },
      select: { status: true, expiresAt: true },
    });
    const lifecycle = { pending: 0, accepted: 0, expired: 0, revoked: 0 };
    const now = new Date();
    for (const invite of invites) {
      const status =
        invite.status === 'pending' && invite.expiresAt <= now
          ? 'expired'
          : invite.status;
      lifecycle[status]++;
    }
    return {
      batchId: batch.id,
      createdAt: batch.createdAt.toISOString(),
      source: batch.source,
      fileName: batch.fileName,
      createdBy: batch.createdBy,
      created: batch.sent,
      skipped: batch.skipped,
      lifecycle,
      delivery: {
        status: 'unavailable',
        reason:
          'The batch records invitation creation. Email queue and provider delivery status are not tracked per invitation.',
      },
    };
  }
}
