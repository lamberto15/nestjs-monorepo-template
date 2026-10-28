import { Injectable, NotFoundException } from '@nestjs/common';
import {
  type AccessRecordFinder,
  AccessRecordsRegistry,
} from '../../iam/access/access-records.registry.js';
import type { Principal } from '../../iam/auth/principal.js';
import { NotesService } from './notes.service.js';

/** Notes, for the permission explanation (GET /v1/access/users/{id}/explanation): looked up as the asker. */
@Injectable()
export class NoteAccess implements AccessRecordFinder {
  readonly subject = 'Note';

  constructor(
    private readonly notes: NotesService,
    registry: AccessRecordsRegistry,
  ) {
    registry.register(this);
  }

  async find(id: string, visibleTo: Principal) {
    try {
      return await this.notes.findOne(id, undefined, { visibleTo });
    } catch (error) {
      if (error instanceof NotFoundException) return null;
      throw error;
    }
  }
}
