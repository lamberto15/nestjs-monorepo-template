import { Injectable, type Type } from '@nestjs/common';
import type { List } from '../../core/http/list-query.js';
import type { Capability } from '../records/record.js';

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
 * `listSource('Note', NOTE_LIST, NOTE_CAPABILITIES)`.
 */
export function listSource(
  subject: string,
  list: List,
  capabilities: readonly Capability[],
): Type {
  @Injectable()
  class RegisteredList {
    constructor(registry: ListsRegistry) {
      registry.register({ subject, list, capabilities });
    }
  }
  Object.defineProperty(RegisteredList, 'name', {
    value: `${subject}ListSource`,
  });
  return RegisteredList;
}
