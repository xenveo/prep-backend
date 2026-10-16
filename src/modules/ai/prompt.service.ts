import { Injectable } from '@nestjs/common';
import {
  THINKING_LEVELS,
  type ThinkingLevel,
} from '../../adapters/llm/llm.adapter.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { DEFAULT_PROMPTS, type PromptRole } from './prompts/defaults.js';

export type ActivePrompt = {
  role: PromptRole;
  /** 0 = built-in default (no active row) */
  version: number;
  model: string;
  temperature: number;
  /** Null = the model's default. */
  thinkingLevel: ThinkingLevel | null;
  template: string;
};

export type PromptVersionSnapshot = {
  interviewer: number;
  evaluator: number;
  summariser: number;
};

const CACHE_TTL_MS = 30_000;

/** Active prompt per role from `prompt_versions` (NFR-12), cached briefly. */
@Injectable()
export class PromptService {
  private readonly cache = new Map<
    PromptRole,
    { prompt: ActivePrompt; expiresAt: number }
  >();

  constructor(private readonly prisma: PrismaService) {}

  async getActive(role: PromptRole): Promise<ActivePrompt> {
    const hit = this.cache.get(role);
    if (hit && hit.expiresAt > Date.now()) return hit.prompt;

    const row = await this.prisma.promptVersion.findFirst({
      where: { role, active: true },
      orderBy: { version: 'desc' },
    });
    const prompt: ActivePrompt = row
      ? {
          role,
          version: row.version,
          model: row.model,
          temperature: row.temperature,
          thinkingLevel: toThinkingLevel(row.thinkingLevel),
          template: row.template,
        }
      : { ...DEFAULT_PROMPTS.find((p) => p.role === role)!, version: 0 };
    this.cache.set(role, { prompt, expiresAt: Date.now() + CACHE_TTL_MS });
    return prompt;
  }

  /** Active versions stored on a new session (Session.promptVersions). */
  async snapshotVersions(): Promise<PromptVersionSnapshot> {
    const [interviewer, evaluator, summariser] = await Promise.all([
      this.getActive('interviewer'),
      this.getActive('evaluator'),
      this.getActive('summariser'),
    ]);
    return {
      interviewer: interviewer.version,
      evaluator: evaluator.version,
      summariser: summariser.version,
    };
  }

  /** Drops cached prompts, e.g. after the admin AI config activates a new version. */
  invalidate(role?: PromptRole): void {
    if (role) this.cache.delete(role);
    else this.cache.clear();
  }
}

/** The column is free text; anything but a known level means the model's default. */
export function toThinkingLevel(value: string | null): ThinkingLevel | null {
  return THINKING_LEVELS.find((l) => l === value) ?? null;
}
