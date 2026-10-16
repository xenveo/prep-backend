import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { GeminiClient } from '../../adapters/gemini/gemini.client.js';
import { GeminiError } from '../../adapters/gemini/gemini.errors.js';
import {
  THINKING_LEVELS,
  type ThinkingLevel,
} from '../../adapters/llm/llm.adapter.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { validationFailed } from '../../common/errors/app-error.js';
import { AppConfig } from '../../config/app-config.js';
import type { PromptVersion } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PromptService, toThinkingLevel } from '../ai/prompt.service.js';
import {
  DEFAULT_PROMPTS,
  PROMPT_ROLES,
  type PromptRole,
} from '../ai/prompts/defaults.js';

/** PUT /admin/ai-config: a new version for one prompt role. Omitted template or thinkingLevel = copy the active one. */
export const aiConfigUpdateSchema = z.object({
  role: z.enum(PROMPT_ROLES as [PromptRole, ...PromptRole[]]),
  model: z.string().trim().min(1).max(200),
  temperature: z.number().min(0).max(1),
  thinkingLevel: z.enum(THINKING_LEVELS).optional(),
  template: z.string().trim().min(1).max(50_000).optional(),
});

export type AiConfigUpdate = z.infer<typeof aiConfigUpdateSchema>;

/** No admin UI screen exists for AI config, so this action string is the backend's own. */
export const AI_CONFIG_AUDIT_ACTION = 'Changed AI config';

export type PromptVersionSummary = {
  version: number;
  model: string;
  temperature: number;
  thinkingLevel: ThinkingLevel | null;
  active: boolean;
  createdBy: string | null;
  createdAt: string;
};

export type PromptRoleConfig = {
  role: PromptRole;
  /** Version 0 = the built-in default (no stored version is active). */
  active: {
    version: number;
    model: string;
    temperature: number;
    /** Null = the model's default. */
    thinkingLevel: ThinkingLevel | null;
    template: string;
  };
  /** Newest first, without templates. */
  versions: PromptVersionSummary[];
};

export type AiConfig = { roles: PromptRoleConfig[] };

/** Super admin AI config: versioned prompts, model and temperature per prompt role (SRS 2.2, NFR-12). */
@Injectable()
export class AiConfigService {
  private readonly logger = new Logger(AiConfigService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly prompts: PromptService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
    private readonly gemini: GeminiClient,
  ) {}

  async get(): Promise<AiConfig> {
    const rows = await this.prisma.promptVersion.findMany({
      orderBy: [{ role: 'asc' }, { version: 'desc' }],
    });
    return {
      roles: PROMPT_ROLES.map((role) =>
        toRoleConfig(
          role,
          rows.filter((r) => r.role === role),
        ),
      ),
    };
  }

  /** Creates version N+1 for the role and makes it the only active one, then drops the prompt cache. */
  async update(
    input: AiConfigUpdate,
    actorId: string,
    ip: string | null,
  ): Promise<PromptRoleConfig> {
    await this.checkModel(input.model);
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.promptVersion.findFirst({
        where: { role: input.role, active: true },
        orderBy: { version: 'desc' },
      });
      const latest = await tx.promptVersion.findFirst({
        where: { role: input.role },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const fallback = defaultFor(input.role);
      const template = input.template ?? current?.template ?? fallback.template;
      const currentThinking = current
        ? toThinkingLevel(current.thinkingLevel)
        : fallback.thinkingLevel;
      const thinkingLevel = input.thinkingLevel ?? currentThinking;
      await tx.promptVersion.updateMany({
        where: { role: input.role, active: true },
        data: { active: false },
      });
      const created = await tx.promptVersion.create({
        data: {
          role: input.role,
          version: (latest?.version ?? 0) + 1,
          model: input.model,
          temperature: input.temperature,
          thinkingLevel,
          template,
          outputSchema: current?.outputSchema ?? undefined,
          active: true,
          createdBy: actorId,
        },
      });
      const before = current ?? { ...fallback, version: 0 };
      await this.audit.record(
        {
          actorId,
          action: AI_CONFIG_AUDIT_ACTION,
          entity: 'prompt_version',
          entityId: created.id,
          itemLabel: `${input.role}: v${before.version} → v${created.version}`,
          before: {
            version: before.version,
            model: before.model,
            temperature: before.temperature,
            thinkingLevel: currentThinking,
          },
          after: {
            version: created.version,
            model: created.model,
            temperature: created.temperature,
            thinkingLevel,
            templateChanged: template !== before.template,
          },
          ip,
        },
        tx,
      );
    });
    this.prompts.invalidate(input.role);
    const config = await this.get();
    return config.roles.find((r) => r.role === input.role)!;
  }

  /**
   * Rejects a model Gemini definitively doesn't serve (404). Anything else, including the 400 Gemini
   * returns for a bad API key, is logged and doesn't block saving.
   */
  private async checkModel(model: string): Promise<void> {
    if (this.config.env.LLM_PROVIDER !== 'gemini') return;
    try {
      await this.gemini.ensureModel(model);
    } catch (err) {
      const code = err instanceof GeminiError ? err.code : 'unknown';
      if (code === 'model_not_found')
        throw validationFailed(`Model ${model} is not available`);
      this.logger.warn(`Model check failed (${code}); saving unverified`);
    }
  }
}

function defaultFor(role: PromptRole) {
  return DEFAULT_PROMPTS.find((p) => p.role === role)!;
}

function toRoleConfig(
  role: PromptRole,
  rows: PromptVersion[],
): PromptRoleConfig {
  const active = rows.find((r) => r.active);
  const fallback = defaultFor(role);
  return {
    role,
    active: active
      ? {
          version: active.version,
          model: active.model,
          temperature: active.temperature,
          thinkingLevel: toThinkingLevel(active.thinkingLevel),
          template: active.template,
        }
      : {
          version: 0,
          model: fallback.model,
          temperature: fallback.temperature,
          thinkingLevel: fallback.thinkingLevel,
          template: fallback.template,
        },
    versions: rows.map((r) => ({
      version: r.version,
      model: r.model,
      temperature: r.temperature,
      thinkingLevel: toThinkingLevel(r.thinkingLevel),
      active: r.active,
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}
