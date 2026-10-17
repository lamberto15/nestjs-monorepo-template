import { inDevelopment, isDevelopment } from './notification-test.js';

describe('the development-only notification test', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(['development', 'test'])('is on under NODE_ENV=%s', (nodeEnv) => {
    vi.stubEnv('NODE_ENV', nodeEnv);
    expect(isDevelopment()).toBe(true);
    expect(inDevelopment('route')).toEqual(['route']);
  });

  it.each(['production', 'staging', ''])(
    'is off under NODE_ENV="%s", as the demo seed is',
    (nodeEnv) => {
      vi.stubEnv('NODE_ENV', nodeEnv);
      expect(isDevelopment()).toBe(false);
      expect(inDevelopment('route')).toEqual([]);
    },
  );
});
