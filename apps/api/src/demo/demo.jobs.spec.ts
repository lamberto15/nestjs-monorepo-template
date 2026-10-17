import { PermissionCatalog } from '../iam/access/permission-catalog.js';
import { CORE_SEED_ROLES } from '../iam/access/seed-roles.js';
import { PLATFORM_PERMISSIONS } from '../platform/ops/ops.policy.js';
import { demoPermissions, demoSeedJob } from './demo.jobs.js';
import type { FeatureDefinition } from '../features/feature.js';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { createdBy, definePermissions } from '../iam/access/permissions.js';

const invoices = pgTable('invoices', { ownerId: text('owner_id') });

/** A feature as the seed sees it: seed-role grants with conditions, its demo's needs. */
const INVOICES = {
  module: class InvoicesModule {},
  apiTag: { name: 'invoices', description: 'Invoices' },
  permissions: definePermissions({
    subjects: {
      Invoice: {
        label: 'Invoices',
        fields: {},
        conditions: { mine: createdBy('ownerId', invoices.ownerId) },
        actions: {
          read: { label: 'See invoices', conditions: [] },
          create: { label: 'Create invoices', conditions: [] },
          update: { label: 'Change invoices', conditions: ['mine'] },
          delete: { label: 'Delete invoices', conditions: [] },
          restore: { label: 'Restore invoices', conditions: [] },
        },
      },
    },
    seedRoles: [
      {
        key: 'editor',
        name: 'Invoice editor',
        description: 'Not the name a tenant sees: the core declares it first.',
        permissions: [
          ...['read', 'create', 'delete', 'restore'].map((action) => ({
            subject: 'Invoice',
            action,
            conditions: [],
          })),
          // The seed holds the whole permission it grants a part of.
          {
            subject: 'Invoice',
            action: 'update',
            conditions: [{ key: 'mine' }],
          },
        ],
      },
    ],
  }),
  demo: {
    seeder: class InvoicesDemo {
      seed() {
        return Promise.resolve({});
      }
    },
    permissions: [{ subject: 'Access', action: 'manageTags', conditions: [] }],
  },
} as unknown as FeatureDefinition;

/** What createAppModule hands IAM, for these features. */
const catalogOf = (features: Parameters<typeof demoPermissions>[0]) =>
  new PermissionCatalog({
    permissions: [
      CORE_SEED_ROLES,
      PLATFORM_PERMISSIONS,
      ...features.map((feature) => feature.permissions),
      demoPermissions(features),
    ],
  });

describe('the demo seed job', () => {
  it('stands without features: the core seed roles, users and teams only', () => {
    const catalog = catalogOf([]);
    expect(catalog.seedRoles.map((role) => role.key)).toEqual([
      'editor',
      'team-lead',
      'viewer',
    ]);
    expect(
      demoSeedJob([]).permissions.map((p) => `${p.subject}.${p.action}`),
    ).toEqual(['Access.manageUsers', 'Access.manageTeams', 'Ops.view']);
  });

  it("holds every grant of the roles it gives, unconditionally, and a feature's demo permissions", () => {
    catalogOf([INVOICES]);
    const held = demoSeedJob([INVOICES]).permissions;
    for (const action of ['read', 'create', 'update', 'delete', 'restore']) {
      expect(held).toContainEqual({
        subject: 'Invoice',
        action,
        conditions: [],
      });
    }
    expect(held).toContainEqual({
      subject: 'Access',
      action: 'manageTags',
      conditions: [],
    });
    expect(held.every((p) => (p.conditions ?? []).length === 0)).toBe(true);
  });

  it("keeps the core's names for the seed roles a feature adds to", () => {
    const editor = catalogOf([INVOICES]).seedRoles.find(
      (role) => role.key === 'editor',
    )!;
    expect(editor.name).toBe('Editor');
    expect(editor.description).toBe(CORE_SEED_ROLES.seedRoles![0].description);
    expect(editor.permissions.some((p) => p.subject === 'Invoice')).toBe(true);
  });
});
