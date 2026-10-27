import { Injectable } from '@nestjs/common';
import type { Principal } from '../../iam/auth/principal.js';
import {
  type TagTarget,
  TagsRegistry,
} from '../../platform/tags/tags.registry.js';
import { NotePolicy } from './note.policy.js';
import { NotesService } from './notes.service.js';

/**
 * Notes carry tags (platform/tags): whoever may change a note
 * (`Note.update`) sets its tags.
 */
@Injectable()
export class NoteTags implements TagTarget {
  readonly subject = 'Note';

  constructor(
    private readonly notes: NotesService,
    private readonly policy: NotePolicy,
    registry: TagsRegistry,
  ) {
    registry.register(this);
  }

  /**
   * A 404 when the note doesn't exist (or is in the recycle bin) or the
   * principal may not read it (the same 404); false (a 403) when they read
   * but may not change it.
   */
  async canTag(principal: Principal, id: string) {
    return this.policy.update(
      principal,
      await this.notes.findOne(id, undefined, { visibleTo: principal }),
    );
  }
}
