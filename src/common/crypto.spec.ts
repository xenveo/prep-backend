import {
  hmacHex,
  randomOtp,
  randomToken,
  safeEqual,
  sha256Hex,
} from './crypto.js';

describe('crypto helpers', () => {
  it('randomToken is base64url of the requested size', () => {
    const t = randomToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(t, 'base64url')).toHaveLength(32);
    expect(randomToken()).not.toBe(t);
  });

  it('sha256Hex and hmacHex are deterministic hex', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(hmacHex('k', 'v')).toMatch(/^[0-9a-f]{64}$/);
    expect(hmacHex('k', 'v')).not.toBe(hmacHex('k2', 'v'));
  });

  it('safeEqual compares exactly', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });

  it('randomOtp is 6 digits', () => {
    for (let i = 0; i < 50; i++) expect(randomOtp()).toMatch(/^\d{6}$/);
  });
});
