import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { DrizzleTransactions } from '../../core/database/transactions.js';
import { AccessService } from '../../iam/access/access.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { Principal } from '../../iam/auth/principal.js';
import { LegalHoldsService } from '../../iam/holds/legal-holds.service.js';
import { CustomFieldsService } from '../../platform/custom-fields/custom-fields.service.js';
import { type MergeSource, Merges } from '../../platform/merge/record-merge.js';
import type { RecordRow } from '../../platform/records/record-contract.js';
import { NotePolicy } from './note.policy.js';
import { createNoteSchema, type Note, noteView } from './note.schemas.js';
import { NotesService } from './notes.service.js';
import { notes } from './notes.tables.js';

/**
 * Notes' duplicates and their merge (docs/merging.md): two notes with the
 * same title are likely duplicates, and a merge may take the other's title
 * or text. A declared record gets this from its `merge` capability; notes
 * are hand-written, so they say it here, as their routes show them.
 */
@Injectable()
export class NoteMerge extends Merges {
  protected readonly s: MergeSource;

  constructor(
    notesService: NotesService,
    policy: NotePolicy,
    customFields: CustomFieldsService,
    txHost: TransactionHost<DrizzleTransactions>,
    access: AccessService,
    audit: AuditService,
    holds: LegalHoldsService,
  ) {
    super(txHost, access, audit, holds);
    // As the notes' routes answer them: tags, active custom values, then redacted.
    const present = async (principal: Principal, rows: RecordRow[]) =>
      access.redactAll(
        principal,
        'read',
        'Note',
        await customFields.visible(
          'Note',
          await notesService.withTags((rows as Note[]).map(noteView)),
        ),
      );
    this.s = {
      subject: 'Note',
      path: 'notes',
      noun: 'note',
      fields: {
        title: { kind: 'string', input: createNoteSchema.shape.title },
        body: { kind: 'text', input: createNoteSchema.shape.body },
      },
      rules: [['title']],
      table: notes as unknown as PgTable & Record<string, AnyPgColumn>,
      service: notesService as unknown as MergeSource['service'],
      policy: policy as unknown as MergeSource['policy'],
      view: (row) => noteView(row as Note),
      present,
      one: async (principal, row) => (await present(principal, [row]))[0],
    };
  }
}
