import { Global, Module } from '@nestjs/common';
import { ActivityService } from './activity.service.js';

@Global()
@Module({
  providers: [ActivityService],
  exports: [ActivityService],
})
export class ActivityModule {}
