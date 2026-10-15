import { Global, Module } from '@nestjs/common';
import { AppConfig, loadConfig } from './app-config.js';

@Global()
@Module({
  providers: [{ provide: AppConfig, useFactory: () => loadConfig() }],
  exports: [AppConfig],
})
export class ConfigModule {}
