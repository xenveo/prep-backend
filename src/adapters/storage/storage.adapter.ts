// Object storage contract (S3 in ap-south-1; local filesystem in dev and tests).
// Key prefixes: audio/{sessionId}/{attemptId}.webm, tts/{sha256}.{wav|mp3}, exports/{id}.{csv|zip|json}

export const STORAGE_ADAPTER = Symbol('STORAGE_ADAPTER');

export interface StorageAdapter {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  /** Short-lived URL the browser can GET. Default TTL is AUDIO_URL_TTL_SEC. */
  signedUrl(key: string, ttlSec?: number): Promise<string>;
  delete(key: string): Promise<void>;
  /** Deletes every object under the prefix; returns how many were removed. */
  deletePrefix(prefix: string): Promise<number>;
}
