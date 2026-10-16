import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthUser } from '../../common/auth/auth.types.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { AiUsageController } from './ai-usage.controller.js';
import type { AiUsageService } from './ai-usage.service.js';

const ctx = (role: AuthUser['role']) =>
  ({
    getType: () => 'http',
    getHandler: () => AiUsageController.prototype.get,
    getClass: () => AiUsageController,
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
  }) as unknown as ExecutionContext;

describe('AiUsageController', () => {
  const guard = new RolesGuard(new Reflector());

  it('is Super admin only', () => {
    expect(guard.canActivate(ctx('super_admin'))).toBe(true);
  });

  it('hides the route with 404 from admins and candidates', () => {
    for (const role of ['admin', 'candidate'] as const) {
      expect(() => guard.canActivate(ctx(role))).toThrow(
        expect.objectContaining({ status: 404, code: 'not_found' }),
      );
    }
  });

  it('passes the parsed query to the service', async () => {
    const service = { get: vi.fn().mockResolvedValue({}) };
    const controller = new AiUsageController(
      service as unknown as AiUsageService,
    );
    const query = { from: '2026-10-01', to: '2026-10-16' };
    await controller.get(query);
    expect(service.get).toHaveBeenCalledWith(query);
  });
});
