import { randomUUID } from 'node:crypto';
import { bootApp, type TestApp } from './support.js';

describe('AI helper without a key (e2e)', () => {
  let node: TestApp;
  beforeAll(async () => {
    node = await bootApp();
  });
  afterAll(async () => {
    await node.close();
  });

  it('answers 503 ai_unavailable and sends nothing anywhere', async () => {
    const refused = await node
      .admin()
      .post('/v1/ai/runs')
      .send({ source: 'note', recordId: randomUUID(), task: 'summarize' })
      .expect(503);
    expect(refused.body.code).toBe('ai_unavailable');
  });
});
