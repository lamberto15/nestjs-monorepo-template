import { Injectable, NotFoundException } from '@nestjs/common';
import { AccessService } from '../../iam/access/access.service.js';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import {
  type AiContent,
  AiRegistry,
  type AiSource,
} from '../../platform/ai/ai.registry.js';
import { NotePolicy } from './note.policy.js';
import { NotesService } from './notes.service.js';

/**
 * A note for the AI helper (platform/ai): its title, status and, only when
 * the requester may read it (Note.body), its text. Whoever may read the
 * note may ask.
 */
@Injectable()
export class NoteAi implements AiSource {
  readonly name = 'note';
  readonly subject = 'Note';

  constructor(
    private readonly notes: NotesService,
    private readonly policy: NotePolicy,
    private readonly access: AccessService,
    registry: AiRegistry,
  ) {
    registry.register(this);
  }

  async canUse(principal: RequestPrincipal, id: string) {
    await this.read(principal, id); // 404 when it is not theirs to read
    return true;
  }

  async content(principal: RequestPrincipal, id: string): Promise<AiContent> {
    const note = await this.read(principal, id);
    // Field-level: what this principal may read of it, nothing more leaves.
    const shown = (await this.access.redact(
      principal,
      'read',
      'Note',
      note,
    )) as Partial<typeof note>;
    return {
      title: note.title,
      fields: {
        status: shown.status ?? null,
        ...('body' in shown ? { body: shown.body ?? null } : {}),
      },
    };
  }

  private async read(principal: RequestPrincipal, id: string) {
    const note = await this.notes.findOne(id); // 404 when gone or in the recycle bin
    if (!(await this.policy.read(principal, note))) {
      throw new NotFoundException(`Note ${id} not found.`);
    }
    return note;
  }
}
