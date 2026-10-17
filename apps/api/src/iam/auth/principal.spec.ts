import {
  actorOf,
  assertRequestPrincipal,
  isSystemPrincipal,
  type Principal,
  principalKey,
  systemPrincipal,
} from './principal.js';

const job = { key: 'account-deletion', label: 'Account deletion' };

describe('the system principal', () => {
  it('is keyed and named after its job', () => {
    const system = systemPrincipal(job);
    expect(principalKey(system)).toBe('system:account-deletion');
    expect(actorOf(system)).toEqual({
      actor: 'system:account-deletion',
      actorLabel: 'System: Account deletion',
    });
  });

  it('is only one when made in code: data saying "system" is not', () => {
    const system = systemPrincipal(job);
    expect(isSystemPrincipal(system)).toBe(true);
    expect(isSystemPrincipal({ ...system })).toBe(true); // a copy in code keeps it
    // JSON (a token's claims, a queued job, a stored owner) drops the mark.
    expect(isSystemPrincipal(JSON.parse(JSON.stringify(system)))).toBe(false);
    expect(isSystemPrincipal({ kind: 'system', id: 'account-deletion' })).toBe(
      false,
    );
    expect(isSystemPrincipal({ kind: 'user', id: 'u1' })).toBe(false);
    expect(isSystemPrincipal(null)).toBe(false);
  });

  it('is refused where only a request principal belongs', () => {
    expect(() =>
      assertRequestPrincipal(systemPrincipal(job), 'A queued transfer'),
    ).toThrow(
      'A queued transfer takes a user or an API client, not the system principal (system:account-deletion).',
    );
    const client: Principal = {
      kind: 'client',
      id: 'c1',
      name: 'Shop',
      tenantId: '00000000-0000-0000-0000-000000000001',
    };
    expect(() =>
      assertRequestPrincipal(client, 'A queued transfer'),
    ).not.toThrow();
  });
});
