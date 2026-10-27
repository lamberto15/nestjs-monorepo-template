import { SettingsService } from './settings.service.js';

/** A settings read never waits for Redis: it answers `undefined` (cache, then database). */
describe('SettingsService without Redis', () => {
  const service = (redis: object) => {
    const instance = Object.create(SettingsService.prototype) as {
      redis: object;
      logger: { warn: ReturnType<typeof vi.fn> };
      redisGet(key: string): Promise<string | undefined>;
      redisDown: boolean;
    };
    instance.redis = redis;
    instance.logger = { warn: vi.fn() };
    instance.redisDown = false;
    return instance;
  };

  it('reads the version of a connected Redis', async () => {
    const settings = service({ status: 'ready', get: async () => '4' });
    expect(await settings.redisGet('k')).toBe('4');
  });

  it('answers at once, and warns once, while Redis is down', async () => {
    const get = vi.fn();
    const settings = service({ status: 'reconnecting', get });
    const started = Date.now();
    expect(await settings.redisGet('k')).toBeUndefined();
    expect(await settings.redisGet('k')).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(100);
    expect(get).not.toHaveBeenCalled();
    expect(settings.logger.warn).toHaveBeenCalledTimes(1);
  });

  it('gives up within the timeout when Redis is connected but silent', async () => {
    const settings = service({
      status: 'ready',
      get: () => new Promise(() => {}),
    });
    const started = Date.now();
    expect(await settings.redisGet('k')).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(
      SettingsService.REDIS_READ_TIMEOUT_MS + 500,
    );
  });
});
