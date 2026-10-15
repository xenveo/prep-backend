import { Global, Module } from '@nestjs/common';
import { EmailProcessor } from './email.processor.js';
import { EmailService } from './email.service.js';

@Global()
@Module({
  providers: [EmailService, EmailProcessor],
  exports: [EmailService],
})
export class EmailModule {}
