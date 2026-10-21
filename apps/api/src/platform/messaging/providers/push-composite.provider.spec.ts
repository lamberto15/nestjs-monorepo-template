import { CompositePushProvider } from './push-composite.provider.js';
import type { PushProvider } from './push-provider.js';

const fake = (name: string, platforms: PushProvider['platforms']) => {
  const calls: string[] = [];
  const provider: PushProvider = {
    name,
    platforms,
    async send(token) {
      calls.push(token);
      return 'sent';
    },
  };
  return { provider, calls };
};

describe('CompositePushProvider', () => {
  it('serves the platforms of all and sends to the device platform’s provider', async () => {
    const ios = fake('apns', ['ios']);
    const android = fake('fcm', ['android']);
    const composite = new CompositePushProvider([
      ios.provider,
      android.provider,
    ]);
    expect(composite.platforms).toEqual(['ios', 'android']);
    expect(composite.name).toBe('apns,fcm');
    await composite.send('a', { id: '1', title: 't', body: 'b' }, 'android');
    await composite.send('b', { id: '1', title: 't', body: 'b' }, 'ios');
    expect(ios.calls).toEqual(['b']);
    expect(android.calls).toEqual(['a']);
  });

  it('treats a platform nobody serves as a dead device', async () => {
    const composite = new CompositePushProvider([
      fake('apns', ['ios']).provider,
    ]);
    expect(
      await composite.send('a', { id: '1', title: 't', body: 'b' }, 'web'),
    ).toBe('gone');
  });
});
