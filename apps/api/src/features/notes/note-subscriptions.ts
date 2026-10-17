import { Injectable } from '@nestjs/common';
import { AuthorizationService } from '@nestjs/authorization';
import type { Principal } from '../../iam/auth/principal.js';
import {
  type SubscriptionTarget,
  SubscriptionsRegistry,
} from '../../platform/subscriptions/subscriptions.registry.js';
import { NotePolicy } from './note.policy.js';
import { NotesService } from './notes.service.js';

/** Watching notes (POST /v1/notes/{id}/watch): whoever may read the note. */
@Injectable()
export class NoteSubscriptions implements SubscriptionTarget {
  readonly subject = 'Note';

  constructor(
    private readonly notes: NotesService,
    private readonly authorization: AuthorizationService,
    registry: SubscriptionsRegistry,
  ) {
    registry.register(this);
  }

  async assertCanWatch(principal: Principal, recordId: string) {
    const note = await this.notes.findOne(recordId);
    await this.authorization.authorize(NotePolicy, 'read', principal, note);
  }
}
