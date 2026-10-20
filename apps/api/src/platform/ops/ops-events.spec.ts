import type { IdempotencyEvent } from '@nestjs/idempotency';
import type { LocksEvent } from '@nestjs/locks';
import type { MailEvent } from '@nestjs/mail';
import type { OutboxEvent, OutboxMessage } from '@nestjs/outbox';
import type { ResilienceEvent } from '@nestjs/resilience';
import type { WebhooksEvent } from '@nestjs/webhooks';
import type { WorkflowEvent } from '@nestjs/workflows';
import { REDACTED } from '../../core/logging/redaction.js';
import { opsEvent } from './ops-events.js';

const AT = 1_700_000_000_000;

// Built at runtime: what a secret scanner would refuse in a source file.
const bearer = () => `Bearer tok-${Date.now()}-abcdefghij`;

const message: OutboxMessage = {
  id: 'm1',
  topic: 'mail.send',
  payload: { to: 'a@example.com' },
  headers: { 'x-trace': 't1' },
  key: 'k',
  createdAt: AT,
  availableAt: AT,
  attempts: 1,
  lastError: null,
};
const delivery = {
  id: 'd1',
  messageId: 'm1',
  endpointId: 'e1',
  tenant: null,
  type: 'note.created',
  status: 'pending' as const,
  attempts: 1,
  nextAttemptAt: AT,
  lastAttemptAt: AT,
  lastStatusCode: 500,
  lastError: 'boom',
  failureReason: null,
  createdAt: AT,
  completedAt: null,
};
const wf = { id: 'w1', workflow: 'onboarding', version: 1, at: AT };

/** One of every event type each engine emits: the schema must take them all. */
const samples = {
  workflow: [
    { ...wf, type: 'workflow-started' },
    { ...wf, type: 'workflow-resumed', run: 2 },
    {
      ...wf,
      type: 'workflow-suspended',
      wakeAt: null,
      waits: [{ signal: 's', key: null }],
    },
    { ...wf, type: 'workflow-compensating', error: failure() },
    { ...wf, type: 'workflow-completed', output: { ok: true } },
    { ...wf, type: 'workflow-failed', error: failure() },
    { ...wf, type: 'workflow-cancelled', error: failure() },
    { ...wf, type: 'workflow-compensation-failed', error: failure() },
    {
      ...wf,
      type: 'step-completed',
      step: 'a',
      attempt: 1,
      durationMs: 5,
    },
    {
      ...wf,
      type: 'step-failed',
      step: 'a',
      attempt: 1,
      error: failure(),
      retryAt: null,
    },
    { ...wf, type: 'step-compensated', step: 'a', attempt: 1 },
    {
      ...wf,
      type: 'child-started',
      child: 'c',
      childWorkflow: 'x',
      childVersion: 1,
    },
    {
      ...wf,
      type: 'signal-received',
      wait: 'w',
      signal: 's',
      signalId: 3,
    },
    { ...wf, type: 'signal-timed-out', wait: 'w', signal: 's' },
    { ...wf, type: 'journal-large', entries: 10, bytes: 100 },
    { ...wf, type: 'custom-status', status: { step: 2 } },
    { ...wf, type: 'workflow-retried', from: 'failed', error: null },
    { ...wf, type: 'workflow-deleted', status: 'completed' },
    {
      ...wf,
      type: 'schedule-skipped',
      reason: 'missed',
      from: AT,
      to: AT + 1,
    },
  ] satisfies WorkflowEvent[],
  webhooks: [
    {
      type: 'delivered',
      delivery,
      statusCode: 200,
      attempt: 1,
      durationMs: 9,
    },
    {
      type: 'retry-scheduled',
      delivery,
      error: new Error('down'),
      statusCode: null,
      attempt: 1,
      delayMs: 1000,
    },
    {
      type: 'delivery-failed',
      delivery,
      error: 'gave up',
      statusCode: 500,
      attempt: 5,
      reason: 'exhausted',
    },
    {
      type: 'endpoint-disabled',
      endpointId: 'e1',
      tenant: 't',
      reason: 'failing',
    },
    {
      type: 'destination-blocked',
      endpointId: 'e1',
      tenant: null,
      reason: 'private address',
      address: undefined,
    },
    {
      type: 'verification-failed',
      receiver: 'mail',
      reason: 'invalid-signature',
    },
  ] satisfies WebhooksEvent[],
  outbox: [
    { type: 'published', message, transport: 'local', durationMs: 2 },
    {
      type: 'retry-scheduled',
      message,
      transport: undefined,
      error: new Error('x'),
      attempt: 1,
      delayMs: 10,
    },
    {
      type: 'dead-lettered',
      message,
      transport: 'local',
      error: new Error('x'),
      attempt: 5,
      reason: 'exhausted',
    },
    { type: 'lease-lost', message },
  ] satisfies OutboxEvent[],
  idempotency: [
    {
      type: 'replayed',
      context: 'http',
      handler: 'A.b',
      key: 'k',
      status: 200,
    },
    {
      type: 'rejected',
      context: 'http',
      handler: 'A.b',
      code: 'IDEMPOTENCY_KEY_REUSED',
      status: 422,
    },
    {
      type: 'lock-lost',
      context: 'http',
      handler: 'A.b',
      key: 'k',
      scope: 's',
      phase: 'extend',
    },
  ] satisfies IdempotencyEvent[],
  locks: [
    { type: 'lock-lost', key: 'k', fencingToken: 1, detectedBy: 'renewal' },
    { type: 'leadership-acquired', key: 'k', fencingToken: 2 },
    { type: 'leadership-lost', key: 'k', fencingToken: 2, reason: 'lost' },
  ] satisfies LocksEvent[],
  mail: [
    {
      type: 'sent',
      messageId: 'm',
      recipients: ['a@example.com'],
      subject: 'Hi',
      transport: 'smtp',
      attempts: 1,
      durationMs: 3,
      providerMessageId: 'p',
    },
    {
      type: 'failed',
      messageId: 'm',
      mail: 'welcome',
      recipients: ['a@example.com'],
      subject: 'Hi',
      transport: 'smtp',
      attempts: 3,
      durationMs: 3,
      error: new Error('refused'),
      permanent: true,
    },
  ] satisfies MailEvent[],
  resilience: [
    {
      type: 'retry',
      policy: 'p',
      attempt: 1,
      delayMs: 5,
      error: new Error('x'),
    },
    { type: 'timeout', policy: 'p', source: 's', timeoutMs: 100 },
    { type: 'circuit-open', policy: 'p', from: 'closed', to: 'open' },
    { type: 'circuit-half-open', policy: 'p', from: 'open', to: 'half-open' },
    { type: 'circuit-closed', policy: 'p', from: 'half-open', to: 'closed' },
    { type: 'circuit-rejected', policy: 'p', retryAfterMs: 5 },
    {
      type: 'bulkhead-rejected',
      policy: 'p',
      reason: 'full',
      active: 1,
      queued: 2,
    },
    { type: 'rate-limited', policy: 'p', retryAfterMs: 5 },
    { type: 'fallback', policy: 'p', error: new Error('x') },
  ] satisfies ResilienceEvent[],
};

/** A workflow's serialized error, stack included (the engine keeps it). */
function failure() {
  return {
    name: 'CardDeclinedError',
    message: 'Declined',
    stack: 'CardDeclinedError: Declined\n    at charge (/app/dist/pay.js:1:1)',
  };
}

describe('opsEvent', () => {
  for (const [source, events] of Object.entries(samples)) {
    it(`takes every ${source} event the engine emits, tagged with its source and a time`, () => {
      for (const event of events) {
        const data = opsEvent(source as keyof typeof samples, event, AT);
        expect(data, JSON.stringify(event)).toMatchObject({
          source,
          type: event.type,
          at: AT,
        });
      }
    });
  }

  it('sends an error as a name and a message, never a stack', () => {
    const data = opsEvent(
      'workflow',
      { ...wf, type: 'workflow-failed', error: failure() },
      AT,
    );
    expect(data).toMatchObject({
      error: { name: 'CardDeclinedError', message: 'Declined' },
    });
    expect(JSON.stringify(data)).not.toContain('pay.js');
    const thrown = opsEvent(
      'resilience',
      { type: 'fallback', policy: 'p', error: new Error('x') },
      AT,
    );
    expect(JSON.stringify(thrown)).not.toContain('.ts:');
  });

  it("keeps a resilience event's own source as origin, the tag as source", () => {
    expect(
      opsEvent(
        'resilience',
        { type: 'timeout', policy: 'p', source: 'billing', timeoutMs: 100 },
        AT,
      ),
    ).toMatchObject({ source: 'resilience', origin: 'billing' });
  });

  it('masks a secret in an error, a payload and a header before it leaves', () => {
    const credential = bearer();
    const data = opsEvent(
      'outbox',
      {
        type: 'dead-lettered',
        message: {
          ...message,
          headers: { Authorization: credential },
          payload: { password: 'hunter2-long', to: 'a@example.com' },
        },
        transport: 'local',
        error: new Error(`upstream said Authorization: ${credential}`),
        attempt: 5,
        reason: 'exhausted',
      } satisfies OutboxEvent,
      AT,
    );
    const text = JSON.stringify(data);
    expect(text).not.toContain(credential.slice(7));
    expect(text).not.toContain('hunter2-long');
    expect(text).toContain(REDACTED);
    expect(data).toMatchObject({
      message: { payload: { to: 'a@example.com' } },
    });
  });

  it('leaves out what the schema does not declare', () => {
    const data = opsEvent('locks', {
      type: 'leadership-acquired',
      key: 'k',
      fencingToken: 1,
      extra: 'not declared',
    });
    expect(data).not.toHaveProperty('extra');
  });

  it('leaves an event out, and carries on, when it does not match', () => {
    expect(
      opsEvent('locks', { type: 'a-new-event', key: 'k' }),
    ).toBeUndefined();
  });
});
