import { bootApp, type TestApp } from './support.js';

/** POST /v1/client-errors: apps/web/src/lib/report-error.ts's `send`. */
describe('client errors (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(() => node.close());

  it('logs a report with no sign-in, and answers 204', async () => {
    await node
      .http()
      .post('/v1/client-errors')
      .send({
        id: 'abc12345',
        source: 'window',
        message: 'TypeError: boom',
        stack: 'TypeError: boom\n  at x (app.js:1:1)',
        path: '/sign-in',
      })
      .expect(204);
  });

  it('refuses a report past the field limits', async () => {
    const res = await node
      .http()
      .post('/v1/client-errors')
      .send({
        id: 'abc12345',
        source: 'window',
        message: 'x'.repeat(2001),
        path: '/sign-in',
      })
      .expect(400);
    expect(res.body.code).toBe('validation_failed');
  });

  it('refuses an unknown source', async () => {
    await node
      .http()
      .post('/v1/client-errors')
      .send({
        id: 'abc12345',
        source: 'made-up',
        message: 'boom',
        path: '/sign-in',
      })
      .expect(400);
  });
});
