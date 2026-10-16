import { AsyncLocalStorage } from 'node:async_hooks';
import { ClsService, ClsServiceManager } from 'nestjs-cls';
import { inTenantOf, withTenant } from './tenant-job.js';
import { registerTenantTables, tenantTablesIn } from './tenant-pool.js';
import {
  assertUuid,
  BYPASS,
  currentTenantScope,
  NO_TENANT,
  requireTenantId,
  TenantScopeMissingError,
  tenantKey,
  tenantScope,
  tenantSettingsStatement,
} from './tenant-scope.js';

const A = '0199a000-0000-7000-8000-00000000000a';
const B = '0199a000-0000-7000-8000-00000000000b';

describe('the tenant scope', () => {
  it('sets the three settings as literals, local to the transaction', () => {
    expect(tenantSettingsStatement(tenantScope(A))).toBe(
      `select set_config('app.tenant_id', '${A}', true), set_config('app.read_tenants', '${A}', true), set_config('app.bypass_rls', '', true)`,
    );
    expect(tenantSettingsStatement(BYPASS)).toContain(
      "set_config('app.bypass_rls', 'on', true)",
    );
    expect(tenantSettingsStatement(NO_TENANT)).toContain(
      "set_config('app.tenant_id', '', true)",
    );
  });

  it('takes nothing but a UUID into a setting', () => {
    expect(() => tenantScope(`${A}', true); --`)).toThrow(TypeError);
    expect(() => assertUuid('ACME')).toThrow(TypeError);
    expect(() =>
      tenantSettingsStatement({
        tenantId: A,
        readTenants: [A, "x'"],
        bypass: false,
      }),
    ).toThrow(TypeError);
  });

  it('finds the tenant tables a statement names, quoted as Drizzle writes them', () => {
    registerTenantTables(['notes', 'roles'], ['audit_log']);
    expect(
      tenantTablesIn(
        'select "id" from "notes" inner join "users" on true where "notes"."tenant_id" = $1',
      ),
    ).toEqual(['notes']);
    expect(tenantTablesIn('insert into "roles" ("name") values ($1)')).toEqual([
      'roles',
    ]);
    expect(tenantTablesIn('update "public"."roles" set "name" = $1')).toEqual([
      'roles',
    ]);
    expect(tenantTablesIn('delete from "notes"')).toEqual(['notes']);
    // Global tables and the optional ones pass.
    expect(tenantTablesIn('select * from "users"')).toEqual([]);
    expect(tenantTablesIn('select * from "audit_log"')).toEqual([]);
  });

  it('reads the scope from the CLS context, and refuses a write without one', async () => {
    const cls = new ClsService(new AsyncLocalStorage());
    vi.spyOn(ClsServiceManager, 'getClsService').mockReturnValue(cls);
    expect(currentTenantScope()).toBeUndefined();
    expect(() => requireTenantId()).toThrow(TenantScopeMissingError);
    const seen = await inTenantOf({ tenantId: A }, async () => ({
      id: requireTenantId(),
      key: tenantKey('client:c1'),
      data: withTenant({ x: 1 }),
      inner: await inTenantOf({ tenantId: B }, async () => requireTenantId()),
      after: requireTenantId(),
    }));
    expect(seen).toEqual({
      id: A,
      key: `tenant:${A}:client:c1`,
      data: { x: 1, tenantId: A },
      inner: B,
      after: A,
    });
    await expect(inTenantOf({}, async () => 1)).rejects.toThrow(
      /carries no tenantId/,
    );
    expect(
      await inTenantOf({ tenantId: null }, async () => currentTenantScope()),
    ).toEqual(NO_TENANT);
  });
});
