import 'reflect-metadata';
import type { AuthUser } from '../../common/auth/auth.types.js';
import { ROLES_KEY } from '../../common/auth/roles.decorator.js';
import type { QueueService } from '../../common/queue/queue.types.js';
import { InMemoryQueueService } from '../../common/queue/in-memory-queue.service.js';
import { AiJobsController } from './ai-jobs.controller.js';

const user = { id: 'admin-1', role: 'admin' } as AuthUser;
const data = {
  adminId: user.id,
  roleId: 'role-1',
  kind: 'cards',
  count: 1,
  ip: 'private',
};

function setup(job: unknown) {
  const queue = { getJob: vi.fn().mockResolvedValue(job) };
  return {
    queue,
    controller: new AiJobsController(queue as unknown as QueueService),
  };
}

describe('AiJobsController', () => {
  it('restricts the route to admin and super admin roles', () => {
    expect(Reflect.getMetadata(ROLES_KEY, AiJobsController)).toEqual([
      'admin',
      'super_admin',
    ]);
  });

  it.each(['queued', 'running'])(
    'returns only %s status for the owner',
    async (status) => {
      const { controller, queue } = setup({ status, data });
      await expect(controller.get('draft-1', user)).resolves.toEqual({
        status,
      });
      expect(queue.getJob).toHaveBeenCalledWith('ai-draft', 'draft-1');
    },
  );

  it.each(['cards', 'questions'])(
    'returns the exact %s drafting result on completion',
    async (kind) => {
      const result = [{ id: 'row-1', question: 'Generated content' }];
      const { controller } = setup({
        status: 'done',
        data: { ...data, kind },
        result,
      });
      const response = await controller.get('draft-1', user);
      expect(response).toEqual({ status: 'done', result });
      expect(response).toHaveProperty('result', result);
    },
  );

  it('returns a safe failure code without provider details or job inputs', async () => {
    const { controller } = setup({
      status: 'failed',
      data,
      error: 'Provider credential and prompt',
    });
    await expect(controller.get('draft-1', user)).resolves.toEqual({
      status: 'failed',
      code: 'ai_unavailable',
    });
  });

  it.each(['admin', 'super_admin'])(
    'hides another admin job from a %s',
    async (role) => {
      const { controller } = setup({ status: 'done', data, result: [] });
      await expect(
        controller.get('draft-1', { ...user, id: 'other', role } as AuthUser),
      ).rejects.toMatchObject({ status: 404, code: 'not_found' });
    },
  );

  it('returns 404 for missing or expired jobs', async () => {
    const { controller } = setup(null);
    await expect(controller.get('unknown', user)).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
  });

  it('reconciles a timed-out draft through completion with the in-memory queue', async () => {
    const queue = new InMemoryQueueService('all');
    let complete!: (value: unknown[]) => void;
    queue.process(
      'ai-draft',
      async () =>
        new Promise<unknown[]>((resolve) => {
          complete = resolve;
        }),
    );
    try {
      const outcome = await queue.addAndWait('ai-draft', data, 1);
      expect(outcome.done).toBe(false);
      if (outcome.done) throw new Error('Expected timeout');
      const controller = new AiJobsController(queue);
      await expect(controller.get(outcome.jobId, user)).resolves.toEqual({
        status: 'running',
      });
      const result = [{ id: 'card-1' }];
      complete(result);
      await queue.drain();
      await expect(controller.get(outcome.jobId, user)).resolves.toEqual({
        status: 'done',
        result,
      });
    } finally {
      queue.onModuleDestroy();
    }
  });
});
