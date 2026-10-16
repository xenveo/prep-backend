import type { StorageAdapter } from '../../adapters/storage/storage.adapter.js';
import type { TtsAdapter } from '../../adapters/tts/tts.adapter.js';
import { sha256Hex } from '../../common/crypto.js';
import type { AiCallLogService } from '../ai/ai-call-log.service.js';
import type { SettingsService } from '../settings/settings.service.js';
import { TtsCacheService, ttsKey } from './tts-cache.service.js';

function setup(exists: boolean, mimeType = 'audio/mpeg') {
  const tts = {
    provider: 'fake',
    mimeType,
    model: 'tts-model-1',
    speak: vi.fn().mockResolvedValue({
      audio: Buffer.from('audio'),
      mimeType,
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

describe('ttsKey', () => {
  it('keys by sha256(voice + newline + text) with the extension of the format', () => {
    const hash = sha256Hex('Calm\nHello');
    expect(ttsKey('Calm', 'Hello', 'audio/mpeg')).toBe(`tts/${hash}.mp3`);
    expect(ttsKey('Calm', 'Hello', 'audio/wav')).toBe(`tts/${hash}.wav`);
  });

  it('rejects a format without a known extension', () => {
    expect(() => ttsKey('Calm', 'Hello', 'audio/flac')).toThrow('audio/flac');
  });
});

describe('TtsCacheService', () => {
  it('reuses a cached file without calling the provider', async () => {
    const { service, tts, storage, callLog } = setup(true);
    const r = await service.getOrCreate('one two three');
    expect(r.key).toBe(ttsKey('Calm', 'one two three', 'audio/mpeg'));
    expect(storage.exists).toHaveBeenCalledWith(r.key);
    expect(r.durationS).toBeGreaterThan(0);
    expect(tts.speak).not.toHaveBeenCalled();
    expect(callLog.log).not.toHaveBeenCalled();
  });

  it('looks up the key in the adapter format, so an old mp3 is a miss for a wav provider', async () => {
    const { service, storage } = setup(false, 'audio/wav');
    const r = await service.getOrCreate('Hi');
    expect(r.key).toMatch(/\.wav$/);
    expect(storage.exists).toHaveBeenCalledWith(
      ttsKey('Calm', 'Hi', 'audio/wav'),
    );
  });

  it('renders, stores with the result content type and logs on a miss', async () => {
    const { service, tts, storage, callLog } = setup(false);
    const r = await service.getOrCreate('Hi', {
      voice: 'Warm',
      sessionId: 's1',
    });
    expect(tts.speak).toHaveBeenCalledWith('Hi', 'Warm');
    expect(storage.put).toHaveBeenCalledWith(
      ttsKey('Warm', 'Hi', 'audio/mpeg'),
      Buffer.from('audio'),
      'audio/mpeg',
    );
    expect(r).toEqual({
      key: ttsKey('Warm', 'Hi', 'audio/mpeg'),
      durationS: 2.5,
    });
    expect(callLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'tts',
        model: 'tts-model-1',
        status: 'ok',
        sessionId: 's1',
        audioSeconds: 2.5,
      }),
    );
  });

  it('stores wav audio as tts/<hash>.wav with content type audio/wav', async () => {
    const { service, storage } = setup(false, 'audio/wav');
    const r = await service.getOrCreate('Hi', { voice: 'Warm' });
    expect(r.key).toBe(ttsKey('Warm', 'Hi', 'audio/wav'));
    expect(storage.put).toHaveBeenCalledWith(
      r.key,
      Buffer.from('audio'),
      'audio/wav',
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
    await expect(service.signedUrl('tts/a.wav')).resolves.toBe(
      'https://signed',
    );
  });
});
