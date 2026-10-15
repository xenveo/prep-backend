import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '../../generated/prisma/client.js';

export const ROLES_KEY = 'auth:roles';

/**
 * Restricts a controller or handler to these roles; anyone else gets 404.
 * Admin controllers: `@Roles('admin', 'super_admin')`; super-admin-only handlers: `@Roles('super_admin')`.
 * Without `@Roles`, any authenticated user is accepted.
 */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
