import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service.js';
import {
  conflict,
  notFound,
  validationFailed,
} from '../../common/errors/app-error.js';
import type { FlashCard, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { FlashCardInput } from './content.schemas.js';
import { toAdminCard, type AdminFlashCard } from './content.serializers.js';
import { RolesService, type Actor } from './roles.service.js';

const ENTITY = 'flash_card';

/**
 * Sets each card's position to its index + 1. `(job_role_id, position)` is unique, so positions are
 * first moved out of the way (negated), then set.
 */
export async function renumberCards(
  tx: Prisma.TransactionClient,
  jobRoleId: string,
  orderedIds: string[],
): Promise<void> {
  await tx.$executeRaw`
    UPDATE "flash_cards" SET "position" = -"position" WHERE "job_role_id" = ${jobRoleId}::uuid`;
  for (const [i, id] of orderedIds.entries()) {
    await tx.flashCard.update({ where: { id }, data: { position: i + 1 } });
  }
}

/** Flash cards for admins (FR-ROLE-03/04, spec "Roles and content"). */
@Injectable()
export class CardsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly roles: RolesService,
    private readonly audit: AuditService,
  ) {}

  async list(roleId: string): Promise<AdminFlashCard[]> {
    await this.roles.getRow(roleId);
    const cards = await this.prisma.flashCard.findMany({
      where: { jobRoleId: roleId, status: { not: 'archived' } },
      orderBy: { position: 'asc' },
    });
    return cards.map(toAdminCard);
  }

  /** Admin-created cards are approved unless the input says otherwise; position is appended. */
  async create(
    roleId: string,
    input: FlashCardInput,
    actor: Actor,
  ): Promise<AdminFlashCard> {
    const card = await this.prisma.$transaction(async (tx) => {
      const role = await this.roles.getEditableRow(roleId, tx);
      const last = await tx.flashCard.aggregate({
        where: { jobRoleId: roleId },
        _max: { position: true },
      });
      const status = input.status ?? 'approved';
      const created = await tx.flashCard.create({
        data: {
          jobRoleId: roleId,
          position: (last._max.position ?? 0) + 1,
          category: input.category,
          question: input.question,
          strongAnswerPoints: input.strongAnswerPoints,
          sampleAnswerOutline: input.sampleAnswerOutline,
          commonMistakes: input.commonMistakes,
          tip: input.tip,
          status,
          createdBy: actor.id,
          ...(status === 'approved'
            ? { approvedBy: actor.id, approvedAt: new Date() }
            : {}),
        },
      });
      await this.roles.touch(roleId, actor.id, tx);
      await this.record('Added flash card', created, role.title, actor, tx);
      return created;
    });
    return toAdminCard(card);
  }

  async update(
    cardId: string,
    input: FlashCardInput,
    actor: Actor,
  ): Promise<AdminFlashCard> {
    const card = await this.prisma.$transaction(async (tx) => {
      const current = await this.getCard(cardId, tx);
      const role = await this.roles.getEditableRow(current.jobRoleId, tx);
      const approving =
        input.status === 'approved' && current.status !== 'approved';
      const updated = await tx.flashCard.update({
        where: { id: cardId },
        data: {
          category: input.category,
          question: input.question,
          strongAnswerPoints: input.strongAnswerPoints,
          sampleAnswerOutline: input.sampleAnswerOutline,
          commonMistakes: input.commonMistakes,
          tip: input.tip,
          ...(approving
            ? {
                status: 'approved',
                approvedBy: actor.id,
                approvedAt: new Date(),
              }
            : {}),
        },
      });
      await this.roles.touch(role.id, actor.id, tx);
      await this.record(
        approving ? 'Approved flash card' : 'Edited flash card',
        updated,
        role.title,
        actor,
        tx,
      );
      return updated;
    });
    return toAdminCard(card);
  }

  async approve(cardId: string, actor: Actor): Promise<AdminFlashCard> {
    const card = await this.prisma.$transaction(async (tx) => {
      const current = await this.getCard(cardId, tx);
      const role = await this.roles.getEditableRow(current.jobRoleId, tx);
      if (current.status === 'approved') return current;
      const updated = await tx.flashCard.update({
        where: { id: cardId },
        data: {
          status: 'approved',
          approvedBy: actor.id,
          approvedAt: new Date(),
        },
      });
      await this.roles.touch(role.id, actor.id, tx);
      await this.record('Approved flash card', updated, role.title, actor, tx);
      return updated;
    });
    return toAdminCard(card);
  }

  /** Must list every card of the role exactly once. */
  async reorder(
    roleId: string,
    orderedIds: string[],
    actor: Actor,
  ): Promise<AdminFlashCard[]> {
    await this.prisma.$transaction(async (tx) => {
      const role = await this.roles.getEditableRow(roleId, tx);
      const current = await tx.flashCard.findMany({
        where: { jobRoleId: roleId },
        select: { id: true },
      });
      const ids = new Set(current.map((c) => c.id));
      if (
        orderedIds.length !== ids.size ||
        new Set(orderedIds).size !== orderedIds.length ||
        !orderedIds.every((id) => ids.has(id))
      ) {
        throw validationFailed('Reorder must list every card exactly once');
      }
      await renumberCards(tx, roleId, orderedIds);
      await this.roles.touch(roleId, actor.id, tx);
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'Reordered flash cards',
          entity: 'job_role',
          entityId: roleId,
          itemLabel: role.title,
          ip: actor.ip,
        },
        tx,
      );
    });
    return this.list(roleId);
  }

  /** Discards an AI draft and closes the gap in positions. Approved cards can't be discarded. */
  async discard(cardId: string, actor: Actor): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const card = await this.getCard(cardId, tx);
      const role = await this.roles.getEditableRow(card.jobRoleId, tx);
      if (card.status !== 'ai_draft')
        throw conflict('Only AI drafts can be discarded');
      await tx.flashCard.delete({ where: { id: cardId } });
      const rest = await tx.flashCard.findMany({
        where: { jobRoleId: card.jobRoleId },
        orderBy: { position: 'asc' },
        select: { id: true },
      });
      await renumberCards(
        tx,
        card.jobRoleId,
        rest.map((c) => c.id),
      );
      await this.roles.touch(role.id, actor.id, tx);
      await this.record('Discarded flash card', card, role.title, actor, tx);
    });
  }

  private async getCard(
    cardId: string,
    tx: Prisma.TransactionClient,
  ): Promise<FlashCard> {
    const card = await tx.flashCard.findUnique({ where: { id: cardId } });
    if (!card) throw notFound('Flash card not found');
    return card;
  }

  private record(
    action: string,
    card: FlashCard,
    roleTitle: string,
    actor: Actor,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    return this.audit.record(
      {
        actorId: actor.id,
        action,
        entity: ENTITY,
        entityId: card.id,
        itemLabel: `${roleTitle} · card ${card.position}`,
        ip: actor.ip,
      },
      tx,
    );
  }
}
