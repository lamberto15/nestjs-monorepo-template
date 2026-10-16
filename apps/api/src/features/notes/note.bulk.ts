import { ForbiddenException, Injectable } from '@nestjs/common';
import { and, desc, inArray, lt } from 'drizzle-orm';
import { AccessService } from '../../iam/access/access.service.js';
import type { Principal } from '../../iam/auth/principal.js';
import { BulkRegistry } from '../../platform/bulk/bulk.registry.js';
import type {
  BulkOperation,
  BulkSelection,
} from '../../platform/bulk/bulk.types.js';
import type { ListQuery } from '../../core/http/list-query.js';
import { NOTE_LIST } from './note.list.js';
import {
  type Note,
  updateNoteSchema,
  type UpdateNoteDto,
} from './note.schemas.js';
import { NotesService } from './notes.service.js';
import { notes } from './notes.tables.js';

/** Notes are acted on this many at a time. */
const BATCH = 500;

/**
 * The example of a bulk operation: POST /notes/bulk deletes, restores or
 * changes many notes, each as its own route would (NotesService, its
 * transaction, its audit entry, its webhook).
 *
 * - Selection: the notes the caller may `action` (the list's SQL filter
 *   for that permission; the recycle bin for restore), among the ids or
 *   matching the list's own filters, by id, newest first.
 * - Each note: the record check again (it may have changed since), the
 *   field-level check for update (`field_forbidden` fails that note).
 */
@Injectable()
export class NoteBulk implements BulkOperation<Note> {
  readonly name = 'notes';
  readonly subject = 'Note';
  readonly actions = {
    delete: { label: 'Delete (to the recycle bin)', permission: 'delete' },
    restore: { label: 'Restore from the recycle bin', permission: 'restore' },
    update: { label: 'Change', permission: 'update', input: updateNoteSchema },
  };
  readonly filters = NOTE_LIST.schema;

  constructor(
    private readonly notes: NotesService,
    private readonly access: AccessService,
    registry: BulkRegistry,
  ) {
    registry.register(this);
  }

  async *select(
    principal: Principal,
    action: string,
    selection: BulkSelection,
  ) {
    const where = and(
      await this.access.sqlFilter(principal, 'Note', action, {
        deleted: action === 'restore',
      }),
      selection.ids
        ? inArray(notes.id, selection.ids)
        : NOTE_LIST.where(selection.filter as ListQuery),
    );
    let cursor: string | undefined;
    for (;;) {
      const rows = await this.notes.query((db) =>
        db
          .select()
          .from(notes)
          .where(and(where, cursor ? lt(notes.id, cursor) : undefined))
          .orderBy(desc(notes.id))
          .limit(BATCH),
      );
      if (rows.length === 0) {
        return;
      }
      yield rows;
      cursor = rows[rows.length - 1]!.id;
    }
  }

  async perform(
    principal: Principal,
    action: string,
    selected: Note,
    input: unknown,
    ip?: string,
  ) {
    // As it is now, not as it was selected: published, or deleted by someone
    // else, since then (a 404 or 403 fails this item alone).
    const note = await this.notes.findOne(selected.id, undefined, {
      deleted: action === 'restore',
    });
    if (!(await this.access.can(principal, action, 'Note', note))) {
      throw new ForbiddenException();
    }
    if (action === 'delete') {
      await this.notes.delete(principal, note, ip);
    } else if (action === 'restore') {
      await this.notes.restore(principal, note, ip);
    } else {
      const dto = input as UpdateNoteDto;
      const forbidden = await this.access.forbiddenFields(
        principal,
        'update',
        'Note',
        dto,
        note,
      );
      if (forbidden.length) {
        throw new ForbiddenException({
          code: 'field_forbidden',
          message: `You may not change: ${forbidden.join(', ')}.`,
          fields: forbidden,
        });
      }
      await this.notes.update(principal, note, dto, ip);
    }
  }
}
