import { tenantTables } from './tenant-tables.js';

describe('tenantTables', () => {
  const byName = new Map(tenantTables().map((info) => [info.name, info]));

  it('lists every table with a tenant_id, the global ones naming a tenant too', () => {
    for (const name of [
      'audit_log',
      'roles',
      'user_roles',
      'attachments',
      'invitations',
      'memberships',
      'api_keys',
    ]) {
      expect(byName.has(name), name).toBe(true);
    }
    // Global, no tenant_id: never part of one tenant's export.
    for (const name of ['tenants', 'users', 'sessions', 'idempotency_keys']) {
      expect(byName.has(name), name).toBe(false);
    }
  });

  it('pages by the primary key, composite ones included, in order', () => {
    expect(byName.get('roles')!.key.map((k) => k.property)).toEqual(['id']);
    expect(byName.get('memberships')!.key.map((k) => k.column.name)).toEqual([
      'tenant_id',
      'user_id',
    ]);
    expect(byName.get('user_roles')!.key.map((k) => k.property)).toEqual([
      'userId',
      'roleId',
    ]);
  });

  it('hides the hashes of stored credentials', () => {
    expect(byName.get('api_keys')!.hidden).toEqual(['keyHash']);
    expect(byName.get('invitations')!.hidden).toEqual(['tokenHash']);
    expect(byName.get('roles')!.hidden).toEqual([]);
  });
});
