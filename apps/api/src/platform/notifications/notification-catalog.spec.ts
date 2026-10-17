import { z } from 'zod';
import type { Principal } from '../../iam/auth/principal.js';
import {
  effectiveSettings,
  preferencesSchema,
} from './notification-preferences.js';
import type {
  NotificationChannel,
  NotificationTypeDeclaration,
} from './notification.types.js';

const user: Principal = {
  kind: 'user',
  id: 'u1',
  email: 'u@example.com',
  name: 'U',
  emailVerified: true,
  locale: null,
  timezone: null,
  tenantId: 't1',
};
const client: Principal = {
  kind: 'client',
  id: 'c1',
  name: 'C',
  tenantId: 't1',
};

const realtime: NotificationChannel = {
  name: 'realtime',
  supports: () => true,
};
const email: NotificationChannel<'immediate' | 'hourly' | 'daily' | false> = {
  name: 'email',
  settings: {
    schema: z.union([
      z.enum(['immediate', 'hourly', 'daily']),
      z.literal(false),
    ]),
    off: false,
  },
  supports: (recipient) => recipient.kind === 'user',
};
const webhook: NotificationChannel<boolean> = {
  name: 'webhook',
  settings: { schema: z.boolean(), off: false },
  supports: (recipient) => recipient.kind === 'client',
};
const channels = [realtime, email, webhook];

const published = {
  type: 'comment.mentioned',
  channels: { email: 'immediate', webhook: true },
} as NotificationTypeDeclaration;
const deleted = {
  type: 'approval.cancelled',
  channels: { email: 'immediate' },
  mandatory: true,
} as NotificationTypeDeclaration;

describe('effectiveSettings', () => {
  it("reports only the channels the recipient's kind can be reached by, with the type's defaults", () => {
    expect(effectiveSettings(published, undefined, user, channels)).toEqual({
      email: 'immediate',
    });
    expect(effectiveSettings(published, undefined, client, channels)).toEqual({
      webhook: true,
    });
  });

  it('is off for a channel the type leaves out', () => {
    expect(effectiveSettings(deleted, undefined, client, channels)).toEqual({
      webhook: false,
    });
  });

  it('applies a valid override and ignores an invalid one', () => {
    expect(
      effectiveSettings(published, { email: 'daily' }, user, channels),
    ).toEqual({ email: 'daily' });
    expect(
      effectiveSettings(published, { email: 'sometimes' }, user, channels),
    ).toEqual({ email: 'immediate' });
    expect(
      effectiveSettings(published, { email: false }, user, channels),
    ).toEqual({ email: false });
  });

  it('keeps a mandatory type on when a stored override would switch it off', () => {
    expect(
      effectiveSettings(deleted, { email: false }, user, channels),
    ).toEqual({ email: 'immediate' });
    expect(
      effectiveSettings(deleted, { email: 'hourly' }, user, channels),
    ).toEqual({ email: 'hourly' });
  });
});

describe('preferencesSchema', () => {
  const forUser = preferencesSchema([published, deleted], user, channels);
  const forClient = preferencesSchema([published, deleted], client, channels);
  const paths = (result: z.ZodSafeParseResult<unknown>) =>
    result.success ? [] : result.error.issues.map((i) => i.path.join('.'));

  it('takes the declared types and the settable channels', () => {
    expect(
      forUser.safeParse({ 'comment.mentioned': { email: 'daily' } }).success,
    ).toBe(true);
    expect(
      forClient.safeParse({ 'comment.mentioned': { webhook: false } }).success,
    ).toBe(true);
    expect(forUser.safeParse({}).success).toBe(true);
  });

  it('refuses an unknown type, an unknown channel, and a channel the kind cannot use', () => {
    expect(
      paths(forUser.safeParse({ 'comment.nope': { email: false } })),
    ).toEqual(['comment.nope']);
    expect(
      paths(forUser.safeParse({ 'comment.mentioned': { sms: true } })),
    ).toEqual(['comment.mentioned.sms']);
    expect(
      paths(forClient.safeParse({ 'comment.mentioned': { email: false } })),
    ).toEqual(['comment.mentioned.email']);
    expect(
      paths(forUser.safeParse({ 'comment.mentioned': { email: 'often' } })),
    ).toEqual(['comment.mentioned.email']);
  });

  it('refuses switching a mandatory type off, but takes another frequency', () => {
    expect(
      paths(forUser.safeParse({ 'approval.cancelled': { email: false } })),
    ).toEqual(['approval.cancelled.email']);
    expect(
      forUser.safeParse({ 'approval.cancelled': { email: 'daily' } }).success,
    ).toBe(true);
  });
});
