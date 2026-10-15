import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';

/** URL-safe random token (session cookies, invite links). */
export const randomToken = (bytes = 32): string =>
  randomBytes(bytes).toString('base64url');

export const sha256Hex = (s: string): string =>
  createHash('sha256').update(s).digest('hex');

export const hmacHex = (secret: string, s: string): string =>
  createHmac('sha256', secret).update(s).digest('hex');

/** Constant-time string comparison (length mismatch returns false without leaking where they differ). */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/** 6-digit one-time code, zero-padded. */
export const randomOtp = (): string =>
  randomInt(0, 1_000_000).toString().padStart(6, '0');
