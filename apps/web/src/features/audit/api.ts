import { unwrap } from '@nestjs-monorepo-template/api-client';
import { api } from '@/lib/api';

export const AUDIT_PAGE_SIZE = 25;

/** What the audit log's filters hold (empty: not filtered). */
export type AuditFilters = {
  /** Matches the start of the action (`note.`), as the API's `startsWith`. */
  action: string;
  /** The actor's principal id (`user:<id>`, `client:<id>`, `system:<job>`). */
  actor: string;
  /** The target's type (`note`, `client`). */
  targetType: string;
  /** Dates (`YYYY-MM-DD`) in the viewer's day, sent as instants. */
  from: string;
  to: string;
};

export const noFilters: AuditFilters = {
  action: '',
  actor: '',
  targetType: '',
  from: '',
  to: '',
};

/** A `YYYY-MM-DD` as the instant its day starts or ends in the viewer's zone. */
function dayBound(day: string, end: boolean): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) {
    return undefined;
  }
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  const date = end
    ? new Date(y, m - 1, d + 1) // the start of the next day, exclusive
    : new Date(y, m - 1, d);
  return date.toISOString();
}

/** The query of GET /v1/access/audit for these filters and this page. */
export function buildAuditQuery(
  filters: AuditFilters,
  page: number,
): Record<string, string> {
  const query: Record<string, string> = {
    page: String(page),
    limit: String(AUDIT_PAGE_SIZE),
    count: 'true',
  };
  const action = filters.action.trim();
  if (action) {
    query['action.startsWith'] = action;
  }
  const actor = filters.actor.trim();
  if (actor) {
    query.actor = actor;
  }
  const targetType = filters.targetType.trim();
  if (targetType) {
    query.targetType = targetType;
  }
  const from = dayBound(filters.from, false);
  if (from) {
    query['at.gte'] = from;
  }
  const to = dayBound(filters.to, true);
  if (to) {
    query['at.lt'] = to;
  }
  return query;
}

export type AuditEntry = {
  id: string;
  at: string;
  actor: string;
  actorLabel: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  details: unknown;
  ip: string | null;
};

export type AuditPageData = {
  items: AuditEntry[];
  page?: number;
  nextPage?: number | null;
  total?: number;
  pageCount?: number;
};

/**
 * The route's answer has no schema in the OpenAPI document, so the client
 * types it as nothing: the shape is AUDIT_LIST's (`access.lists.ts`).
 */
export async function fetchAudit(
  filters: AuditFilters,
  page: number,
): Promise<AuditPageData> {
  return (await unwrap(
    api.GET('/v1/access/audit', {
      params: { query: buildAuditQuery(filters, page) },
    }),
  )) as unknown as AuditPageData;
}
