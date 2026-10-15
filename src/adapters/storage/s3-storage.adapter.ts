import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { StorageAdapter } from './storage.adapter.js';

/** S3 DeleteObjects accepts at most 1000 keys per call. */
const DELETE_BATCH = 1000;

export type S3StorageOptions = {
  bucket: string;
  region: string;
  /** MinIO in dev: switches to path-style addressing. */
  endpoint?: string;
  defaultTtlSec: number;
};

export class S3StorageAdapter implements StorageAdapter {
  private readonly client: S3Client;

  constructor(
    private readonly opts: S3StorageOptions,
    client?: S3Client,
  ) {
    this.client =
      client ??
      new S3Client({
        region: opts.region,
        ...(opts.endpoint
          ? { endpoint: opts.endpoint, forcePathStyle: true }
          : {}),
      });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.opts.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ServerSideEncryption: 'AES256',
      }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const out = await this.client.send(
      new GetObjectCommand({ Bucket: this.opts.bucket, Key: key }),
    );
    if (!out.Body) throw new Error(`Empty object body for ${key}`);
    return Buffer.from(await out.Body.transformToByteArray());
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.opts.bucket, Key: key }),
      );
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  signedUrl(key: string, ttlSec = this.opts.defaultTtlSec): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.opts.bucket, Key: key }),
      { expiresIn: ttlSec },
    );
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: key }),
    );
  }

  async deletePrefix(prefix: string): Promise<number> {
    let deleted = 0;
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.opts.bucket,
          Prefix: prefix,
          ContinuationToken: token,
          MaxKeys: DELETE_BATCH,
        }),
      );
      const keys = (page.Contents ?? []).flatMap((o) =>
        o.Key ? [{ Key: o.Key }] : [],
      );
      if (keys.length) {
        const out = await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.opts.bucket,
            Delete: { Objects: keys, Quiet: true },
          }),
        );
        if (out.Errors?.length)
          throw new Error(
            `Failed to delete ${out.Errors.length} objects under prefix`,
          );
        deleted += keys.length;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return deleted;
  }
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e?.name === 'NotFound' ||
    e?.name === 'NoSuchKey' ||
    e?.$metadata?.httpStatusCode === 404
  );
}
