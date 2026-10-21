import {
  defineSystemJob,
  definePermissions,
} from '../iam/access/permissions.js';

/**
 * The operator CLI (`pnpm ops`, src/cli): the break-glass path back into a
 * deployment (a locked-out administrator, a setting that locks everyone
 * out), run on a server by someone who holds its environment. The actor of
 * everything it writes is the system principal `system:ops`; each entry
 * also names the operator's OS user and host (`details.operator`).
 *
 * `permissions: []`: the commands keep to the account tables, the
 * settings and the suppression list directly, never through a check a
 * request's principal would pass, so nothing is granted that is not used.
 */
export const OPS_JOB = defineSystemJob({
  key: 'ops',
  label: 'Operator CLI',
  description:
    'Break-glass commands run on a server (pnpm ops): a one-time password, removing two-factor, unlocking an account, deleting a setting, creating an administrator.',
  permissions: [],
});

/** Its declaration, handed to `IamModule.forRoot({ permissions })` (createAppModule). */
export const opsPermissions = definePermissions({
  subjects: {},
  systemJobs: [OPS_JOB],
});
