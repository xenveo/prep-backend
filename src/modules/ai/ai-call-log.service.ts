import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

export type AiCallLogEntry = {
  sessionId?: string | null;
  attemptId?: string | null;
  kind: 'llm' | 'stt' | 'tts';
  provider: string;
  model?: string | null;
  promptRole?: string | null;
  promptVersion?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  audioSeconds?: number | null;
  latencyMs: number;
  costUsd?: number | null;
  status: 'ok' | 'error';
  /** Error message; truncated. Must never contain prompt or transcript text. */
  error?: string | null;
};

const MAX_ERROR_LENGTH = 300;

/** One `ai_call_logs` row per provider call (SRS 6, NFR-10). Stores ids and counts only, never text. */
@Injectable()
export class AiCallLogService {
  private readonly logger = new Logger(AiCallLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Never throws: a logging failure must not fail the pipeline. */
  async log(entry: AiCallLogEntry): Promise<void> {
    try {
      await this.prisma.aiCallLog.create({
        data: {
          sessionId: entry.sessionId ?? null,
          attemptId: entry.attemptId ?? null,
          kind: entry.kind,
          provider: entry.provider,
          model: entry.model ?? null,
          promptRole: entry.promptRole ?? null,
          promptVersion: entry.promptVersion ?? null,
          inputTokens: entry.inputTokens ?? null,
          outputTokens: entry.outputTokens ?? null,
          audioSeconds: entry.audioSeconds ?? null,
          latencyMs: Math.max(0, Math.round(entry.latencyMs)),
          costUsd: entry.costUsd ?? null,
          status: entry.status,
          error: entry.error ? entry.error.slice(0, MAX_ERROR_LENGTH) : null,
        },
      });
    } catch (err) {
      this.logger.warn(
        `ai_call_logs insert failed (session ${entry.sessionId ?? '-'}, attempt ${entry.attemptId ?? '-'}): ${(err as Error).name}`,
      );
    }
  }
}
