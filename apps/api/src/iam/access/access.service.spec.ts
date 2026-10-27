import { createMongoAbility } from '@casl/ability';
import { ForbiddenException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { vi } from 'vitest';
import { listQuery } from '../../core/http/list-query.js';
import { searchFields, tsvector } from '../../core/database/search.js';
import type { UserPrincipal } from '../auth/principal.js';
import { AccessService, hiddenOnSomeRecords } from './access.service.js';
import { PermissionCatalog } from './permission-catalog.js';
import {
  ALL,
  createdBy,
  definePermissions,
  inMyUnitsAndBelow,
  type PermissionInput,
} from './permissions.js';

const notes = pgTable('notes', {
  id: uuid('id').primaryKey(),
  ownerId: text('owner_id').notNull(),
  unitId: uuid('unit_id'),
  title: text('title').notNull(),
  body: text('body'),
  status: text('status').notNull(),
  search: tsvector('search'),
});

const catalog = new PermissionCatalog({
  permissions: [
    definePermissions({
      subjects: {
        Note: {
          label: 'Notes',
          fields: {
            body: { label: "The note's text" },
            custom: { label: 'Custom fields' },
          },
          conditions: {
            mine: createdBy('ownerId', notes.ownerId),
            inMyUnitsAndBelow: inMyUnitsAndBelow('unitId', notes.unitId),
            draft: {
              label: 'Still a draft',
              description: 'Only notes not yet published.',
              casl: () => ({ status: 'draft' }),
              sql: () => eq(notes.status, 'draft'),
            },
          },
          actions: {
            read: {
              label: 'See notes',
              conditions: ['mine', 'inMyUnitsAndBelow'],
            },
            restore: {
              label: 'Restore notes',
              conditions: ['mine', 'inMyUnitsAndBelow'],
            },
          },
        },
      },
    }),
  ],
});

const LIST = listQuery(
  {
    ...searchFields(notes.search, ['title', 'body']),
    title: {
      column: notes.title,
      type: 'string',
      ops: ['contains'],
      sortable: true,
    },
    body: {
      column: notes.body,
      type: 'string',
      ops: ['contains'],
      sortable: true,
    },
  },
  { select: ['id', 'title', 'body'] },
);

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

const read = (conditions: string[], fields?: string[]): PermissionInput => ({
  subject: 'Note',
  action: 'read',
  conditions: conditions.map((key) => ({ key })),
  ...(fields && { fields }),
});

const restore = (conditions: string[]): PermissionInput => ({
  subject: 'Note',
  action: 'restore',
  conditions: conditions.map((key) => ({ key })),
});

/** An AccessService whose principal holds `permissions` (no database, no Redis). */
function accessWith(...permissions: PermissionInput[]) {
  const access = new AccessService(
    {} as never,
    catalog,
    {} as never,
    { permissions: [] } as never,
  );
  vi.spyOn(access as never, 'loadPermissions').mockResolvedValue({
    permissions,
  } as never);
  vi.spyOn(access as never, 'loadContext').mockResolvedValue({
    context: {
      directUnitIds: ['unit-1'],
      unitIdsAndBelow: ['unit-1'],
      ledUnitIdsAndBelow: [],
    },
  } as never);
  return access;
}

describe('AccessService: fields shown on some records only', () => {
  it('finds a field one read grants with conditions beside another read without it', async () => {
    // The issue's role: own notes with every field, the unit's with none.
    const access = accessWith(read(['mine']), read(['inMyUnitsAndBelow'], []));
    expect(await access.conditionalFields(sam, 'read', 'Note')).toEqual([
      'body',
      'custom',
    ]);
    expect(await access.deniedFields(sam, 'read', 'Note')).toEqual([]);
    // The same with a read of every note, without the fields.
    const everyNote = accessWith(read(['mine']), read([], []));
    expect(await everyNote.conditionalFields(sam, 'read', 'Note')).toEqual([
      'body',
      'custom',
    ]);
    // Only the field the conditional read adds.
    const bodyOwn = accessWith(read(['mine']), read([], ['custom']));
    expect(await bodyOwn.conditionalFields(sam, 'read', 'Note')).toEqual([
      'body',
    ]);
  });

  it('finds none when every read reaching records grants the field', async () => {
    // Own notes, every field: shown on every note the read reaches.
    expect(
      await accessWith(read(['mine'])).conditionalFields(sam, 'read', 'Note'),
    ).toEqual([]);
    // A grant without conditions: every record.
    expect(
      await accessWith(read([]), read(['mine'], [])).conditionalFields(
        sam,
        'read',
        'Note',
      ),
    ).toEqual([]);
    // The field granted by the same conditions as the read without it.
    expect(
      await accessWith(
        read(['mine'], []),
        read(['mine'], ['body']),
      ).conditionalFields(sam, 'read', 'Note'),
    ).toEqual([]);
    // Administrators.
    expect(
      await accessWith(ALL).conditionalFields(sam, 'read', 'Note'),
    ).toEqual([]);
    // A field shown nowhere is denied, not conditional.
    const blind = accessWith(read([], []));
    expect(await blind.conditionalFields(sam, 'read', 'Note')).toEqual([]);
    expect(await blind.deniedFields(sam, 'read', 'Note')).toEqual([
      'body',
      'custom',
    ]);
  });

  it('counts a forbidding rule with conditions, unless a grant without conditions wins', () => {
    const forbidden = createMongoAbility([
      { action: 'read', subject: 'Note' },
      {
        action: 'read',
        subject: 'Note',
        fields: ['body'],
        conditions: { status: 'draft' },
        inverted: true,
      },
    ]);
    expect(forbidden.can('read', 'Note', 'body')).toBe(true);
    expect(hiddenOnSomeRecords(forbidden, 'read', 'Note', 'body')).toBe(true);
    expect(hiddenOnSomeRecords(forbidden, 'read', 'Note', 'title')).toBe(false);
    // A later grant without conditions has the priority.
    const overridden = createMongoAbility([
      {
        action: 'read',
        subject: 'Note',
        fields: ['body'],
        conditions: { status: 'draft' },
        inverted: true,
      },
      { action: 'read', subject: 'Note' },
    ]);
    expect(hiddenOnSomeRecords(overridden, 'read', 'Note', 'body')).toBe(false);
  });

  it('refuses filters, search and sort on such a field, not selecting it', async () => {
    const access = accessWith(read(['mine']), read(['inMyUnitsAndBelow'], []));
    for (const raw of [
      { 'body.contains': 'x' },
      { sort: 'body' },
      { q: 'layoff' },
      { q: 'layoff', sort: '-rank' },
      {
        filter: JSON.stringify({
          or: [{ field: 'body', op: 'contains', value: 'x' }],
        }),
      },
    ]) {
      const refused = await access
        .assertQueryFields(sam, 'Note', LIST.parse(raw))
        .catch((error: unknown) => error);
      expect(refused, JSON.stringify(raw)).toBeInstanceOf(ForbiddenException);
      expect((refused as ForbiddenException).getResponse()).toMatchObject({
        code: 'field_forbidden',
        fields: ['body'],
      });
    }
    // Selected: redact() decides per record.
    await access.assertQueryFields(
      sam,
      'Note',
      LIST.parse({ fields: 'title,body' }),
    );
    await access.assertQueryFields(
      sam,
      'Note',
      LIST.parse({ 'title.contains': 'x', sort: 'title' }),
    );
    // Whoever reads the field everywhere they read: as before.
    await accessWith(read(['mine'])).assertQueryFields(
      sam,
      'Note',
      LIST.parse({ q: 'layoff', sort: 'body', 'body.contains': 'x' }),
    );
  });

  it('still refuses selecting a field shown on no record', async () => {
    const refused = await accessWith(read([], []))
      .assertQueryFields(sam, 'Note', LIST.parse({ fields: 'body' }))
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ForbiddenException);
  });

  it('reads the rows another action reaches against what read shows of them', async () => {
    // Restoring the unit's notes while reading only one's own: the recycle
    // bin reaches notes whose text read never shows.
    const wider = accessWith(read(['mine']), restore(['inMyUnitsAndBelow']));
    expect(await wider.conditionalFields(sam, 'read', 'Note')).toEqual([]);
    expect(
      await wider.conditionalFields(sam, 'read', 'Note', 'restore'),
    ).toEqual(['body', 'custom']);
    const bin = LIST.parse({ q: 'salary' });
    await wider.assertQueryFields(sam, 'Note', bin);
    await expect(
      wider.assertQueryFields(sam, 'Note', bin, { reach: 'restore' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await wider.assertQueryFields(
      sam,
      'Note',
      LIST.parse({ 'title.contains': 'x', fields: 'title,body' }),
      { reach: 'restore' },
    );
    // Restoring what one reads, with every field: nothing hidden there.
    const same = accessWith(read(['mine']), restore(['mine']));
    expect(
      await same.conditionalFields(sam, 'read', 'Note', 'restore'),
    ).toEqual([]);
    await same.assertQueryFields(sam, 'Note', bin, { reach: 'restore' });
    // A read of every note with every field covers any reach.
    expect(
      await accessWith(
        read([]),
        restore(['inMyUnitsAndBelow']),
      ).conditionalFields(sam, 'read', 'Note', 'restore'),
    ).toEqual([]);
  });
});
