import type { EmailVerificationService } from '@nestjs/authentication';
import { Logger } from '@nestjs/common';
import type { UsersRepository } from '../auth/users.repository.js';
import {
  VERIFICATION_RESEND_COOLDOWN_MS,
  VerificationRequests,
} from './verification-requests.service.js';

type Found = Awaited<ReturnType<UsersRepository['findActiveByEmail']>>;

const account = (emailVerified: boolean, passwordHash: string | null) =>
  ({
    user: { id: 'u1', email: 'ada@example.com', emailVerified },
    passwordHash,
  }) as unknown as Found;

function setup(found: Found, sentRecently = false) {
  const users = {
    findActiveByEmail: vi.fn(async () => found),
    verificationLinkSentSince: vi.fn(async () => sentRecently),
  };
  const emailVerification = { send: vi.fn(async () => ({})) };
  const service = new VerificationRequests(
    users as unknown as UsersRepository,
    emailVerification as unknown as EmailVerificationService,
  );
  return { service, users, emailVerification };
}

describe('VerificationRequests', () => {
  it('returns before the account is looked up', async () => {
    const { service, users, emailVerification } = setup(account(false, 'h'));
    service.request('  Ada@Example.com ');
    expect(users.findActiveByEmail).not.toHaveBeenCalled();
    await service.onModuleDestroy();
    expect(users.findActiveByEmail).toHaveBeenCalledWith('ada@example.com');
    expect(emailVerification.send).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u1', email: 'ada@example.com' }),
    );
  });

  it.each([
    ['an unknown address', null],
    ['a verified address', account(true, 'h')],
    ['an account without a password', account(false, null)],
  ])('sends nothing for %s', async (_name, found) => {
    const { service, emailVerification } = setup(found);
    service.request('ada@example.com');
    await service.onModuleDestroy();
    expect(emailVerification.send).not.toHaveBeenCalled();
  });

  it('sends at most one link per account in the cooldown', async () => {
    const { service, users, emailVerification } = setup(
      account(false, 'h'),
      true,
    );
    const before = Date.now();
    service.request('ada@example.com');
    await service.onModuleDestroy();
    expect(emailVerification.send).not.toHaveBeenCalled();
    const [userId, since] = users.verificationLinkSentSince.mock
      .calls[0] as unknown as [string, Date];
    expect(userId).toBe('u1');
    expect(before - since.getTime()).toBeGreaterThanOrEqual(
      VERIFICATION_RESEND_COOLDOWN_MS - 5,
    );
  });

  it('logs a failure instead of throwing it', async () => {
    const { service, emailVerification } = setup(account(false, 'h'));
    emailVerification.send.mockRejectedValueOnce(new Error('mail down'));
    const error = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    expect(() => service.request('ada@example.com')).not.toThrow();
    await service.onModuleDestroy();
    expect(error).toHaveBeenCalledWith(
      'A verification resend failed',
      expect.stringContaining('mail down'),
    );
    error.mockRestore();
  });
});
