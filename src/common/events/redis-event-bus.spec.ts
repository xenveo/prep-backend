import { EventEmitter } from 'node:events';
import type { RedisService } from '../infra/redis.service.js';
import { sessionChannel, USER_REVOKED_CHANNEL } from './event-bus.types.js';
import { RedisEventBus } from './redis-event-bus.js';

describe('RedisEventBus', () => {
  const publish = vi.fn().mockResolvedValue(1);
  let subscriber: EventEmitter & {
    subscribe: ReturnType<typeof vi.fn>;
    unsubscribe: ReturnType<typeof vi.fn>;
  };
  let bus: RedisEventBus;

  beforeEach(() => {
    publish.mockClear();
    subscriber = Object.assign(new EventEmitter(), {
      subscribe: vi.fn().mockResolvedValue(1),
      unsubscribe: vi.fn().mockResolvedValue(0),
    });
    bus = new RedisEventBus({
      client: { publish },
      key: (...parts: string[]) => ['preppilot', ...parts].join(':'),
      duplicate: () => subscriber,
    } as unknown as RedisService);
  });

  it('publishes and subscribes on prefixed channels only', async () => {
    await bus.publish(sessionChannel('s1'), { type: 'x' });
    const unsubscribe = await bus.subscribe(USER_REVOKED_CHANNEL, () => {});
    await unsubscribe();

    const wire = [
      publish.mock.calls[0][0],
      subscriber.subscribe.mock.calls[0][0],
      subscriber.unsubscribe.mock.calls[0][0],
    ];
    expect(wire).toEqual([
      'preppilot:session:s1',
      'preppilot:user.revoked',
      'preppilot:user.revoked',
    ]);
    for (const channel of wire)
      expect(channel.startsWith('preppilot:')).toBe(true);
  });

  it('hands handlers the bare channel and ignores other apps', async () => {
    const seen: unknown[] = [];
    await bus.subscribe(sessionChannel('s1'), (e) => seen.push(e));
    subscriber.emit('message', 'session:s1', '{"from":"other app"}');
    subscriber.emit('message', 'preppilot:session:s1', '{"n":1}');
    expect(seen).toEqual([{ n: 1 }]);
  });
});
