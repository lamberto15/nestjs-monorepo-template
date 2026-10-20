import { AsyncLocalStorage } from 'node:async_hooks';
import { ClsService, ClsServiceManager } from 'nestjs-cls';
import { signWebhook } from '@nestjs/webhooks/testing';
import {
  type ResolvedSender,
  TENANT_SENDER,
  TenantSenderScheme,
} from './tenant-sender.scheme.js';

const secret = (n: number) => `whsec_${Buffer.alloc(32, n).toString('base64')}`;
const scheme = new TenantSenderScheme();

const sender = (...secrets: string[]): ResolvedSender => ({
  id: 'sender-1',
  tenantId: 'tenant-1',
  name: 'crm',
  secrets,
});

/** Checks a signed webhook as the receiver does, with `resolved` in the request's context. */
function verify(
  resolved: ResolvedSender | undefined,
  signedWith: string,
  options: { id?: string; timestamp?: Date; tamper?: boolean } = {},
) {
  const signed = signWebhook({
    scheme: 'standard',
    secret: signedWith,
    payload: { type: 'x', data: {} },
    id: options.id ?? 'msg_1',
    timestamp: options.timestamp,
  });
  const cls = ClsServiceManager.getClsService();
  return cls.run(() => {
    if (resolved) {
      cls.set(TENANT_SENDER, resolved);
    }
    return scheme.verify(
      {
        headers: signed.headers,
        rawBody: Buffer.from(options.tamper ? `${signed.body} ` : signed.body),
      },
      [],
    );
  });
}

describe('the tenant senders’ signature scheme', () => {
  beforeAll(() => {
    // The request's context, as ClsModule's middleware gives it.
    vi.spyOn(ClsServiceManager, 'getClsService').mockReturnValue(
      new ClsService(new AsyncLocalStorage()),
    );
  });

  it('accepts the sender’s current secret, and the previous one while it is listed, with a key namespaced by the sender', () => {
    const result = verify(sender(secret(1), secret(2)), secret(2));
    expect(result).toMatchObject({ valid: true, id: 'sender-1:msg_1' });
    expect(verify(sender(secret(1)), secret(1))).toMatchObject({ valid: true });
  });

  it('refuses another sender’s secret, a changed body and a missing sender', () => {
    expect(verify(sender(secret(1)), secret(3))).toMatchObject({
      valid: false,
      reason: 'invalid-signature',
    });
    expect(
      verify(sender(secret(1)), secret(1), { tamper: true }),
    ).toMatchObject({ valid: false });
    expect(verify(undefined, secret(1))).toMatchObject({ valid: false });
  });

  it('refuses a webhook id too long to namespace', () => {
    expect(
      verify(sender(secret(1)), secret(1), { id: 'x'.repeat(201) }),
    ).toMatchObject({ valid: false, reason: 'malformed-header' });
  });
});
