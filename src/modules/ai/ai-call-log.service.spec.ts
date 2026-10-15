import type { PrismaService } from '../../prisma/prisma.service.js';
import { AiCallLogService } from './ai-call-log.service.js';

describe('AiCallLogService', () => {
  it('writes a row with ids and counts, truncating the error', async () => {
    const create = vi.fn().mockResolvedValue({});
    const service = new AiCallLogService({
      aiCallLog: { create },
    } as unknown as PrismaService);
    await service.log({
      sessionId: 's-1',
      kind: 'llm',
      provider: 'fake',
      model: 'm',
      promptRole: 'evaluator',
      promptVersion: 1,
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 12.6,
      costUsd: 0.001,
      status: 'error',
      error: 'x'.repeat(1000),
    });
    const data = create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      sessionId: 's-1',
      attemptId: null,
      kind: 'llm',
      latencyMs: 13,
      costUsd: 0.001,
      audioSeconds: null,
    });
    expect(data.error).toHaveLength(300);
  });

  it('never throws when the insert fails', async () => {
    const create = vi.fn().mockRejectedValue(new Error('db down'));
    const service = new AiCallLogService({
      aiCallLog: { create },
    } as unknown as PrismaService);
    await expect(
      service.log({
        kind: 'tts',
        provider: 'fake',
        latencyMs: 1,
        status: 'ok',
      }),
    ).resolves.toBeUndefined();
  });
});
