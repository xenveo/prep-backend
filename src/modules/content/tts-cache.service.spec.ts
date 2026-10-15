import type { StorageAdapter } from '../../adapters/storage/storage.adapter.js';
import type { TtsAdapter } from '../../adapters/tts/tts.adapter.js';
import { sha256Hex } from '../../common/crypto.js';
import type { AiCallLogService } from '../ai/ai-call-log.service.js';
import type { SettingsService } from '../settings/settings.service.js';
import { TtsCacheService, ttsKey } from './tts-cache.service.js';

function setup(exists: boolean) {
  const tts = {
    provider: 'fake',
    speak: vi.fn().mockResolvedValue({
      audio: Buffer.from('mp3'),
      mimeType: 'audio/mpeg',
      durationS: 2.5,
      provider: 'fake',
      latencyMs: 12,
      costUsd: 0.001,
    }),
  };
  const storage = {
    exists: vi.fn().mockResolvedValue(exists),
    put: vi.fn().mockResolvedValue(undefined),
    signedUrl: vi.fn().mockResolvedValue('https://signed'),
  };
  const settings = { get: vi.fn().mockResolvedValue({ voice: 'Calm' }) };
  const callLog = { log: vi.fn().mockResolvedValue(undefined) };
  const service = new TtsCacheService(
    tts as unknown as TtsAdapter,
    storage as unknown as StorageAdapter,
    settings as unknown as SettingsService,
    callLog as unknown as AiCallLogService,
  );
  return { service, tts, storage, callLog };
}

describe('TtsCacheService', () => {
  it('keys by sha256(voice + newline + text)', () => {
    expect(ttsKey('Calm', 'Hello')).toBe(`tts/${sha256Hex('Calm\nHello')}.mp3`);
  });

  it('reuses a cached file without calling the provider', async () => {
    const { service, tts, callLog } = setup(true);
    const r = await service.getOrCreate('one two three');
    expect(r.key).toBe(ttsKey('Calm', 'one two three'));
    expect(r.durationS).toBeGreaterThan(0);
    expect(tts.speak).not.toHaveBeenCalled();
    expect(callLog.log).not.toHaveBeenCalled();
  });

  it('renders, stores and logs on a miss', async () => {
    const { service, tts, storage, callLog } = setup(false);
    const r = await service.getOrCreate('Hi', {
      voice: 'Warm',
      sessionId: 's1',
    });
    expect(tts.speak).toHaveBeenCalledWith('Hi', 'Warm');
    expect(storage.put).toHaveBeenCalledWith(
      ttsKey('Warm', 'Hi'),
      Buffer.from('mp3'),
      'audio/mpeg',
    );
    expect(r).toEqual({ key: ttsKey('Warm', 'Hi'), durationS: 2.5 });
    expect(callLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'tts',
        status: 'ok',
        sessionId: 's1',
        audioSeconds: 2.5,
      }),
    );
  });

  it('logs and rethrows provider failures', async () => {
    const { service, tts, callLog } = setup(false);
    tts.speak.mockRejectedValue(new Error('boom'));
    await expect(service.getOrCreate('Hi')).rejects.toThrow('boom');
    expect(callLog.log).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'tts', status: 'error' }),
    );
  });

  it('signs urls through storage', async () => {
    const { service } = setup(true);
    await expect(service.signedUrl('tts/a.mp3')).resolves.toBe(
      'https://signed',
    );
  });
});
