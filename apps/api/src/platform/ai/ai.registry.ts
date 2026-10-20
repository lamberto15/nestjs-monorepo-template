import { Injectable } from '@nestjs/common';
import type { RequestPrincipal } from '../../iam/auth/principal.js';

/** What the model is shown of a record: a title and its fields as text. */
export interface AiContent {
  title: string;
  /** Field name to value: only what the requester may read (leave the rest out). */
  fields: Record<string, string | number | boolean | null>;
}

/**
 * A kind of record the AI helper may read for a feature: it gives the
 * record's fields as the requester may see them (field-level access applied,
 * as for DocumentSource), nothing more reaches the provider. Register from
 * the constructor: `registry.register(this)`.
 */
export interface AiSource {
  /** Its name, as the request asks for it: `note`. */
  readonly name: string;
  /** The record's permission subject: `Note`. */
  readonly subject: string;
  /**
   * In the request, after the cheap checks: may this principal use the
   * helper on this record? Throw Nest's NotFoundException when they may not
   * read it at all. False is a 403.
   */
  canUse(principal: RequestPrincipal, recordId: string): Promise<boolean>;
  /**
   * On the worker, as the requester (checked again): the record's fields as
   * they may read them. Throws NotFoundException when the record is gone or
   * no longer theirs: the run then fails without retries.
   */
  content(principal: RequestPrincipal, recordId: string): Promise<AiContent>;
}

@Injectable()
export class AiRegistry {
  private readonly sources = new Map<string, AiSource>();

  register(source: AiSource) {
    if (this.sources.has(source.name)) {
      throw new Error(`Two AI sources are named "${source.name}".`);
    }
    this.sources.set(source.name, source);
  }

  get(name: string) {
    return this.sources.get(name);
  }

  names() {
    return [...this.sources.keys()];
  }
}
