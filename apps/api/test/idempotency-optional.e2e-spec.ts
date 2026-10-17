/**
 * IDEMPOTENCY=optional (docs/api-conventions.md, "Idempotency"): a key is
 * honoured when sent, never demanded; the OpenAPI document says so.
 */
import { randomUUID } from 'node:crypto';
import type request from 'supertest';
import { TEST_ITEM } from './fixtures/test-items/test-item.record.js';
import { fieldSamples } from '../src/platform/fields/fields.js';
import { bootApp, type TestApp } from './support.js';

// Read when AppModule loads: before the imports run.
vi.hoisted(() => {
  process.env.IDEMPOTENCY = 'optional';
});

describe('IDEMPOTENCY=optional (e2e)', () => {
  let node: TestApp;

  beforeAll(async () => {
    node = await bootApp();
  });
  afterAll(() => node.close());

  const samples = fieldSamples(TEST_ITEM.fields);
  const post = (agent: request.Agent, key?: string, sent = samples.body()) => {
    const call = agent.post('/v1/test-items');
    return (key ? call.set('Idempotency-Key', key) : call).send(sent);
  };

  it('creates without a key, once per request', async () => {
    const admin = node.admin();
    const first = await post(admin).expect(201);
    const second = await post(admin).expect(201);
    expect(second.body.id).not.toBe(first.body.id);
  });

  it('replays a key that is sent, and refuses it for another body', async () => {
    const admin = node.admin();
    const key = randomUUID();
    const sent = samples.body();
    const created = await post(admin, key, sent).expect(201);
    const replayed = await post(admin, key, sent).expect(201);
    expect(replayed.body.id).toBe(created.body.id);
    const other = await post(admin, key, {
      ...sent,
      ...samples.changed,
    }).expect(422);
    expect(other.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('documents Idempotency-Key as optional everywhere', async () => {
    const document = (await node.http().get('/api-json').expect(200)).body;
    const headers = Object.values<Record<string, { parameters?: unknown[] }>>(
      document.paths,
    )
      .flatMap((operations) => Object.values(operations))
      .flatMap((operation) => operation.parameters ?? [])
      .filter(
        (parameter): parameter is { name: string; required?: boolean } =>
          (parameter as { name?: string }).name === 'Idempotency-Key',
      );
    expect(headers.length).toBeGreaterThan(0);
    expect(headers.every((header) => header.required !== true)).toBe(true);
  });
});
