import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
import {
  InvalidStorageKeyError,
  LocalStorageAdapter,
  contentTypeFor,
} from './local-storage.adapter.js';
import { LocalStorageController } from './local-storage.controller.js';
import { S3StorageAdapter } from './s3-storage.adapter.js';

describe('LocalStorageAdapter', () => {
  let dir: string;
  let storage: LocalStorageAdapter;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'storage-'));
    storage = new LocalStorageAdapter({
      dir,
      publicApiUrl: 'http://localhost:3000/',
      secret: 'test-secret-0123456789',
      defaultTtlSec: 300,
    });
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('puts, gets, checks and deletes objects', async () => {
    await storage.put('audio/s1/a1.webm', Buffer.from('abc'), 'audio/webm');
    expect(await storage.exists('audio/s1/a1.webm')).toBe(true);
    expect((await storage.get('audio/s1/a1.webm')).toString()).toBe('abc');
    await storage.delete('audio/s1/a1.webm');
    expect(await storage.exists('audio/s1/a1.webm')).toBe(false);
  });

  it('deletes by prefix and counts', async () => {
    await storage.put('audio/s1/a1.webm', Buffer.from('1'), 'audio/webm');
    await storage.put('audio/s1/a2.webm', Buffer.from('2'), 'audio/webm');
    await storage.put('audio/s2/a3.webm', Buffer.from('3'), 'audio/webm');
    expect(await storage.deletePrefix('audio/s1/')).toBe(2);
    expect(await storage.exists('audio/s2/a3.webm')).toBe(true);
  });

  it.each(['../etc/passwd', '/etc/passwd', 'a/../../b', 'a\\..\\b', ''])(
    'rejects unsafe key %j',
    async (key) => {
      await expect(
        storage.put(key, Buffer.from('x'), 'text/plain'),
      ).rejects.toBeInstanceOf(InvalidStorageKeyError);
    },
  );

  it('signs URLs that verify, and rejects tampering and expiry', async () => {
    const url = new URL(await storage.signedUrl('tts/abc.mp3', 60));
    expect(url.origin + url.pathname).toBe(
      'http://localhost:3000/api/storage/local/tts/abc.mp3',
    );
    const exp = Number(url.searchParams.get('exp'));
    const sig = url.searchParams.get('sig')!;
    expect(storage.verify('tts/abc.mp3', exp, sig)).toBe('ok');
    expect(storage.verify('tts/other.mp3', exp, sig)).toBe('bad');
    expect(storage.verify('tts/abc.mp3', exp + 1, sig)).toBe('bad');
    expect(storage.verify('tts/abc.mp3', exp, sig, exp + 1)).toBe('expired');
  });

  it('serves a signed file through the controller and refuses bad links', async () => {
    await storage.put('tts/abc.mp3', Buffer.from('mp3'), 'audio/mpeg');
    const controller = new LocalStorageController(storage);
    const url = new URL(await storage.signedUrl('tts/abc.mp3', 60));
    const exp = url.searchParams.get('exp')!;
    const sig = url.searchParams.get('sig')!;
    const file = await controller.serve(['tts', 'abc.mp3'], exp, sig);
    expect(file.getHeaders().type).toBe('audio/mpeg');
    await expect(
      controller.serve('tts/abc.mp3', exp, 'nope'),
    ).rejects.toMatchObject({ status: 403 });
    const old = Math.floor(Date.now() / 1000) - 10;
    const oldSig = new URL(
      await storage.signedUrl('tts/abc.mp3', -10),
    ).searchParams.get('sig')!;
    await expect(
      controller.serve('tts/abc.mp3', String(old), oldSig),
    ).rejects.toMatchObject({ status: 410 });
  });

  it('maps content types from the extension', () => {
    expect(contentTypeFor('a/b.webm')).toBe('audio/webm');
    expect(contentTypeFor('exports/x.csv')).toContain('text/csv');
    expect(contentTypeFor('x.bin')).toBe('application/octet-stream');
  });
});

describe('S3StorageAdapter', () => {
  it('encrypts on put and batches prefix deletes across pages', async () => {
    const send = vi.fn(
      async (cmd: {
        constructor: { name: string };
        input: Record<string, unknown>;
      }) => {
        switch (cmd.constructor.name) {
          case 'PutObjectCommand':
            return {};
          case 'ListObjectsV2Command':
            return cmd.input.ContinuationToken
              ? { Contents: [{ Key: 'p/3' }], IsTruncated: false }
              : {
                  Contents: [{ Key: 'p/1' }, { Key: 'p/2' }],
                  IsTruncated: true,
                  NextContinuationToken: 't',
                };
          case 'DeleteObjectsCommand':
            return { Errors: [] };
          default:
            throw new Error(cmd.constructor.name);
        }
      },
    );
    const s3 = new S3StorageAdapter(
      { bucket: 'b', region: 'ap-south-1', defaultTtlSec: 300 },
      { send } as unknown as S3Client,
    );
    await s3.put('k', Buffer.from('x'), 'audio/webm');
    expect(send.mock.calls[0][0].input).toMatchObject({
      ServerSideEncryption: 'AES256',
      ContentType: 'audio/webm',
    });
    expect(await s3.deletePrefix('p/')).toBe(3);
    expect(
      send.mock.calls.filter(
        ([c]) => c.constructor.name === 'DeleteObjectsCommand',
      ),
    ).toHaveLength(2);
  });

  it('reports missing objects as not existing', async () => {
    const send = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('nf'), { name: 'NotFound' }));
    const s3 = new S3StorageAdapter(
      { bucket: 'b', region: 'r', defaultTtlSec: 1 },
      { send } as unknown as S3Client,
    );
    expect(await s3.exists('k')).toBe(false);
  });
});
