import { Injectable } from '@nestjs/common';
import { and, desc, getTableColumns } from 'drizzle-orm';
import { headline, matches, rank } from '../../core/database/search.js';
import { AccessService } from '../../iam/access/access.service.js';
import type { Principal } from '../../iam/auth/principal.js';
import {
  type SearchHit,
  SearchRegistry,
  type SearchSource,
} from '../../platform/search/search.registry.js';
import { notes } from './notes.tables.js';
import { NotesService } from './notes.service.js';

/**
 * Notes in the global search: the ones the principal may read (the
 * list's SQL filter), best match first, with a snippet of the text when
 * they may read it.
 */
@Injectable()
export class NoteSearch implements SearchSource {
  readonly subject = 'Note';

  constructor(
    private readonly notes: NotesService,
    private readonly access: AccessService,
    registry: SearchRegistry,
  ) {
    registry.register(this);
  }

  async search(
    principal: Principal,
    q: string,
    limit: number,
  ): Promise<SearchHit[]> {
    const where = and(
      await this.access.sqlFilter(principal, 'Note', 'read'),
      matches(notes.search, q),
    );
    const score = rank(notes.search, q);
    const rows = await this.notes.query((db) =>
      db
        // The whole row: the permission conditions (`mine`) read it.
        .select({
          ...getTableColumns(notes),
          score,
          titleSnippet: headline(notes.title, q),
          bodySnippet: headline(notes.body, q),
        })
        .from(notes)
        .where(where)
        .orderBy(desc(score), desc(notes.id))
        .limit(limit),
    );
    // Field-level permissions: no snippet of a text the caller may not read.
    const shown = await this.access.redactAll(principal, 'read', 'Note', rows);
    return shown.map((row) => ({
      subject: 'Note',
      id: row.id!,
      title: row.title!,
      snippet:
        'body' in row && row.body
          ? (row.bodySnippet as string)
          : row.titleSnippet === row.title
            ? null
            : (row.titleSnippet as string),
      score: Number(row.score),
      link: `/notes/${row.id}`,
    }));
  }
}
