import type { StoredRename } from './core/database/stored-renames.js';
import { rolePermissions } from './iam/iam.tables.js';
import {
  approvalPolicies,
  approvalRequests,
} from './platform/approvals/approvals.tables.js';
import { settingOverrides } from './platform/settings/settings.tables.js';

/**
 * Names the code renamed that rows store, rewritten by every migrate
 * (core/database/stored-renames.ts) after the migrations. Keep an entry
 * while a database from before it may still be migrated; the release
 * notes say which release a project must pass through (docs/releases.md).
 */
export const STORED_RENAMES: readonly StoredRename[] = [
  // Org units became teams (owner, 2026-10-17).
  { column: rolePermissions.action, from: 'manageOrgUnits', to: 'manageTeams' },
  {
    column: rolePermissions.conditions,
    from: 'inMyUnits',
    to: 'inMyTeams',
    json: true,
  },
  { column: settingOverrides.scope, from: 'orgUnit', to: 'team' },
  {
    column: approvalPolicies.definition,
    from: 'orgUnitRole',
    to: 'teamRole',
    json: true,
  },
  {
    column: approvalRequests.policy,
    from: 'orgUnitRole',
    to: 'teamRole',
    json: true,
  },
];
