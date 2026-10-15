import {
  Controller,
  Get,
  Header,
  Inject,
  Param,
  Query,
  StreamableFile,
} from '@nestjs/common';
import { Public } from '../../common/auth/public.decorator.js';
import {
  AppError,
  forbidden,
  notFound,
} from '../../common/errors/app-error.js';
import {
  InvalidStorageKeyError,
  LocalStorageAdapter,
} from './local-storage.adapter.js';
import { STORAGE_ADAPTER, type StorageAdapter } from './storage.adapter.js';

/** Serves LocalStorageAdapter signed URLs (dev and tests only; registered when STORAGE_PROVIDER=local). */
@Controller('storage/local')
export class LocalStorageController {
  constructor(
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
  ) {}

  @Public()
  @Get('*key')
  @Header('Cache-Control', 'private, no-store')
  async serve(
    @Param('key') keyParam: string | string[],
    @Query('exp') expParam?: string,
    @Query('sig') sig?: string,
  ): Promise<StreamableFile> {
    if (!(this.storage instanceof LocalStorageAdapter)) throw notFound();
    const key = Array.isArray(keyParam) ? keyParam.join('/') : keyParam;
    const exp = Number(expParam);
    if (!sig || !expParam) throw forbidden('Invalid link');

    const verdict = this.storage.verify(key, exp, sig);
    if (verdict === 'bad') throw forbidden('Invalid link');
    if (verdict === 'expired')
      throw new AppError('gone', 410, 'This link has expired');

    let file;
    try {
      file = await this.storage.open(key);
    } catch (err) {
      if (err instanceof InvalidStorageKeyError)
        throw forbidden('Invalid link');
      throw err;
    }
    if (!file) throw notFound();
    return new StreamableFile(file.stream, {
      type: file.contentType,
      length: file.size,
    });
  }
}
