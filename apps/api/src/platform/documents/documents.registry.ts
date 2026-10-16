import { Injectable } from '@nestjs/common';
import type { RequestPrincipal } from '../../iam/auth/principal.js';

/** What a document is made of: a template, its values, and how the file is named. */
export interface DocumentContent {
  /** A template in `src/documents/templates` (`note`: `note.html`, or `note.<locale>.html`). */
  template: string;
  /**
   * The values the template reads, as the requester may see them. The
   * engine escapes every one of them (`{{ value }}`); never pre-built HTML.
   */
  context: Record<string, unknown>;
  /** The PDF's title (its metadata, the `<title>`). */
  title: string;
  /** The attachment's file name, without `.pdf`. */
  fileName: string;
  /**
   * The record's fields the document shows (`title`, `body`…). Whoever
   * reads the document or downloads it must be allowed every one of them
   * (AttachmentTarget.canReadFields): leave out of `context` a field the
   * requester may not read, and out of this list.
   */
  fields: string[];
}

/** How a document is rendered: the requester's language and time zone, the moment it is issued. */
export interface DocumentRenderOptions {
  locale: string;
  timezone: string;
  issuedAt: Date;
}

/**
 * A kind of document a feature issues for its records: a PDF of a note,
 * an invoice. The record's subject must take attachments (an
 * AttachmentTarget): the PDF becomes one of them, which whoever may read
 * the record downloads. Register from the constructor:
 * `documents.register(this)`.
 */
export interface DocumentSource {
  /** Its name, as the feature's route asks for it: `note`. */
  readonly name: string;
  /** The record's permission subject: `Note`. */
  readonly subject: string;
  /**
   * In the request, after the caller's right to read the record was checked:
   * may they issue this document? False is a 403.
   */
  canIssue(principal: RequestPrincipal, recordId: string): Promise<boolean>;
  /**
   * On the worker, as the requester (checked again: they may have lost the
   * record meanwhile): the template and its values. Throws Nest's
   * NotFoundException when the record is gone or no longer theirs to read:
   * the document then fails without retries.
   */
  content(
    principal: RequestPrincipal,
    recordId: string,
    options: DocumentRenderOptions,
  ): Promise<DocumentContent>;
}

@Injectable()
export class DocumentsRegistry {
  private readonly sources = new Map<string, DocumentSource>();

  register(source: DocumentSource) {
    if (this.sources.has(source.name)) {
      throw new Error(`Two document sources are named "${source.name}".`);
    }
    this.sources.set(source.name, source);
  }

  get(name: string) {
    return this.sources.get(name);
  }
}
