import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { AppConfig } from '../config/app-config.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { withErasureWhere } from './erasure-filter.js';

/**
 * The app's Prisma client. Reads hide erased users and their rows automatically (erasure stage 1,
 * see erasure-filter.ts); `unfiltered` is the same connection without that filter, for erasure and
 * purge code only. Query extensions don't change result types, so this keeps PrismaClient's typing.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  readonly unfiltered: PrismaClient;

  constructor(config: AppConfig) {
    super({
      adapter: new PrismaPg({ connectionString: config.env.DATABASE_URL }),
    });
    this.unfiltered = this;
    // Returning the extended client makes `new PrismaService()` (and so DI) yield it. Unknown
    // properties (lifecycle hooks, `unfiltered`) fall through to this base instance.
    return this.$extends({
      query: {
        $allModels: {
          $allOperations({ model, operation, args, query }) {
            return query(withErasureWhere(model, operation, args));
          },
        },
      },
    }) as unknown as PrismaService;
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
