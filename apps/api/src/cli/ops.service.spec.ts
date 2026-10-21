import { OpsError, OpsService } from './ops.service.js';

/** The checks that run before anything is read (the rest: test/ops-cli.e2e-spec.ts). */
describe('OpsService input checks', () => {
  const ops = new OpsService(
    ...(Array.from(
      { length: 11 },
      () => null,
    ) as unknown as ConstructorParameters<typeof OpsService>),
  );

  it('wants exactly one of a tenant and the platform for a setting', async () => {
    await expect(ops.deleteSetting('auth.requireMfa', {})).rejects.toThrow(
      OpsError,
    );
    await expect(
      ops.deleteSetting('auth.requireMfa', { tenant: 'acme', platform: true }),
    ).rejects.toThrow(/exactly one/);
  });

  it('refuses what is not an email address', async () => {
    for (const run of [
      () => ops.resetPassword('nope'),
      () => ops.removeMfa('nope'),
      () => ops.unlock('nope'),
      () => ops.adminCreate('nope'),
    ]) {
      await expect(run()).rejects.toThrow(/not an email address/);
    }
  });
});
