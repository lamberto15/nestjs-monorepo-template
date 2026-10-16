import { Injectable } from '@nestjs/common';
import type { Transaction } from '../../core/database/drizzle.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';

/**
 * What a feature knows about a person, for their data export
 * (`POST /account/export`) and, when it must go with them, their account's
 * deletion. Register from the constructor: `personalData.register(this)`.
 *
 * ```ts
 * readonly name = 'note';
 * async *rows(user) { yield notes the user owns, 1000 at a time }
 * async erase?(tx, user) { … }   // only what must go: business records usually stay, without the name
 * ```
 */
export interface PersonalDataSource {
  /** The kind of record, as the export names it: `note`. */
  readonly name: string;
  /** The user's records, in batches; each with an `id` when it has one. */
  rows(user: UserPrincipal): AsyncIterable<Record<string, unknown>[]>;
  /** In the deletion's transaction: remove or anonymize what identifies the person. */
  erase?(tx: Transaction, user: UserPrincipal): Promise<void>;
}

@Injectable()
export class PersonalDataRegistry {
  private readonly sources = new Map<string, PersonalDataSource>();

  register(source: PersonalDataSource) {
    if (this.sources.has(source.name)) {
      throw new Error(`Two personal data sources are named "${source.name}".`);
    }
    this.sources.set(source.name, source);
  }

  all() {
    return [...this.sources.values()];
  }
}
