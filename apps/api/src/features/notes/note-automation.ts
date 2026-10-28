import { Injectable } from '@nestjs/common';
import type { Principal } from '../../iam/auth/principal.js';
import {
  type AutomationRecord,
  type AutomationTarget,
  AutomationsRegistry,
} from '../../platform/automations/automations.registry.js';
import { NOTE_LIST } from './note.list.js';
import { createNoteSchema, type Note } from './note.schemas.js';
import { NotesService } from './notes.service.js';
import { notes } from './notes.tables.js';

/**
 * Tenant automation rules may act on notes (platform/automations):
 * NotesService reports each create and update; a rule may set a note's
 * title or text (as PATCH /notes/{id} does), tag it, tell people, or send
 * it to an API client. Its status and publication stay the workflow's.
 */
@Injectable()
export class NoteAutomation implements AutomationTarget {
  readonly subject = 'Note';
  readonly path = 'notes';
  readonly table = notes;
  readonly columns = { id: notes.id, updatedAt: notes.updatedAt };
  readonly list = NOTE_LIST;
  readonly fields = ['title', 'body', 'status'];
  readonly settable = {
    title: createNoteSchema.shape.title,
    body: createNoteSchema.shape.body,
  };
  readonly tags = true;

  constructor(
    private readonly notes: NotesService,
    registry: AutomationsRegistry,
  ) {
    registry.register(this);
  }

  title(row: AutomationRecord) {
    return typeof row.title === 'string' ? row.title : '';
  }

  view(row: AutomationRecord) {
    const { tenantId: _tenantId, search: _search, ...shown } = row;
    return shown;
  }

  async update(
    principal: Principal,
    row: AutomationRecord,
    dto: Record<string, unknown>,
  ) {
    await this.notes.update(principal, row as unknown as Note, dto);
  }
}
