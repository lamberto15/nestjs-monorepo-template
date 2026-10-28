import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AccessService } from '../../iam/access/access.service.js';
import type { Principal } from '../../iam/auth/principal.js';
import {
  type ShareTarget,
  SharesRegistry,
} from '../../platform/shares/shares.registry.js';
import { NotePolicy } from './note.policy.js';
import type { Note } from './note.schemas.js';
import { NotesService } from './notes.service.js';

/**
 * Notes are shared by read-only links (POST /v1/notes/{id}/shares):
 * whoever may read a note and share it (Note.share, granted by no example
 * role) makes them; a link shows the note's own words and state, as its
 * maker may read them (the text only with that field-level permission),
 * and its files.
 */
@Injectable()
export class NoteShares implements ShareTarget {
  readonly subject = 'Note';
  readonly fields = ['number', 'title', 'body', 'status', 'publishedAt'];
  readonly files = true;

  constructor(
    private readonly notes: NotesService,
    private readonly policy: NotePolicy,
    private readonly access: AccessService,
    registry: SharesRegistry,
  ) {
    registry.register(this);
  }

  async assertCanShare(principal: Principal, id: string) {
    // A note they may not read: the same 404 as a missing one.
    const note = await this.notes.findOne(id, undefined, {
      visibleTo: principal,
    });
    if (!(await this.policy.share(principal, note))) {
      throw new ForbiddenException(`You may not share note ${id}.`);
    }
  }

  async shared(principal: Principal, id: string, fields: readonly string[]) {
    const note = await this.find(id);
    if (
      !note ||
      !(await this.policy.read(principal, note)) ||
      !(await this.policy.share(principal, note))
    ) {
      return null;
    }
    const shown = await this.access.redact(principal, 'read', 'Note', note);
    return Object.fromEntries(
      fields
        .filter((name) => name in shown)
        .map((name) => [name, (shown as Record<string, unknown>)[name]]),
    );
  }

  /** The note, or null when it doesn't exist (or is in the recycle bin). */
  private async find(id: string): Promise<Note | null> {
    try {
      return await this.notes.findOne(id);
    } catch (error) {
      if (error instanceof NotFoundException) return null;
      throw error;
    }
  }
}
