import { UsageRollupJob } from '../src/platform/usage/usage-rollup.job.js';
import { UsageService } from '../src/platform/usage/usage.service.js';
import { bootApp, type TestApp } from './support.js';

vi.hoisted(() => {
  process.env.USAGE = 'off';
});

/** USAGE=off: no metering, no quota enforcement, no usage routes. */
describe('USAGE=off (e2e)', () => {
  let node: TestApp;

  beforeAll(async () => {
    node = await bootApp();
  });
  afterAll(async () => {
    await node.close();
  });

  it('does not enforce a daily quota or send quota headers', async () => {
    const client = await node.client();
    await node
      .admin()
      .patch(`/v1/access/clients/${client.id}`)
      .send({ dailyQuota: 1 })
      .expect(200);
    for (let i = 0; i < 3; i++) {
      const res = await node
        .http()
        .get('/v1/test-items')
        .set('Authorization', client.auth)
        .expect(200);
      expect(res.headers['x-quota-limit']).toBeUndefined();
    }
  });

  it('leaves the usage routes out (404)', async () => {
    const client = await node.client();
    await node
      .http()
      .get('/v1/usage')
      .set('Authorization', client.auth)
      .expect(404);
    await node.admin().get(`/v1/access/clients/${client.id}/usage`).expect(404);
  });

  it('registers neither the meter nor the roll-up', () => {
    expect(() => node.app.get(UsageService, { strict: false })).toThrow();
    expect(() => node.app.get(UsageRollupJob, { strict: false })).toThrow();
  });
});
