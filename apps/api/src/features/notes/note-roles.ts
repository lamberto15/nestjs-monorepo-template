import type {
  PermissionInput,
  SeedRole,
} from '../../iam/access/permissions.js';

/**
 * What the example's roles and API clients may do with notes, and why they
 * are not the standard grants (note.record.ts `grants: 'none'`,
 * `clientAccess: false`): a note changes or goes only while it is a draft
 * (the `draft` condition, note.policy.ts). Business logic.
 */

/** What every API client may do, on top of its roles: write notes, see its own, delete its own drafts, restore its own. */
export const NOTE_CLIENT_PERMISSIONS: PermissionInput[] = [
  { subject: 'Note', action: 'create', conditions: [] },
  { subject: 'Note', action: 'read', conditions: [{ key: 'mine' }] },
  {
    subject: 'Note',
    action: 'update',
    conditions: [{ key: 'mine' }, { key: 'draft' }],
  },
  {
    subject: 'Note',
    action: 'delete',
    conditions: [{ key: 'mine' }, { key: 'draft' }],
  },
  { subject: 'Note', action: 'restore', conditions: [{ key: 'mine' }] },
];

/** Example roles for a new installation; editable through the access API. */
export const NOTE_SEED_ROLES: SeedRole[] = [
  {
    key: 'editor',
    name: 'Editor',
    description:
      'Writes notes, sees their own, deletes their own drafts and restores them. (Example role: replace with your own.)',
    permissions: [
      { subject: 'Note', action: 'read', conditions: [{ key: 'mine' }] },
      { subject: 'Note', action: 'create', conditions: [] },
      {
        subject: 'Note',
        action: 'update',
        conditions: [{ key: 'mine' }, { key: 'draft' }],
      },
      {
        subject: 'Note',
        action: 'delete',
        conditions: [{ key: 'mine' }, { key: 'draft' }],
      },
      { subject: 'Note', action: 'restore', conditions: [{ key: 'mine' }] },
    ],
  },
  {
    key: 'unit-lead',
    name: 'Unit lead',
    description:
      'Sees the notes of the units they lead and every unit below them. (Example role: replace with your own.)',
    permissions: [
      {
        subject: 'Note',
        action: 'read',
        conditions: [{ key: 'inUnitsILeadAndBelow' }],
      },
    ],
  },
  {
    key: 'viewer',
    name: 'Viewer',
    description: 'Sees every note and the operations API, changes nothing.',
    permissions: [
      { subject: 'Note', action: 'read', conditions: [] },
      { subject: 'Ops', action: 'view', conditions: [] },
    ],
  },
];
