import type { FeatureDefinition } from '../features/feature.js';
import {
  definePermissions,
  defineSystemJob,
  type PermissionInput,
} from '../iam/access/permissions.js';
import { DEMO_USERS } from './demo-data.js';

/** What the seed itself writes, whatever the features: users with roles, teams. */
const CORE: PermissionInput[] = [
  { subject: 'Access', action: 'manageUsers', conditions: [] },
  { subject: 'Access', action: 'manageTeams', conditions: [] },
  { subject: 'Ops', action: 'view', conditions: [] },
];

/**
 * The demo seed (`pnpm db:seed:demo`, DemoSeeder), as the system principal
 * `system:demo-seed`: the actor of everything it writes. What it may do is
 * what it does, nothing implicit: users and teams, the features' demo data
 * (`FeatureDefinition.demo`), and every grant of the roles it gives (nobody
 * grants what they can't do: AccessAdminService).
 */
export function demoSeedJob(features: readonly FeatureDefinition[]) {
  const given = new Set(DEMO_USERS.flatMap((user) => user.roles));
  const permissions = [
    ...CORE,
    ...features.flatMap((feature) =>
      (feature.permissions.seedRoles ?? [])
        .filter((role) => given.has(role.key))
        // Unconditional: the seed grants a `mine` permission, it holds the whole one.
        .flatMap((role) =>
          role.permissions.map(({ subject, action }) => ({
            subject,
            action,
            conditions: [],
          })),
        ),
    ),
    ...features.flatMap((feature) => feature.demo?.permissions ?? []),
  ];
  const unique = new Map(
    permissions.map((p) => [
      `${p.subject}.${p.action}.${JSON.stringify(p.conditions ?? [])}`,
      p,
    ]),
  );
  return defineSystemJob({
    key: 'demo-seed',
    label: 'Demo seed',
    description:
      "Creates demo users, teams and the features' demo data on a development database (pnpm db:seed:demo); refuses any other.",
    permissions: [...unique.values()],
  });
}

/** Its declaration, handed to `IamModule.forRoot({ permissions })` (createAppModule). */
export const demoPermissions = (features: readonly FeatureDefinition[]) =>
  definePermissions({ subjects: {}, systemJobs: [demoSeedJob(features)] });
