import { Injectable } from '@nestjs/common';
import type { Principal } from '../../iam/auth/principal.js';

/** A hit of the global search: a record, as a result list shows it. */
export interface SearchHit {
  subject: string;
  id: string;
  title: string;
  /** Around the matches, the matches in <b>…</b>; null when the caller may not read the text. */
  snippet: string | null;
  /** How well it matches: 0 to 1. */
  score: number;
  /** Where to go: a path of the web app. */
  link: string | null;
}

/**
 * What a feature searches for `GET /search?q=`: its records the principal
 * may read that match, best first, at most `limit`. Register from the
 * constructor: `search.register(this)`.
 */
export interface SearchSource {
  readonly subject: string;
  search(principal: Principal, q: string, limit: number): Promise<SearchHit[]>;
}

@Injectable()
export class SearchRegistry {
  private readonly sources = new Map<string, SearchSource>();

  register(source: SearchSource) {
    if (this.sources.has(source.subject)) {
      throw new Error(`Two search sources are for "${source.subject}".`);
    }
    this.sources.set(source.subject, source);
  }

  get(subject: string) {
    return this.sources.get(subject);
  }

  all() {
    return [...this.sources.values()];
  }
}
