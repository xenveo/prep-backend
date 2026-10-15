import { InMemoryEventBus } from './in-memory-event-bus.js';
import { sessionChannel } from './event-bus.types.js';

const tick = () => new Promise((r) => setImmediate(r));

describe('InMemoryEventBus', () => {
  it('delivers JSON copies asynchronously to channel subscribers only', async () => {
    const bus = new InMemoryEventBus();
    const a: unknown[] = [];
    const b: unknown[] = [];
    await bus.subscribe(sessionChannel('s1'), (e) => a.push(e));
    await bus.subscribe(sessionChannel('s2'), (e) => b.push(e));

    const event = {
      type: 'feedback.audio_ready',
      attemptId: 'a1',
      url: 'u',
      at: new Date(0),
    };
    const published = bus.publish(sessionChannel('s1'), event);
    expect(a).toEqual([]);
    await published;
    await tick();
    expect(a).toEqual([
      {
        type: 'feedback.audio_ready',
        attemptId: 'a1',
        url: 'u',
        at: '1970-01-01T00:00:00.000Z',
      },
    ]);
    expect(a[0]).not.toBe(event);
    expect(b).toEqual([]);
  });

  it('stops delivering after unsubscribe', async () => {
    const bus = new InMemoryEventBus();
    const seen: unknown[] = [];
    const unsubscribe = await bus.subscribe('user.revoked', (e) =>
      seen.push(e),
    );
    await bus.publish('user.revoked', { userId: 'u1' });
    await tick();
    await unsubscribe();
    await bus.publish('user.revoked', { userId: 'u2' });
    await tick();
    expect(seen).toEqual([{ userId: 'u1' }]);
  });

  it('isolates a throwing handler from the others', async () => {
    const bus = new InMemoryEventBus();
    const seen: unknown[] = [];
    await bus.subscribe('c', () => {
      throw new Error('bad');
    });
    await bus.subscribe('c', (e) => seen.push(e));
    await bus.publish('c', { n: 1 });
    await tick();
    expect(seen).toEqual([{ n: 1 }]);
  });
});
