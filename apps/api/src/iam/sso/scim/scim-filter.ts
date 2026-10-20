import { and, type Column, type SQL, sql } from 'drizzle-orm';
import { type Filter, parse } from 'scim2-parse-filter';
import { ScimException } from './scim-error.filter.js';

/** An attribute a list may be filtered on: its column, and whether it compares ignoring case. */
export interface FilterAttribute {
  column: Column | SQL;
  caseInsensitive?: boolean;
  /** A uuid column: another value matches nothing (never a database error). */
  uuid?: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A SCIM `filter` (RFC 7644 §3.4.2.2) as a `where` clause: parsed by
 * scim2-parse-filter, then the subset identity providers send when they
 * look a resource up before creating it (`userName eq "…"`,
 * `externalId eq "…"`, `displayName eq "…"`, joined with `and`), on the
 * attributes given. Anything else is a 400 `invalidFilter`, never a
 * filter silently ignored (which would answer every resource).
 */
export function scimFilter(
  filter: string | undefined,
  attributes: Record<string, FilterAttribute>,
): SQL | undefined {
  if (filter === undefined || filter.trim() === '') {
    return undefined;
  }
  if (filter.length > 1000) {
    throw new ScimException(400, 'The filter is too long.', 'invalidFilter');
  }
  let parsed: Filter;
  try {
    parsed = parse(filter);
  } catch {
    throw new ScimException(400, 'The filter is invalid.', 'invalidFilter');
  }
  const byName = new Map(
    Object.entries(attributes).map(([name, attribute]) => [
      name.toLowerCase(),
      attribute,
    ]),
  );
  const translate = (node: Filter): SQL => {
    if (node.op === 'and') {
      return and(...node.filters.map(translate)) as SQL;
    }
    if (node.op === 'eq') {
      const attribute = byName.get(node.attrPath.toLowerCase());
      if (!attribute) {
        throw new ScimException(
          400,
          `Filtering on ${node.attrPath} isn't supported.`,
          'invalidFilter',
        );
      }
      const value = node.compValue;
      if (typeof value === 'boolean') {
        return sql`${attribute.column} = ${value}`;
      }
      if (typeof value !== 'string') {
        throw new ScimException(
          400,
          `${node.attrPath} compares with a string.`,
          'invalidFilter',
        );
      }
      if (attribute.uuid && !UUID.test(value)) {
        return sql`false`;
      }
      return attribute.caseInsensitive
        ? sql`lower(${attribute.column}) = ${value.toLowerCase()}`
        : sql`${attribute.column} = ${value}`;
    }
    throw new ScimException(
      400,
      `The operator "${node.op}" isn't supported: "eq", joined with "and".`,
      'invalidFilter',
    );
  };
  return translate(parsed);
}

/** `startIndex` (1-based) and `count` of a list (RFC 7644 §3.4.2.4), bounded. */
export function scimPage(startIndex?: number, count?: number) {
  const start = Math.max(1, Math.trunc(startIndex ?? 1));
  const size = Math.min(200, Math.max(0, Math.trunc(count ?? 100)));
  return { offset: start - 1, limit: size, startIndex: start };
}
