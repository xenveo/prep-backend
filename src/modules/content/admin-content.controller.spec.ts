import type { Response } from 'express';
import type { AuthUser } from '../../common/auth/auth.types.js';
import type { QueueService } from '../../common/queue/queue.types.js';
import { AdminContentController } from './admin-content.controller.js';
import { DRAFT_WAIT_MS } from './ai-draft.processor.js';
import type { AiQuotaService } from './ai-quota.service.js';
import type { CardsService } from './cards.service.js';
import type { QuestionsService } from './questions.service.js';
import type { RolesService } from './roles.service.js';

const user = { id: 'admin-1' } as AuthUser;
const roleId = '00000000-0000-4000-8000-000000000001';

function setup(outcome: unknown) {
  const roles = { getEditableRow: vi.fn().mockResolvedValue({ id: roleId }) };
  const quota = { consume: vi.fn().mockResolvedValue(undefined) };
  const queue = { addAndWait: vi.fn().mockResolvedValue(outcome) };
  const controller = new AdminContentController(
    roles as unknown as RolesService,
    {} as CardsService,
    {} as QuestionsService,
    quota as unknown as AiQuotaService,
    queue as unknown as QueueService,
  );
  const res = { status: vi.fn() };
  return { controller, queue, quota, res };
}

describe('AdminContentController AI drafting', () => {
  it('returns 202 with the job id when the draft outlasts the wait', async () => {
    const { controller, queue, quota, res } = setup({
      done: false,
      jobId: 'job-9',
    });
    const body = await controller.draftCards(
      roleId,
      { count: 3 },
      user,
      '127.0.0.1',
      res as unknown as Response,
    );
    expect(body).toEqual({ jobId: 'job-9' });
    expect(res.status).toHaveBeenCalledWith(202);
    expect(quota.consume).toHaveBeenCalledWith('admin-1');
    expect(queue.addAndWait).toHaveBeenCalledWith(
      'ai-draft',
      { kind: 'cards', roleId, count: 3, adminId: 'admin-1', ip: '127.0.0.1' },
      DRAFT_WAIT_MS,
    );
  });

  it('returns the drafted rows (200) when the job finishes in time', async () => {
    const rows = [{ id: 'q1' }];
    const { controller, res } = setup({ done: true, result: rows });
    const body = await controller.draftQuestions(
      roleId,
      { count: 2 },
      user,
      '127.0.0.1',
      res as unknown as Response,
    );
    expect(body).toBe(rows);
    expect(res.status).not.toHaveBeenCalled();
  });
});
