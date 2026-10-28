import { Injectable, type Type } from '@nestjs/common';
import type { List } from '../../core/http/list-query.js';
import type { Principal } from '../../iam/auth/principal.js';
import type { Capability } from '../records/record.js';
import { checkListViews } from './list-metadata.js';
import type { ListViewsDeclaration } from './list-metadata.schemas.js';

/**
 * A subject's list, as GET /v1/lists/{subject} describes it: the same
 * declaration its list route validates with (`<item>.list.ts`).
 */
export interface ListSource {
  readonly subject: string;
  /** Which record fields each list field reveals: its `reads` (`fieldsRead()`). */
  readonly list: List;
  /**
   * The capabilities its records take (record.ts, CAPABILITIES): a
   * generated record's declaration's, a hand-written feature's own list.
   * GET /v1/lists/{subject} answers them as `capabilities`.
   */
  readonly capabilities: readonly Capability[];
  /** The board, calendar and timeline it offers besides the table (`views`). */
  readonly views?: ListViewsDeclaration;
  /**
   * Who may read the description, when not whoever may `read` the subject
   * (ListPolicy): a list that isn't of records, as the access API's users
   * (`AccessPolicy.open`), whose subject no permission names.
   */
  readonly readable?: (principal: Principal | null) => Promise<boolean>;
}

/**
 * The subjects' list declarations: generated records register theirs
 * through `recordParts()` (platform/records), a hand-written feature with
 * `listSource()` among its providers. The codebase's registry pattern
 * (SearchRegistry): features register from a constructor.
 */
@Injectable()
export class ListsRegistry {
  private readonly sources = new Map<string, ListSource>();

  register(source: ListSource) {
    if (this.sources.has(source.subject)) {
      throw new Error(`Two lists are registered for "${source.subject}".`);
    }
    this.sources.set(source.subject, source);
  }

  get(subject: string) {
    return this.sources.get(subject);
  }

  subjects() {
    return [...this.sources.keys()];
  }
}

/**
 * A provider that registers a subject's list (GET /v1/lists/{subject}),
 * and the capabilities its records take, for a feature module's providers:
 * `listSource('Note', NOTE_LIST, NOTE_CAPABILITIES, NOTE_VIEWS)` (`views`
 * optional: a board, calendar or timeline, checked against the list).
 */
export function listSource(
  subject: string,
  list: List,
  capabilities: readonly Capability[],
  views?: ListViewsDeclaration,
): Type {
  if (views) checkListViews(subject, list, views);
  @Injectable()
  class RegisteredList {
    constructor(registry: ListsRegistry) {
      registry.register({ subject, list, capabilities, views });
    }
  }
  Object.defineProperty(RegisteredList, 'name', {
    value: `${subject}ListSource`,
  });
  return RegisteredList;
}
