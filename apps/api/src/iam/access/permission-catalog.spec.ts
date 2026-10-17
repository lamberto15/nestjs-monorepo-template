import { createMongoAbility, subject } from '@casl/ability';
import { NOTE_PERMISSIONS } from '../../features/notes/note.policy.js';
import { PLATFORM_PERMISSIONS } from '../../platform/ops/ops.policy.js';
import type { UserPrincipal } from '../auth/principal.js';
import { mergeConditions, PermissionCatalog } from './permission-catalog.js';
import { definePermissions } from './permissions.js';

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
