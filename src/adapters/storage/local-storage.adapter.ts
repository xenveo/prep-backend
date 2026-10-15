import { createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream, type ReadStream } from 'node:fs';
import {
  access,
  mkdir,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
  readdir,
} from 'node:fs/promises';
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import type { StorageAdapter } from './storage.adapter.js';

export type LocalStorageOptions = {
  dir: string;
  publicApiUrl: string;
  secret: string;
  defaultTtlSec: number;
};

export const LOCAL_STORAGE_ROUTE = '/api/storage/local';

const CONTENT_TYPES: Record<string, string> = {
  '.webm': 'audio/webm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.txt': 'text/plain; charset=utf-8',
};

export function contentTypeFor(key: string): string {
  return (
    CONTENT_TYPES[extname(key).toLowerCase()] ?? 'application/octet-stream'
  );
}

export class InvalidStorageKeyError extends Error {
  constructor() {
    super('Invalid storage key');
    this.name = 'InvalidStorageKeyError';
  }
}

/** Filesystem storage for dev and tests. Signed URLs are served by LocalStorageController. */
export class LocalStorageAdapter implements StorageAdapter {
  readonly root: string;

  constructor(private readonly opts: LocalStorageOptions) {
    this.root = resolve(opts.dir);
  }

  /** Resolves a key under the root; rejects absolute keys, `..` segments and anything escaping the root. */
  pathFor(key: string): string {
    if (
      !key ||
      isAbsolute(key) ||
      key.includes('\0') ||
      key.split(/[\\/]/).includes('..')
    ) {
      throw new InvalidStorageKeyError();
    }
    const full = resolve(this.root, key);
    const rel = relative(this.root, full);
    if (!rel || rel.startsWith('..') || isAbsolute(rel))
      throw new InvalidStorageKeyError();
    return full;
  }

  async put(key: string, body: Buffer, _contentType?: string): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(this.pathFor(key));
      return true;
    } catch (err) {
      if (err instanceof InvalidStorageKeyError) throw err;
      return false;
    }
  }

  signedUrl(key: string, ttlSec = this.opts.defaultTtlSec): Promise<string> {
    this.pathFor(key);
    const exp = Math.floor(Date.now() / 1000) + ttlSec;
    const encodedKey = key.split('/').map(encodeURIComponent).join('/');
    const base = this.opts.publicApiUrl.replace(/\/+$/, '');
    return Promise.resolve(
      `${base}${LOCAL_STORAGE_ROUTE}/${encodedKey}?exp=${exp}&sig=${this.sign(key, exp)}`,
    );
  }

  /** 'ok', 'bad' (wrong signature) or 'expired'. */
  verify(
    key: string,
    exp: number,
    sig: string,
    nowSec = Math.floor(Date.now() / 1000),
  ): 'ok' | 'bad' | 'expired' {
    if (!Number.isInteger(exp)) return 'bad';
    const expected = Buffer.from(this.sign(key, exp));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given))
      return 'bad';
    return exp < nowSec ? 'expired' : 'ok';
  }

  async open(
    key: string,
  ): Promise<{ stream: ReadStream; size: number; contentType: string } | null> {
    const path = this.pathFor(key);
    try {
      const s = await stat(path);
      if (!s.isFile()) return null;
      return {
        stream: createReadStream(path),
        size: s.size,
        contentType: contentTypeFor(key),
      };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async deletePrefix(prefix: string): Promise<number> {
    const files = await listFiles(this.root);
    const matches = files.filter((f) =>
      relative(this.root, f).split(sep).join('/').startsWith(prefix),
    );
    await Promise.all(matches.map((f) => unlink(f)));
    return matches.length;
  }

  private sign(key: string, exp: number): string {
    return createHmac('sha256', this.opts.secret)
      .update(`${key}${exp}`)
      .digest('base64url');
  }
}

async function listFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const nested = await Promise.all(
    entries.map((e) =>
      e.isDirectory()
        ? listFiles(join(dir, e.name))
        : Promise.resolve([join(dir, e.name)]),
    ),
  );
  return nested.flat();
}
