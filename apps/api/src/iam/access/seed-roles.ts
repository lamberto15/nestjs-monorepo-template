import { definePermissions } from './permissions.js';

/**
 * The roles every tenant starts with, besides Administrator: the template's,
 * so they exist whatever features there are. Each feature adds its grants
 * to them by key (`seedRoles` with `editor`, `team-lead` or `viewer`:
 * merged, this declaration's name and description kept). Listed first in
 * AppModule, so these are the names a tenant sees. Editable through the
 * access API once made.
 */
export const CORE_SEED_ROLES = definePermissions({
  subjects: {},
  seedRoles: [
    {
      key: 'editor',
      name: 'Editor',
      description: 'Writes records and changes their own.',
      permissions: [],
    },
    {
      key: 'team-lead',
      name: 'Team lead',
      description: 'Sees the records of their teams and every team below them.',
      permissions: [],
    },
    {
      key: 'viewer',
      name: 'Viewer',
      description: 'Sees every record and the operations API, changes nothing.',
      permissions: [{ subject: 'Ops', action: 'view', conditions: [] }],
    },
  ],
});
