import { OpsError, OpsService } from './ops.service.js';

/** The checks that run before anything is read (the rest: test/ops-cli.e2e-spec.ts). */
describe('OpsService input checks', () => {
  const ops = new OpsService(
    ...(Array.from(
      { length: 13 },
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

  // The address check alone (the lookup after it needs a database).
  const email = (input: string) => ops['email'](input);

  it('takes an address with a dot in its domain, and nothing else', () => {
    for (const address of [
      'ada@example.com',
      'Ada.Lovelace+ops@mail.example.co.uk',
      'a@b.c',
      'a@.b.c',
      'a@b..c',
    ]) {
      expect(email(address), address).toBe(address.toLowerCase());
    }
    for (const input of [
      'ada',
      'ada@example',
      'ada@.com',
      'ada@example.',
      '@example.com',
      'ada@@example.com',
      'ada@exa mple.com',
      'a@b@c.d',
    ]) {
      expect(() => email(input), input).toThrow(/not an email address/);
    }
  });

  it('checks a long address of dots in linear time', () => {
    // The pattern it replaces took about a second here (quadratic).
    const input = `a@${'a.'.repeat(25_000)}@`;
    const started = performance.now();
    expect(() => email(input)).toThrow(/not an email address/);
    expect(performance.now() - started).toBeLessThan(250);
  });
});
