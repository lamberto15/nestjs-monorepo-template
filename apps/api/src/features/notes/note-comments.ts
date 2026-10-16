import { Injectable } from '@nestjs/common';
import type { Principal } from '../../iam/auth/principal.js';
import {
  type CommentTarget,
  CommentsRegistry,
} from '../../platform/comments/comments.registry.js';
import { NotePolicy } from './note.policy.js';
import { NotesService } from './notes.service.js';

/**
 * Notes take comments (platform/comments): whoever may read a note reads
 * and writes its comments and may be mentioned in them; whoever may change
 * it (`Note.update`) moderates them. Watchers hear `note.commented`.
 */
@Injectable()
export class NoteComments implements CommentTarget {
  readonly subject = 'Note';
  readonly commentedType = 'note.commented';

  constructor(
    private readonly notes: NotesService,
    private readonly policy: NotePolicy,
    registry: CommentsRegistry,
  ) {
    registry.register(this);
  }

  /** A 404 when the note doesn't exist (or is in the recycle bin). */
  async canRead(principal: Principal, id: string) {
    return this.policy.read(principal, await this.notes.findOne(id));
  }

  async canModerate(principal: Principal, id: string) {
    return this.policy.update(principal, await this.notes.findOne(id));
  }

  link(id: string) {
    return `/notes/${id}`;
  }

  async title(id: string) {
    return (await this.notes.findOne(id)).title;
  }
}
