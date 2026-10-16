import { markerRefusal, nodeEnvRefusal } from './demo-guard.js';

describe('the demo seed’s positive check', () => {
  it('allows NODE_ENV development and test, as set', () => {
    expect(nodeEnvRefusal('development')).toBeNull();
    expect(nodeEnvRefusal('test')).toBeNull();
  });

  it('refuses any other NODE_ENV, and an unset one (the schema would call it development)', () => {
    for (const nodeEnv of [
      'production',
      'staging',
      'Development',
      '',
      undefined,
    ]) {
      expect(nodeEnvRefusal(nodeEnv)).toMatch(/NODE_ENV=development/);
    }
    expect(nodeEnvRefusal('production')).toContain('"production"');
    expect(nodeEnvRefusal(undefined)).toContain('not set');
  });

  it('allows a database marked as a development one, and refuses any other', () => {
    expect(markerRefusal(true)).toBeNull();
    expect(markerRefusal(false)).toMatch(
      /app\.dev_database = on.*pnpm db:mark-dev/,
    );
  });
});
