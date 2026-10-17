import {
  definePermissions,
  defineSystemJob,
} from '../iam/access/permissions.js';

/**
 * The demo seed (`pnpm db:seed:demo`, DemoSeeder), as the system principal
 * `system:demo-seed`: the actor of everything it writes. What it may do is
 * what it does, nothing implicit: users with roles, org units, tags, notes
 * with their tags, comments and a file.
 */
export const DEMO_SEED_JOB = defineSystemJob({
  key: 'demo-seed',
  label: 'Demo seed',
  description:
    'Creates demo users, org units, tags and notes on a development database (pnpm db:seed:demo); refuses any other.',
  permissions: [
    { subject: 'Access', action: 'manageUsers', conditions: [] },
    { subject: 'Access', action: 'manageOrgUnits', conditions: [] },
    { subject: 'Access', action: 'manageTags', conditions: [] },
    { subject: 'Note', action: 'create', conditions: [] },
    { subject: 'Note', action: 'read', conditions: [] },
    { subject: 'Note', action: 'update', conditions: [] },
    // Nobody grants what they can't do (AccessAdminService): the Editor
    // role the seed gives holds these two, the Viewer role Ops.view.
    { subject: 'Note', action: 'delete', conditions: [] },
    { subject: 'Note', action: 'restore', conditions: [] },
    { subject: 'Ops', action: 'view', conditions: [] },
  ],
});

/** Its declaration, handed to `IamModule.forRoot({ permissions })` in AppModule. */
export const DEMO_PERMISSIONS = definePermissions({
  subjects: {},
  systemJobs: [DEMO_SEED_JOB],
});
