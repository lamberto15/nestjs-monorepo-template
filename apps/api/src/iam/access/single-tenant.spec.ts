import type { ConfigService } from '@nestjs/config';
import type { IamEnv } from '../iam.env.js';
import type { PermissionCatalog } from './permission-catalog.js';
import { SingleTenant } from './single-tenant.js';

/** The start-up check of SIGN_UP_ROLES (the rest: test/single-tenant.e2e-spec.ts). */
describe('SingleTenant', () => {
  const make = (env: Partial<IamEnv>) => {
    const config = {
      get: (key: keyof IamEnv) => env[key],
    } as unknown as ConfigService<IamEnv, true>;
    const catalog = {
      seedRoles: [{ key: 'editor' }, { key: 'viewer' }],
    } as unknown as PermissionCatalog;
    // Multi-tenant, or refused before the database: nothing else is reached.
    return new SingleTenant(
      config,
      null as never,
      null as never,
      null as never,
      null as never,
      catalog,
    );
  };

  it('refuses a role no declaration seeds, Administrator included', async () => {
    await expect(
      make({
        TENANCY: 'single',
        SIGN_UP_ROLES: ['editor', 'administrator'],
      }).onApplicationBootstrap(),
    ).rejects.toThrow(/administrator \(known: editor, viewer\)/);
  });

  it('ignores SIGN_UP_ROLES in a multi-tenant deployment', async () => {
    const tenant = make({ TENANCY: 'multi', SIGN_UP_ROLES: ['nobody'] });
    await expect(tenant.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(tenant.enabled).toBe(false);
  });
});
