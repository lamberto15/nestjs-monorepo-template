import { Policy } from '@nestjs/authorization';
import { eq } from 'drizzle-orm';
import { defineSystemJob } from '../../iam/access/permissions.js';
import {
  type RecordConditionFields,
  recordPermissions,
  RecordPolicy,
} from '../../platform/records/record-policy.js';
import { NOTE_CLIENT_PERMISSIONS, NOTE_SEED_ROLES } from './note-roles.js';
import { NOTE } from './note.record.js';
import type { Note } from './note.schemas.js';
import { notes } from './notes.tables.js';

/**
 * The publication workflow's steps (NotePublicationWorkflow), as the system
 * principal `system:note-publication`: it publishes drafts, the actor of
 * their `note.updated` entries, and asks for approval on their owners'
 * behalf.
 */
export const NOTE_PUBLICATION_JOB = defineSystemJob({
  key: 'note-publication',
  label: 'Note publication',
  description:
    'Publishes draft notes when their delay passes (or asks for approval first, for their owners).',
  permissions: [
    { subject: 'Note', action: 'update', conditions: [{ key: 'draft' }] },
  ],
});

/**
 * What can be done with notes, and the conditions an administrator may attach
 * (GET /v1/access/catalog): the standard actions, conditions and seed roles' grants,
 * from note.record.ts (recordPermissions: the recycle bin and units as it says), and what
 * notes add: the text's field-level permission, the `draft` condition (only a
 * draft changes or goes), and the example roles and client grants that use it.
 */
export const NOTE_PERMISSIONS = recordPermissions(NOTE, notes, {
  label: 'Notes (example)',
  // Field-level: a permission may grant reading or changing the text, or not.
  fields: { body: { label: "The note's text" } },
  conditions: {
    draft: {
      label: 'Still a draft',
      description: 'Only notes not yet published.',
      casl: () => ({ status: 'draft' }),
      sql: () => eq(notes.status, 'draft'),
    },
  },
  actions: {
    create: { label: 'Write notes', conditions: [] },
    update: { label: 'Change notes', conditions: ['mine', 'draft'] },
    delete: { label: 'Delete notes', conditions: ['mine', 'draft'] },
  },
  clientPermissions: NOTE_CLIENT_PERMISSIONS,
  seedRoles: NOTE_SEED_ROLES,
  systemJobs: [NOTE_PUBLICATION_JOB],
});

/**
 * Who may do what with a note: each action checked against its fields (RecordPolicy).
 * Business logic: the `draft` condition reads the note's status.
 */
@Policy()
export class NotePolicy extends RecordPolicy {
  protected override conditionFields(
    row: RecordConditionFields & Pick<Note, 'status'>,
  ) {
    return { ...super.conditionFields(row), status: row.status };
  }
}
