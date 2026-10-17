import { NOTES_FEATURE } from '../features/notes/notes.feature.js';
import { PermissionCatalog } from '../iam/access/permission-catalog.js';
import { CORE_SEED_ROLES } from '../iam/access/seed-roles.js';
import { PLATFORM_PERMISSIONS } from '../platform/ops/ops.policy.js';
import { demoPermissions, demoSeedJob } from './demo.jobs.js';

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
    catalogOf([NOTES_FEATURE]);
    const held = demoSeedJob([NOTES_FEATURE]).permissions;
    for (const action of ['read', 'create', 'update', 'delete', 'restore']) {
      expect(held).toContainEqual({ subject: 'Note', action, conditions: [] });
    }
    expect(held).toContainEqual({
      subject: 'Access',
      action: 'manageTags',
      conditions: [],
    });
    expect(held.every((p) => (p.conditions ?? []).length === 0)).toBe(true);
  });

  it("keeps the core's names for the seed roles a feature adds to", () => {
    const editor = catalogOf([NOTES_FEATURE]).seedRoles.find(
      (role) => role.key === 'editor',
    )!;
    expect(editor.name).toBe('Editor');
    expect(editor.description).toBe(CORE_SEED_ROLES.seedRoles![0].description);
    expect(editor.permissions.some((p) => p.subject === 'Note')).toBe(true);
  });
});
