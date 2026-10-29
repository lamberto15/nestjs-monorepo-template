import { Policy } from '@nestjs/authorization';
import { eq } from 'drizzle-orm';
import { AccessService } from '../../iam/access/access.service.js';
import {
  createdBy,
  definePermissions,
  defineSystemJob,
  inMyUnits,
  inMyUnitsAndBelow,
  inUnitsILeadAndBelow,
} from '../../iam/access/permissions.js';
import type { Principal } from '../../iam/auth/principal.js';
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

/** Whose notes a reader sees, and restores: their own, or their units'. */
const UNIT_READ = [
  'mine',
  'inMyUnits',
  'inMyUnitsAndBelow',
  'inUnitsILeadAndBelow',
];

/**
 * What can be done with notes, and the conditions an admin may attach. Passed
 * to `IamModule.forRoot()` in AppModule: the access API lists it
 * (GET /access/catalog), roles combine it. Each condition has a CASL form (one note) and a SQL form (lists).
 */
export const NOTE_PERMISSIONS = definePermissions({
  subjects: {
    Note: {
      label: 'Notes (example)',
      names: { singular: 'Note', plural: 'Notes' },
      // Field-level: a permission may grant reading or changing the text, or not.
      fields: {
        body: { label: "The note's text" },
        // Every custom field at once: per-field permissions would need each key declared (see docs/custom-fields.md).
        custom: { label: 'The custom fields' },
      },
      conditions: {
        mine: createdBy('ownerId', notes.ownerId),
        inMyUnits: inMyUnits('unitId', notes.unitId),
        inMyUnitsAndBelow: inMyUnitsAndBelow('unitId', notes.unitId),
        inUnitsILeadAndBelow: inUnitsILeadAndBelow('unitId', notes.unitId),
        draft: {
          label: 'Still a draft',
          description: 'Only notes not yet published.',
          casl: () => ({ status: 'draft' }),
          sql: () => eq(notes.status, 'draft'),
        },
      },
      actions: {
        read: { label: 'See notes', conditions: UNIT_READ },
        create: { label: 'Write notes', conditions: [] },
        update: { label: 'Change notes', conditions: ['mine', 'draft'] },
        delete: { label: 'Delete notes', conditions: ['mine', 'draft'] },
        restore: {
          label: 'See deleted notes and restore them',
          conditions: UNIT_READ,
        },
        // In no example role: an administrator chooses who may show notes outside the tenant.
        share: { label: 'Share notes by link', conditions: UNIT_READ },
      },
    },
  },
  // What every API client may do, on top of its roles: write notes, see its own, delete its own drafts, restore its own.
  clientPermissions: [
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
  ],
  // Example roles for a new installation; editable through the access API.
  seedRoles: [
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
  ],
  systemJobs: [NOTE_PUBLICATION_JOB],
});

/** The fields of a note its conditions read. */
type NoteFields = Pick<Note, 'ownerId' | 'status' | 'unitId' | 'deletedAt'>;
const noteFields = ({ ownerId, status, unitId, deletedAt }: NoteFields) => ({
  ownerId,
  status,
  unitId,
  deletedAt, // a deleted note can only be restored (AccessService.can)
});

@Policy()
export class NotePolicy {
  constructor(private readonly access: AccessService) {}

  create(user: Principal | null) {
    return this.access.can(user, 'create', 'Note');
  }

  read(user: Principal | null, note: NoteFields) {
    return this.access.can(user, 'read', 'Note', noteFields(note));
  }

  update(user: Principal | null, note: NoteFields) {
    return this.access.can(user, 'update', 'Note', noteFields(note));
  }

  delete(user: Principal | null, note: NoteFields) {
    return this.access.can(user, 'delete', 'Note', noteFields(note));
  }

  restore(user: Principal | null, note: NoteFields) {
    return this.access.can(user, 'restore', 'Note', noteFields(note));
  }

  /** A read-only link to it (POST /v1/notes/{id}/shares). */
  share(user: Principal | null, note: NoteFields) {
    return this.access.can(user, 'share', 'Note', noteFields(note));
  }
}
