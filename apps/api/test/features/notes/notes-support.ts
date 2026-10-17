import { randomUUID } from 'node:crypto';
import { signWebhook } from '@nestjs/webhooks/testing';
import type request from 'supertest';
import type { TestApp } from '../../support.js';

/**
 * The example feature's test helpers: here, next to its tests, so removing
 * notes (`pnpm feature:remove notes`) takes them too.
 */

/** Writes a note as an API client's bearer token, or as a user's agent. */
export function writeNote(
  node: TestApp,
  auth: string | request.Agent,
  body: Record<string, unknown> = { title: 'Hello', body: 'World' },
  key: string = randomUUID(),
) {
  const req =
    typeof auth === 'string'
      ? node.http().post('/v1/notes').set('Authorization', auth)
      : auth.post('/v1/notes');
  return req.set('Idempotency-Key', key).send(body);
}

/** POSTs an event signed as the example sender signs it (Standard Webhooks). */
export function exampleSender(
  node: TestApp,
  payload: unknown,
  {
    id = `msg_${randomUUID()}`,
    secret = process.env.EXAMPLE_SENDER_WEBHOOK_SECRET!,
  } = {},
) {
  const signed = signWebhook({ scheme: 'standard', secret, payload, id });
  return node
    .http()
    .post('/v1/webhooks/example-sender')
    .set(signed.headers)
    .send(signed.body);
}
