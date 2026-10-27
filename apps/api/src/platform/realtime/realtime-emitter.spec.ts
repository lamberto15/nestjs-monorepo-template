import type { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import type { CoreEnv } from '../../core/config/core.env.js';
import { RealtimeEmitter } from './realtime-emitter.js';

describe('RealtimeEmitter', () => {
  it("publishes a disconnect on the channel the API replicas' Redis adapter listens to", () => {
    const publish = vi.fn();
    const get = vi.fn(() => 'app');
    const config = { get } as unknown as ConfigService<CoreEnv, true>;
    const emitter = new RealtimeEmitter(
      { publish } as unknown as Redis,
      config,
    );

    emitter.disconnect(['token:family-1', 'session:s1']);

    expect(get).toHaveBeenCalledWith('REDIS_PREFIX', { infer: true });
    expect(publish).toHaveBeenCalledTimes(1);
    const [channel, message] = publish.mock.calls[0] as [string, string];
    // @socket.io/redis-adapter's request channel: `<key>-request#<namespace>#`.
    expect(channel).toBe('app:socket.io-request#/realtime#');
    expect(JSON.parse(message)).toMatchObject({
      // RequestType.REMOTE_DISCONNECT, closing the connections.
      type: 4,
      opts: { rooms: ['token:family-1', 'session:s1'], except: [] },
      close: true,
    });
  });
});
