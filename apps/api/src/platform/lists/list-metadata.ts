import {
  type List,
  MAX_CONDITIONS,
  MAX_DEPTH,
  MAX_VALUES,
} from '../../core/http/list-query.js';
import { MAX_SORT } from '../../core/http/list-sort.js';
import {
  COUNT_CAP,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from '../../core/http/pagination.js';
import type {
  ListField,
  ListMetadata,
  ListViewsDeclaration,
} from './list-metadata.schemas.js';

/** The list fields `searchFields()` declares: `search: true` stands for them. */
const SEARCH_FIELDS = ['q', 'rank'];
const CUSTOM_PREFIX = 'custom.';

/** The limits every list shares (core/http/list-query.ts, pagination.ts, list-sort.ts). */
export const LIST_LIMITS: ListMetadata['limits'] = {
  defaultLimit: DEFAULT_LIMIT,
  maxLimit: MAX_LIMIT,
  maxOffset: COUNT_CAP,
  countCap: COUNT_CAP,
  maxSort: MAX_SORT,
  maxConditions: MAX_CONDITIONS,
  maxDepth: MAX_DEPTH,
  maxValues: MAX_VALUES,
};

/**
 * A list declaration (`listQuery()`, extended with the custom fields when
 * the subject takes them) as a client builds its filter menus, sort and
 * column pickers from it: read from the declaration itself, so it can't
 * drift from what the list route accepts. The subject's capabilities come
 * from its registration (ListsService).
 *
 * - `hidden(name)`: a field the caller may not read; it is left out of
 *   `fields` and `select`.
 * - `unmatchable(name)`: a field the caller may read on some records only;
 *   it stays (and in `select`) with no operators and not sortable, and
 *   `search` is false when `q` reads one (the list route refuses those).
 * - Fields neither filterable nor sortable are only in `select`.
 */
export function listMetadata(
  subject: string,
  list: List,
  {
    hidden = () => false,
    unmatchable = () => false,
    labels = new Map(),
    recycleBin = false,
  }: {
    hidden?: (name: string) => boolean;
    /** A field the caller may read on some records only: not filtered nor sorted by. */
    unmatchable?: (name: string) => boolean;
    /** Custom fields' labels, by key. */
    labels?: ReadonlyMap<string, string>;
    /** Whether the caller may list the recycle bin (with `softDelete`). */
    recycleBin?: boolean;
  } = {},
): Omit<
  ListMetadata,
  'capabilities' | 'views' | 'attachmentLimits' | 'documentTemplates'
> {
  // `q` reads the search document's fields: off with any of them hidden, or
  // shown on some records only.
  const searchable = 'q' in list.fields;
  const search = searchable && !hidden('q') && !unmatchable('q');
  const fields: ListField[] = [];
  for (const [name, field] of Object.entries(list.fields)) {
    if (
      (searchable && SEARCH_FIELDS.includes(name)) ||
      (!field.ops.length && !field.sortable) ||
      hidden(name)
    ) {
      continue;
    }
    const matchable = !unmatchable(name);
    const custom = name.startsWith(CUSTOM_PREFIX);
    const label = custom
      ? labels.get(name.slice(CUSTOM_PREFIX.length))
      : undefined;
    fields.push({
      name,
      type: field.type,
      ...(field.type === 'enum' && { options: [...field.values] }),
      operators: matchable ? [...field.ops] : [],
      sortable: matchable && field.sortable === true,
      custom,
      ...(field.ref !== undefined && { ref: field.ref }),
      ...(label !== undefined && { label }),
    });
  }
  return {
    subject,
    fields,
    select: (list.options.select ?? []).filter((name) => !hidden(name)),
    search,
    recycleBin: list.options.softDelete === true && recycleBin,
    // Without `sort`, the newest first: by id (UUIDv7), the order of createdAt.
    defaultSort: list.fields.createdAt?.sortable ? '-createdAt' : null,
    limits: LIST_LIMITS,
  };
}

const DATES = ['date', 'datetime'];

/**
 * A declaration's views must name fields of the list of the right type
 * (an enum for the board, `date` or `datetime` for the others): a
 * mistake fails at startup, not in a client.
 */
export function checkListViews(
  subject: string,
  list: List,
  views: ListViewsDeclaration,
) {
  const check = (name: string, types: string[], what: string) => {
    const type = list.fields[name]?.type;
    if (type === undefined || !types.includes(type)) {
      throw new Error(
        `${subject}: ${what} "${name}" must be a list field of type ${types.join(' or ')}.`,
      );
    }
  };
  if (views.board) check(views.board.field, ['enum'], 'the board field');
  for (const name of views.calendar?.fields ?? []) {
    check(name, DATES, 'the calendar field');
  }
  if (views.calendar?.fields.length === 0) {
    throw new Error(`${subject}: the calendar needs a field.`);
  }
  if (views.timeline) {
    check(views.timeline.start, DATES, 'the timeline start');
    check(views.timeline.end, DATES, 'the timeline end');
  }
}

/**
 * The declared views this caller can use: a view stays when every field it
 * reads is in the description (not hidden from them) with the operators it
 * bounds its query by, so a client never asks for what the list refuses
 * (403 `field_forbidden`, 400). A calendar keeps the fields that qualify.
 */
export function listViews(
  declared: ListViewsDeclaration | undefined,
  fields: readonly ListField[],
): ListMetadata['views'] {
  if (!declared) return null;
  const usable = (name: string, ...ops: string[]) => {
    const field = fields.find((f) => f.name === name);
    return (
      field !== undefined &&
      ops.every((op) => (field.operators as string[]).includes(op))
    );
  };
  const calendar = declared.calendar?.fields.filter((name) =>
    usable(name, 'gte', 'lt'),
  );
  const views: NonNullable<ListMetadata['views']> = {
    ...(declared.board &&
      usable(declared.board.field, 'eq') && {
        board: {
          field: declared.board.field,
          readOnly: declared.board.readOnly ?? false,
        },
      }),
    ...(declared.calendar &&
      calendar &&
      calendar.length > 0 && {
        calendar: {
          fields: calendar,
          readOnly: declared.calendar.readOnly ?? false,
        },
      }),
    ...(declared.timeline &&
      usable(declared.timeline.start, 'lt') &&
      usable(declared.timeline.end, 'gte', 'isNull') && {
        timeline: declared.timeline,
      }),
  };
  return Object.keys(views).length > 0 ? views : null;
}
