import { Injectable } from '@nestjs/common';
import type { Principal } from '../../iam/auth/principal.js';

/** One thing waiting on a person, as its source reports it. */
export interface InboxEntry {
  /** The source's own id for it (a request's, a notification's): a UUIDv7, which orders the whole list. */
  id: string;
  /** When it came to the person, shown with the item. */
  at: Date;
  /** What kind of work it is, for the client to word: `approval.decide`. */
  kind: string;
  /** What the client words it with (titles, names), nothing the person may not read. */
  data: Record<string, unknown>;
  /** Where to do it, a path of the web app. */
  link: string | null;
  dueAt: Date | null;
  subject?: string;
  recordId?: string;
  /** Two entries with the same value are one piece of work: the newest is kept. */
  dedupe?: string;
}

/**
 * Something that gives people work to do (approvals waiting on them,
 * mentions…), shown in their inbox (`GET /v1/inbox`). A source reads the
 * authoritative state (it keeps no copy), returns only what this principal
 * may see and still has to do, and says how an item is dismissed, if it can
 * be. Register from the constructor: `inbox.register(this)`.
 */
export interface InboxSource {
  /** `approval`: part of every item's key. */
  readonly name: string;
  /** Up to `limit` entries, newest first (by `id`, descending), after the id `after`. */
  items(
    principal: Principal,
    page: { limit: number; after?: string },
  ): Promise<InboxEntry[]>;
  /** Dismisses one of the principal's entries (mark it read); absent: it is done at its source only. */
  dismiss?(principal: Principal, id: string): Promise<void>;
}

@Injectable()
export class InboxRegistry {
  private readonly sources = new Map<string, InboxSource>();

  register(source: InboxSource) {
    if (this.sources.has(source.name) || source.name.includes(':')) {
      throw new Error(`Two inbox sources are named "${source.name}".`);
    }
    this.sources.set(source.name, source);
  }

  all() {
    return [...this.sources.values()];
  }

  find(name: string) {
    return this.sources.get(name);
  }
}
