import { isDeepStrictEqual } from 'node:util';
import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

type Db = PrismaService | Prisma.TransactionClient;

export type AuditInput = {
  actorId: string | null;
  /** A fixed action string per kind ("Approved role", "Sent invites"); counts go in itemLabel. */
  action: string;
  /** Table-ish name of the thing acted on ("job_role", "user", "workspace_settings"). */
  entity: string;
  entityId?: string | null;
  itemLabel: string;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
};

export type AuditBase = Pick<
  AuditInput,
  'actorId' | 'entity' | 'entityId' | 'ip'
>;

/** One audited field: the action the admin UI logs for it and how it shows a value ("30 days"). */
export type FieldAuditDef<T = Record<string, unknown>> = {
  key: keyof T & string;
  action: string;
  show?: (value: any) => string;
};

export const ERASED_ITEM_LABEL = 'Deleted candidate';

/** Writes the admin audit log (FR-ADM-06, plan §5 "Audit"). Pass `tx` to write inside a transaction. */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(
    input: AuditInput,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    await this.db(tx).auditLog.create({ data: toRow(input) });
  }

  /**
   * Like `record`, but folds repeat writes (role autosave): when the same actor already logged the
   * same action on the same entity within `windowMin`, that row takes the new `after`, label and
   * time and keeps its original `before`.
   */
  async recordMerged(
    input: AuditInput,
    windowMin = 10,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const db = this.db(tx);
    const recent = await db.auditLog.findFirst({
      where: {
        actorId: input.actorId,
        action: input.action,
        entity: input.entity,
        entityId: input.entityId ?? null,
        at: { gte: new Date(Date.now() - windowMin * 60_000) },
      },
      orderBy: { at: 'desc' },
      select: { id: true },
    });
    if (!recent) {
      await db.auditLog.create({ data: toRow(input) });
      return;
    }
    await db.auditLog.update({
      where: { id: recent.id },
      data: {
        itemLabel: input.itemLabel,
        after: toJson(input.after),
        ip: input.ip ?? null,
        at: new Date(),
      },
    });
  }

  /**
   * One row per changed field, as the admin UI logs settings: action from the field's def,
   * label "old → new" using its `show` (default String). Fields missing from `after` are skipped.
   * Returns the number of rows written.
   */
  async recordFieldChanges<T extends Record<string, unknown>>(
    base: AuditBase,
    fields: readonly FieldAuditDef<T>[],
    before: T,
    after: Partial<T>,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const rows = fields
      .filter(
        (f) =>
          after[f.key] !== undefined &&
          !isDeepStrictEqual(before[f.key], after[f.key]),
      )
      .map((f) => {
        const show = f.show ?? String;
        return toRow({
          ...base,
          action: f.action,
          itemLabel: `${show(before[f.key])} → ${show(after[f.key])}`,
          before: { [f.key]: before[f.key] },
          after: { [f.key]: after[f.key] },
        });
      });
    if (rows.length === 0) return 0;
    await this.db(tx).auditLog.createMany({ data: rows });
    return rows.length;
  }

  /**
   * Erasure purge: strips a user from the audit log. Rows about them, or whose snapshots mention
   * their id, keep the action and time but lose the label and snapshots. Returns rows changed.
   */
  redactSubject(
    userId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    return this.db(tx).$executeRaw`
      UPDATE "audit_logs"
      SET "item_label" = ${ERASED_ITEM_LABEL}, "before" = NULL, "after" = NULL
      WHERE "entity_id" = ${userId}
         OR strpos("before"::text, ${userId}) > 0
         OR strpos("after"::text, ${userId}) > 0`;
  }

  private db(tx?: Prisma.TransactionClient): Db {
    return tx ?? this.prisma;
  }
}

function toJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === undefined || value === null
    ? Prisma.DbNull
    : (value as Prisma.InputJsonValue);
}

function toRow(input: AuditInput): Prisma.AuditLogCreateManyInput {
  return {
    actorId: input.actorId,
    action: input.action,
    entity: input.entity,
    entityId: input.entityId ?? null,
    itemLabel: input.itemLabel,
    before: toJson(input.before),
    after: toJson(input.after),
    ip: input.ip ?? null,
  };
}
