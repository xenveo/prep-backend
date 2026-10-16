import { Module } from '@nestjs/common';
import { RecoveryService } from './recovery.service.js';

/** Startup and hourly sweep for exports and attempts stuck behind a lost job (plan 03 §4). */
@Module({ providers: [RecoveryService] })
export class RecoveryModule {}
