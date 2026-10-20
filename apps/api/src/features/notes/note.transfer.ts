import { Injectable } from '@nestjs/common';
import { and, desc, eq, lt } from 'drizzle-orm';
import { z } from 'zod';
import { AccessService } from '../../iam/access/access.service.js';
import {
  type Principal,
  principalKey,
  type UserPrincipal,
} from '../../iam/auth/principal.js';
import { CustomFieldsService } from '../../platform/custom-fields/custom-fields.service.js';
import {
  type PersonalDataSource,
  PersonalDataRegistry,
} from '../../platform/account/personal-data.registry.js';
import { DataTransferRegistry } from '../../platform/data-transfer/data-transfer.registry.js';
import { columnsOf } from '../../platform/data-transfer/import-columns.js';
import type {
  DataExporter,
  DataImporter,
  TransferColumn,
} from '../../platform/data-transfer/data-transfer.types.js';
import { createNoteSchema, type Note } from './note.schemas.js';
import { NOTE_LIST } from './note.list.js';
import { NotesService } from './notes.service.js';
import { notes } from './notes.tables.js';

/**
 * A row: POST /notes's own schema (the same limits and messages), custom
 * values in their `custom.<key>` columns; the text may be left out (a
 * caller without its permission gets a template without it).
 */
const noteRow = createNoteSchema
  .omit({ custom: true, namingSeriesId: true })
  .extend({ body: createNoteSchema.shape.body.default('') });
type NoteRow = z.infer<typeof noteRow> & {
  custom?: Record<string, unknown>;
};

/**
 * The example of data transfer: notes as CSV, JSON or Excel.
 *
 * - Export: the notes the principal may read (the same SQL filter as the
 *   list, and the list's own filters), in batches of 1000 by id, newest
 *   first; the platform removes the fields they may not read (the text).
 * - Import: one note per row (title, body); each goes through
 *   NotesService.create, so it gets its workflow, webhook and audit entry
 *   like one written through the API.
 * - Custom fields: one column per active field, `custom.<key>`, after the
 *   note's own, both ways; imported values are checked as on POST /notes. A
 *   file with a column of a field that no longer exists fails up front.
 * - Personal data: the notes a user owns are part of their data export.
 */
@Injectable()
export class NoteTransfer
  implements DataExporter<Note>, DataImporter<NoteRow>, PersonalDataSource
{
  readonly name = 'notes';
  readonly subject = 'Note';
  readonly columns: readonly TransferColumn[] = [
    { key: 'id' },
    { key: 'number' },
    { key: 'title' },
    { key: 'body' },
    { key: 'status' },
    // Its tags' names, `Urgent, Q3` (batches() adds them, one query per batch).
    {
      key: 'tags',
      value: (row) =>
        ((row.tags as { name: string }[] | undefined) ?? [])
          .map((tag) => tag.name)
          .join(', '),
    },
    { key: 'ownerId', header: 'owner' },
    { key: 'createdAt', type: 'datetime' },
    { key: 'publishedAt', type: 'datetime' },
  ];
  readonly filters = NOTE_LIST.schema;
  readonly schema: z.ZodType<NoteRow> = noteRow;

  constructor(
    private readonly notes: NotesService,
    private readonly access: AccessService,
    private readonly customFields: CustomFieldsService,
    registry: DataTransferRegistry,
    personalData: PersonalDataRegistry,
  ) {
    registry.registerExporter(this);
    registry.registerImporter(this);
    personalData.register(this);
  }

  /**
   * A person's data export (POST /account/export): the notes they own.
   * They stay when the account is deleted (the owner becomes nobody), so
   * there is nothing to erase.
   */
  async *rows(user: UserPrincipal) {
    let cursor: string | undefined;
    for (;;) {
      const rows = await this.notes.query((db) =>
        db
          .select()
          .from(notes)
          .where(
            and(
              eq(notes.ownerId, principalKey(user)),
              cursor ? lt(notes.id, cursor) : undefined,
            ),
          )
          .orderBy(desc(notes.id))
          .limit(1000),
      );
      if (rows.length === 0) return;
      yield rows as Record<string, unknown>[];
      cursor = rows[rows.length - 1]!.id;
    }
  }

  /** The columns above, then one per active custom field. */
  async columnsFor() {
    return [
      ...this.columns,
      ...(await this.customFields.transferColumns('Note')),
    ];
  }

  /** The template's columns: the row's, then one per active custom field. */
  async templateColumns() {
    return [
      ...columnsOf(noteRow),
      ...(await this.customFields.importColumns('Note')),
    ];
  }

  /** The row above, plus the `custom.<key>` columns, typed and checked. */
  schemaFor() {
    return this.customFields.importSchema('Note', noteRow);
  }

  /** The `custom.<key>` columns of fields that don't exist (or no longer). */
  refusedColumns(_principal: Principal, headers: readonly string[]) {
    return this.customFields.unknownColumns('Note', headers);
  }

  async *batches(principal: Principal, filters: Record<string, unknown>) {
    const where = and(
      await this.access.sqlFilter(principal, 'Note', 'read'),
      NOTE_LIST.where({ limit: 1000, ...filters }),
    );
    let cursor: string | undefined;
    for (;;) {
      const rows = await this.notes.query((db) =>
        db
          .select()
          .from(notes)
          .where(and(where, cursor ? lt(notes.id, cursor) : undefined))
          .orderBy(desc(notes.id))
          .limit(1000),
      );
      if (rows.length === 0) {
        return;
      }
      yield await this.notes.withTags(rows);
      cursor = rows[rows.length - 1].id;
    }
  }

  /** One row, as POST /notes writes it (the platform checked its fields). */
  async write(principal: Principal, row: NoteRow) {
    await this.notes.create(principal, row);
  }
}
