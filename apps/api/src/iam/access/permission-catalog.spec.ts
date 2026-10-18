import { createMongoAbility, subject } from '@casl/ability';
import type { I18nService } from '@nestjs/i18n';
import { eq } from 'drizzle-orm';
import { pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { PLATFORM_PERMISSIONS } from '../../platform/ops/ops.policy.js';
import type { UserPrincipal } from '../auth/principal.js';
import { mergeConditions, PermissionCatalog } from './permission-catalog.js';
import { createdBy, definePermissions, inMyTeams } from './permissions.js';

/** A sample resource: owned, in a team, with a draft status. */
const notes = pgTable('notes', {
  ownerId: text('owner_id').notNull(),
  teamId: uuid('team_id'),
  status: text('status').notNull(),
});
const NOTE_PERMISSIONS = definePermissions({
  subjects: {
    Note: {
      label: 'Notes',
      fields: { body: { label: "The note's text" } },
      conditions: {
        mine: createdBy('ownerId', notes.ownerId),
        inMyTeams: inMyTeams('teamId', notes.teamId),
        draft: {
          label: 'Still a draft',
          description: 'Only notes not yet published.',
          casl: () => ({ status: 'draft' }),
          sql: () => eq(notes.status, 'draft'),
        },
      },
      actions: {
        read: { label: 'See notes', conditions: ['mine', 'inMyTeams'] },
        create: { label: 'Write notes', conditions: [] },
        update: { label: 'Change notes', conditions: ['mine', 'draft'] },
        delete: { label: 'Delete notes', conditions: ['mine', 'draft'] },
        restore: { label: 'Restore notes', conditions: ['mine', 'inMyTeams'] },
      },
    },
  },
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
  seedRoles: [
    {
      key: 'editor',
      name: 'Editor',
      description: 'Writes notes and sees their own.',
      permissions: [
        { subject: 'Note', action: 'read', conditions: [{ key: 'mine' }] },
        { subject: 'Note', action: 'create', conditions: [] },
      ],
    },
    {
      key: 'team-lead',
      name: 'Team lead',
      description: 'Sees the notes of their teams.',
      permissions: [
        { subject: 'Note', action: 'read', conditions: [{ key: 'inMyTeams' }] },
      ],
    },
    {
      key: 'viewer',
      name: 'Viewer',
      description: 'Sees every note and the operations API.',
      permissions: [
        { subject: 'Note', action: 'read', conditions: [] },
        { subject: 'Ops', action: 'view', conditions: [] },
      ],
    },
  ],
});

const sam: UserPrincipal = {
  kind: 'user',
  id: 'sam',
  email: 'sam@example.com',
  name: 'Sam',
  tenantId: null,
  emailVerified: true,
  locale: null,
  timezone: null,
};

const catalog = new PermissionCatalog({
  permissions: [PLATFORM_PERMISSIONS, NOTE_PERMISSIONS],
});

const note = (fields: Record<string, unknown>) =>
  subject('Note', { ownerId: 'user:sam', status: 'draft', ...fields });

function canDelete(
  conditions: Record<string, unknown> | undefined,
  record: object,
) {
  const ability = createMongoAbility([
    { action: 'delete', subject: 'Note', ...(conditions && { conditions }) },
  ]);
  return ability.can('delete', record as never);
}

describe('PermissionCatalog', () => {
  it('merges the seed roles several declarations give one key', () => {
    const invoices = definePermissions({
      subjects: {
        Invoice: {
          label: 'Invoices',
          conditions: {},
          actions: { read: { label: 'See invoices', conditions: [] } },
        },
      },
      seedRoles: [
        {
          key: 'viewer',
          name: 'Invoice viewer',
          description: 'Sees invoices.',
          permissions: [{ subject: 'Invoice', action: 'read', conditions: [] }],
        },
      ],
    });
    const merged = new PermissionCatalog({
      permissions: [PLATFORM_PERMISSIONS, NOTE_PERMISSIONS, invoices],
    });
    const viewers = merged.seedRoles.filter((role) => role.key === 'viewer');
    expect(viewers).toHaveLength(1);
    // The first declaration's name, every declaration's permissions.
    expect(viewers[0]!.name).toBe('Viewer');
    expect(
      viewers[0]!.permissions.map((p) => `${p.subject}.${p.action}`),
    ).toEqual(expect.arrayContaining(['Note.read', 'Invoice.read']));
  });

  it('merges what every declaration brings', () => {
    expect(Object.keys(catalog.subjects)).toEqual([
      'Access',
      'Approval',
      'Ops',
      'MailSuppression',
      'Note',
    ]);
    expect(catalog.seedRoles.map((role) => role.key)).toEqual([
      'editor',
      'team-lead',
      'viewer',
    ]);
    expect(catalog.clientPermissions).toHaveLength(5); // create, read, update, delete, restore
  });

  it('refuses a subject declared twice, and a declared permission it does not know', () => {
    expect(
      () =>
        new PermissionCatalog({
          permissions: [PLATFORM_PERMISSIONS, PLATFORM_PERMISSIONS],
        }),
    ).toThrow('declared twice');
    const broken = definePermissions({
      subjects: {},
      clientPermissions: [{ subject: 'Nope', action: 'read', conditions: [] }],
    });
    expect(() => new PermissionCatalog({ permissions: [broken] })).toThrow(
      'Unknown subject Nope',
    );
  });

  it('combines conditions: every one must hold', () => {
    const conditions = catalog.caslConditions(
      sam,
      {
        subject: 'Note',
        action: 'delete',
        conditions: [{ key: 'mine' }, { key: 'draft' }],
      },
      { teamIds: [] },
    );
    expect(canDelete(conditions, note({}))).toBe(true);
    expect(canDelete(conditions, note({ ownerId: 'user:kim' }))).toBe(false);
    expect(canDelete(conditions, note({ status: 'published' }))).toBe(false);
  });

  it('narrows two conditions on the same field', () => {
    expect(
      mergeConditions([
        { ownerId: { $in: ['a', 'b'] } },
        { ownerId: { $in: ['b'] } },
      ]),
    ).toEqual({ ownerId: { $in: ['b'] } });
    expect(
      mergeConditions([{ total: { $lte: 10 } }, { total: { $lte: 5 } }]),
    ).toEqual({ total: { $lte: 5 } });
    const contradiction = mergeConditions([
      { status: 'draft' },
      { status: 'published' },
    ]);
    expect(canDelete(contradiction, note({}))).toBe(false);
  });

  it('accepts only what the catalog declares', () => {
    expect(
      catalog.validate({ subject: 'Note', action: 'drop', conditions: [] }),
    ).toMatchObject({ ok: false });
    expect(
      catalog.validate({
        subject: 'Note',
        action: 'read',
        conditions: [{ key: 'draft' }],
      }),
    ).toMatchObject({ ok: false }); // draft isn't offered for read
    expect(
      catalog.validate({
        subject: 'Note',
        action: 'read',
        conditions: [],
        fields: ['title'],
      }),
    ).toMatchObject({ ok: false }); // only declared fields can be granted one by one
    expect(
      catalog.validate({
        subject: 'Note',
        action: 'read',
        conditions: [],
        fields: ['body', 'body'],
      }),
    ).toMatchObject({ ok: true, value: { fields: ['body'] } });
    expect(
      catalog.validate({
        subject: 'Note',
        action: 'delete',
        conditions: [{ key: 'mine', params: { extra: 1 } }],
      }),
    ).toEqual({
      ok: true,
      value: {
        subject: 'Note',
        action: 'delete',
        conditions: [{ key: 'mine' }],
        fields: null,
      },
    });
  });
});

describe('PermissionCatalog texts', () => {
  /** A stand-in for I18nService: these `permissions.<key>` texts, in German. */
  const german = (texts: Record<string, string>) =>
    ({
      exists: (key: string) => key in texts,
      translate: (key: string) => texts[key]!,
    }) as unknown as I18nService;

  it('shows the request language’s texts, and the declared ones where none', () => {
    const catalog = new PermissionCatalog(
      { permissions: [PLATFORM_PERMISSIONS, NOTE_PERMISSIONS] },
      german({
        'permissions.subjects.Note.label': 'Notizen',
        'permissions.subjects.Note.actions.read': 'Notizen sehen',
        'permissions.subjects.Note.fields.body': 'Der Text',
        'permissions.subjects.Note.conditions.draft.label': 'Noch ein Entwurf',
        // A shared condition, translated once for every subject.
        'permissions.conditions.mine.label': 'Von mir erstellt',
        'permissions.systemJobs.audit-retention.label': 'Audit-Aufbewahrung',
      }),
    );
    const note = catalog.view().find((s) => s.subject === 'Note')!;
    expect(note.label).toBe('Notizen');
    expect(note.fields).toEqual([
      { field: 'body', label: 'Der Text', sensitive: false },
    ]);
    const read = note.actions.find((a) => a.action === 'read')!;
    expect(read.label).toBe('Notizen sehen');
    expect(read.conditions[0]).toMatchObject({
      key: 'mine',
      label: 'Von mir erstellt',
      // Not translated: as declared.
      description: 'Only records this person (or API client) created.',
    });
    const update = note.actions.find((a) => a.action === 'update')!;
    expect(update.label).toBe('Change notes');
    expect(update.conditions[1]).toMatchObject({
      key: 'draft',
      label: 'Noch ein Entwurf',
    });
    expect(
      catalog.systemJobsView().find((job) => job.key === 'audit-retention'),
    ).toMatchObject({
      label: 'Audit-Aufbewahrung',
      description:
        'Deletes audit entries older than AUDIT_RETENTION_DAYS, every night.',
    });
  });

  it('is as declared without i18n', () => {
    const catalog = new PermissionCatalog({
      permissions: [PLATFORM_PERMISSIONS, NOTE_PERMISSIONS],
    });
    expect(catalog.view().find((s) => s.subject === 'Note')!.label).toBe(
      'Notes',
    );
  });
});
