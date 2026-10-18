import { OutboxRelay } from '@nestjs/outbox';
import { webhooksOptions } from '../src/platform/webhooks/webhooks.config.js';
import { bootApp, type TestApp } from './support.js';

// Read when AppModule loads (the worker is asked for on, to show the switch wins).
vi.hoisted(() => {
  process.env.WEBHOOKS = 'off';
  process.env.WEBHOOKS_WORKER = 'on';
});

/** WEBHOOKS=off: no endpoint or delivery API, no delivery worker; the rest works. */
describe('WEBHOOKS=off (e2e)', () => {
  let node: TestApp;

  beforeAll(async () => {
    node = await bootApp();
  });
  afterAll(async () => {
    await node.close();
  });

  it('leaves the endpoint routes out (404), for the administrator too', async () => {
    const res = await node.admin().get('/v1/webhook-endpoints').expect(404);
    expect(res.body.code).toBe('not_found');
  });

  it('keeps the outbox relay available (notification delivery uses it) and the other routes', async () => {
    expect(node.app.get(OutboxRelay)).toBeDefined();
    await node.admin().get('/v1/notifications').expect(200);
  });

  it("says so in a list's capabilities: no `events` for TestItem, its other capabilities on", async () => {
    const { body } = await node.admin().get('/v1/lists/TestItem').expect(200);
    expect(body.capabilities).toMatchObject({ events: false, comments: true });
  });

  it('does not run the delivery worker, whatever WEBHOOKS_WORKER says', () => {
    expect(webhooksOptions({ eventTypes: [] }, {}).worker?.enabled).toBe(false);
  });
});
