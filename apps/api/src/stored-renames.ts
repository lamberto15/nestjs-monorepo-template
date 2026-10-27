import type { StoredRename } from './core/database/stored-renames.js';
import { rolePermissions, roles } from './iam/iam.tables.js';
import {
  approvalPolicies,
  approvalRequests,
} from './platform/approvals/approvals.tables.js';
import { settingOverrides } from './platform/settings/settings.tables.js';
import { savedViews } from './platform/views/views.tables.js';

/**
 * Names the code renamed that rows store, rewritten by every migrate
 * (core/database/stored-renames.ts) after the migrations, in this order
 * (a name renamed twice goes through both). Keep an entry while a database
 * from before it may still be migrated; the release notes say which
 * release a project must pass through (docs/releases.md).
 */
export const STORED_RENAMES: readonly StoredRename[] = [
  // Org units became teams (owner, 2026-10-17). Its `inMyUnits` → `inMyTeams`
  // is gone: `inMyUnits` is a condition again (direct units only), and a
  // database still holding the old one must pass through the release that
  // had it.
  { column: rolePermissions.action, from: 'manageOrgUnits', to: 'manageTeams' },
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
  // Teams became organizational units (#595). `inMyTeams` covered a
  // user's teams and every team below them: `inMyUnitsAndBelow`.
  {
    column: rolePermissions.action,
    from: 'manageTeams',
    to: 'manageOrganizationalUnits',
  },
  {
    column: rolePermissions.conditions,
    from: 'inMyTeams',
    to: 'inMyUnitsAndBelow',
    json: true,
  },
  { column: settingOverrides.scope, from: 'team', to: 'unit' },
  { column: savedViews.visibility, from: 'team', to: 'unit' },
  {
    column: approvalPolicies.definition,
    from: 'teamRole',
    to: 'unitRole',
    json: true,
  },
  {
    column: approvalRequests.policy,
    from: 'teamRole',
    to: 'unitRole',
    json: true,
  },
  { column: roles.key, from: 'team-lead', to: 'unit-lead' },
  // The seeded lead role's key, where approval rules name it.
  {
    column: approvalPolicies.definition,
    from: 'team-lead',
    to: 'unit-lead',
    json: true,
  },
  {
    column: approvalRequests.policy,
    from: 'team-lead',
    to: 'unit-lead',
    json: true,
  },
];
