import { Injectable, NotFoundException } from '@nestjs/common';
import { I18nService } from '@nestjs/i18n';
import { AccessService } from '../../iam/access/access.service.js';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import {
  type DocumentRenderOptions,
  type DocumentSource,
  DocumentsRegistry,
} from '../../platform/documents/documents.registry.js';
import { NotePolicy } from './note.policy.js';
import { NotesService } from './notes.service.js';

/**
 * A note as a PDF (platform/documents): its title, number, status, dates
 * and text, in the requester's language (right to left in Arabic) and time
 * zone. Whoever may read the note asks for one (POST /v1/notes/{id}/pdf);
 * it becomes one of the note's attachments. The text is in it only when
 * the requester may read it (Note.body); the fields it shows are listed
 * (`fields`), and only readers allowed every one of them download it or see
 * its document (NoteAttachments.canReadFields): a reader without Note.body
 * gets a 404 for a PDF that has the text.
 */
@Injectable()
export class NoteDocuments implements DocumentSource {
  readonly name = 'note';
  readonly subject = 'Note';

  constructor(
    private readonly notes: NotesService,
    private readonly policy: NotePolicy,
    private readonly access: AccessService,
    private readonly i18n: I18nService,
    registry: DocumentsRegistry,
  ) {
    registry.register(this);
  }

  /** Whoever may read the note (DocumentsService checked that already). */
  canIssue() {
    return Promise.resolve(true);
  }

  async content(
    principal: RequestPrincipal,
    id: string,
    { locale, timezone, issuedAt }: DocumentRenderOptions,
  ) {
    const note = await this.notes.findOne(id); // 404 when gone or in the recycle bin
    if (!(await this.policy.read(principal, note))) {
      throw new NotFoundException(`Note ${id} not found.`);
    }
    // Field-level: what this principal may read of it, nothing more.
    const shown = await this.access.redact(principal, 'read', 'Note', note);
    const date = (value: Date) =>
      this.i18n.formatDate(value, {
        locale,
        dateStyle: 'long',
        timeStyle: 'short',
        timeZone: timezone,
      });
    const label = (key: string, args?: Record<string, string>) =>
      this.i18n.translate(`documents.note.${key}`, { locale, args });
    const body = 'body' in shown ? (shown.body ?? null) : null;
    return {
      template: 'note',
      fields: [
        'title',
        'number',
        'status',
        'createdAt',
        'publishedAt',
        ...(body ? ['body'] : []),
      ],
      title: note.title,
      fileName: note.number ?? `note-${note.id}`,
      context: {
        labels: {
          document: label('document'),
          number: label('number'),
          status: label('status'),
          created: label('created'),
          published: label('published'),
          issued: label('issued', { date: date(issuedAt) }),
        },
        note: {
          title: note.title,
          number: note.number,
          status: label(`statuses.${note.status}`),
          body,
          createdAt: date(note.createdAt),
          publishedAt: note.publishedAt ? date(note.publishedAt) : null,
        },
      },
    };
  }
}
