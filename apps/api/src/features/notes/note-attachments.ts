import { Injectable, NotFoundException } from '@nestjs/common';
import { inArray } from 'drizzle-orm';
import { AccessService } from '../../iam/access/access.service.js';
import type { Principal } from '../../iam/auth/principal.js';
import {
  type AttachmentTarget,
  AttachmentsRegistry,
} from '../../platform/attachments/attachments.registry.js';
import { NotePolicy } from './note.policy.js';
import type { Note } from './note.schemas.js';
import { NotesService } from './notes.service.js';
import { notes } from './notes.tables.js';

/**
 * Notes take attachments: whoever may read a note sees and downloads
 * them, whoever may change it (Note.update) adds them and removes anyone's.
 * A note in the recycle bin keeps them (hidden with it); purged, the
 * nightly sweep deletes them.
 */
@Injectable()
export class NoteAttachments implements AttachmentTarget {
  readonly subject = 'Note';

  constructor(
    private readonly notes: NotesService,
    private readonly policy: NotePolicy,
    private readonly access: AccessService,
    registry: AttachmentsRegistry,
  ) {
    registry.register(this);
  }

  async canRead(principal: Principal, id: string) {
    const note = await this.find(id, principal);
    return note !== null && this.policy.read(principal, note);
  }

  async canWrite(principal: Principal, id: string) {
    const note = await this.find(id);
    return note !== null && this.policy.update(principal, note);
  }

  /** Every one of these fields, as reading the note would show them (an issued PDF's). */
  async canReadFields(
    principal: Principal,
    id: string,
    fields: readonly string[],
  ) {
    const note = await this.find(id);
    if (!note || !(await this.policy.read(principal, note))) return false;
    const shown = await this.access.redact(principal, 'read', 'Note', note);
    return fields.every((field) => field in shown);
  }

  async exists(ids: readonly string[]) {
    // Deleted ones too: they may be restored.
    const rows = await this.notes.query((db) =>
      db
        .select({ id: notes.id })
        .from(notes)
        .where(inArray(notes.id, [...ids])),
    );
    return rows.map((row) => row.id);
  }

  /** The note, or null when it doesn't exist (with `visibleTo`: or that principal may not read it). */
  private async find(id: string, visibleTo?: Principal): Promise<Note | null> {
    try {
      return await this.notes.findOne(id, undefined, { visibleTo });
    } catch (error) {
      if (error instanceof NotFoundException) return null;
      throw error;
    }
  }
}
