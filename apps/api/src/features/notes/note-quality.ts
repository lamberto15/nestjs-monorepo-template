import { Injectable } from '@nestjs/common';
import { DataQualityRegistry } from '../../platform/data-quality/data-quality.registry.js';
import { notes } from './notes.tables.js';

/**
 * Notes' data-quality checks (docs/data-quality.md): a note without text is
 * a suggestion, and so is one whose title another note has too. Notes
 * refer to no other record. A declared record says this in its
 * `quality`; notes are hand-written, so they register it here.
 */
@Injectable()
export class NoteQuality {
  constructor(registry: DataQualityRegistry) {
    registry.register({
      subject: 'Note',
      table: notes,
      id: notes.id,
      deletedAt: notes.deletedAt,
      recommended: { body: notes.body },
      duplicates: { title: notes.title },
      references: {},
    });
  }
}
