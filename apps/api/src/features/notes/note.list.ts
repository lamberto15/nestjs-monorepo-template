import { searchFields } from '../../core/database/search.js';
import { listQuery } from '../../core/http/list-query.js';
import { tagFilter } from '../../platform/tags/tag.list.js';
import { noteSchema } from './note.schemas.js';
import { notes } from './notes.tables.js';

/** What GET /notes can be filtered, sorted (`sortable`) and narrowed (`select`) by. */
export const NOTE_LIST = listQuery(
  {
    // ?q=words (web search syntax) and ?sort=-rank: the best match first; the vector holds the title and the text.
    ...searchFields(notes.search, ['title', 'body']),
    // ?tag=<id> and ?tag.in=<id>,<id>: the notes carrying it (any of them).
    ...tagFilter('Note', notes.id),
    number: {
      column: notes.number,
      type: 'string',
      ops: ['eq', 'startsWith'],
      sortable: true,
    },
    status: {
      column: notes.status,
      type: 'enum',
      values: ['draft', 'published'],
      ops: ['eq', 'ne', 'in', 'notIn'],
      sortable: true,
    },
    title: {
      column: notes.title,
      type: 'string',
      ops: ['contains', 'notContains', 'startsWith', 'endsWith'],
      sortable: true,
    },
    ownerId: {
      column: notes.ownerId,
      type: 'string',
      ops: ['eq'],
      ref: 'principal',
    },
    teamId: {
      column: notes.teamId,
      type: 'uuid',
      ops: ['eq', 'in', 'isNull'],
      ref: 'team',
    },
    createdAt: {
      column: notes.createdAt,
      type: 'datetime',
      ops: ['gt', 'gte', 'lt', 'lte', 'between'],
      sortable: true,
    },
    updatedAt: {
      column: notes.updatedAt,
      type: 'datetime',
      ops: ['gt', 'gte', 'lt', 'lte', 'between'],
      sortable: true,
    },
    publishedAt: {
      column: notes.publishedAt,
      type: 'datetime',
      ops: ['gt', 'gte', 'lt', 'lte', 'between', 'isNull'],
      sortable: true,
    },
  },
  { select: Object.keys(noteSchema.shape), softDelete: true },
);
