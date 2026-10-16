import { systemPrincipal } from '../../iam/auth/principal.js';
import { stillActive } from './still-active.js';

describe('stillActive', () => {
  it('never takes a system principal read from a payload: no one, without a query', async () => {
    const payload = JSON.parse(
      JSON.stringify(systemPrincipal({ key: 'seed', label: 'Seed' })),
    );
    const untouched = new Proxy({} as never, {
      get: () => {
        throw new Error('queried');
      },
    });
    expect(await stillActive(payload, untouched, untouched)).toBeNull();
  });
});
