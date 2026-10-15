import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'auth:public';

/** Skips SessionGuard (login, health). CSRF still applies. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
