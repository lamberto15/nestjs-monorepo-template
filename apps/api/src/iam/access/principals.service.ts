import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, eq, sql } from 'drizzle-orm';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import type { ListQuery } from '../../core/http/list-query.js';
import {
  afterCursor,
  countMatching,
  pageOffset,
  pageOrder,
  toPage,
} from '../../core/http/pagination.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import type { IamEnv } from '../iam.env.js';
import { apiClients, memberships, users } from '../iam.tables.js';
import { PRINCIPAL_LIST, PRINCIPALS_ID } from './access.lists.js';

/** A user or an API client, as a picker shows it. */
export interface PrincipalView {
  id: string;
  /** The principal's key, as settings' overrides and `actor` filters take it. */
  key: string;
  kind: 'user' | 'client';
  /** The user's name, or the client's. */
  label: string;
  /** A user's address; null for a client. */
  email: string | null;
  /** The membership in this tenant and the account (a user), or the client. */
  active: boolean;
}

/**
 * The principals of the current tenant: its members (users are global,
 * reached through their memberships in this tenant, as GET /access/users
 * does) and its API clients (row-level security: another tenant's are no
 * rows), one page of both. The same people and clients the two list routes
 * show, to the same callers; nothing more of them (a name, an address).
 */
@Injectable()
export class PrincipalsService {
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly tenancy: Tenancy,
    private readonly config: ConfigService<IamEnv, true>,
  ) {}

  async page(query: ListQuery) {
    const tenantId = this.tenancy.tenantId();
    const members = this.db
      .select({
        id: users.id,
        kind: sql<'user' | 'client'>`'user'`.as('kind'),
        // Named as the list's fields read them (a column keeps its own name).
        label: sql<string>`${users.name}`.as('label'),
        // Nullable: the clients' rows have none.
        email: sql<string | null>`${users.email}`.as('email'),
        active: sql<boolean>`(${users.active} and ${memberships.active})`.as(
          'active',
        ),
      })
      .from(users)
      .innerJoin(
        memberships,
        and(
          eq(memberships.userId, users.id),
          eq(memberships.tenantId, tenantId),
        ),
      );
    // API_CLIENTS=off: GET /access/clients answers 404, so no client shows here either.
    const principals = (
      this.config.get('API_CLIENTS', { infer: true })
        ? members.unionAll(
            this.db
              .select({
                id: apiClients.id,
                kind: sql<'user' | 'client'>`'client'`.as('kind'),
                label: sql<string>`${apiClients.name}`.as('label'),
                email: sql<string | null>`null::text`.as('email'),
                active: apiClients.active,
              })
              .from(apiClients),
          )
        : members
    ).as('principals');
    const where = PRINCIPAL_LIST.where(query);
    const [rows, total] = await Promise.all([
      this.db
        .select({
          id: principals.id,
          kind: principals.kind,
          label: principals.label,
          email: principals.email,
          active: principals.active,
          ...PRINCIPAL_LIST.sortSelect(query),
        })
        .from(principals)
        .where(and(where, afterCursor(PRINCIPALS_ID, query)))
        .orderBy(...pageOrder(PRINCIPALS_ID, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countMatching(
        this.db,
        this.db
          .select({ one: sql`1` })
          .from(principals)
          .where(where),
        query,
      ),
    ]);
    const page = toPage(rows, query, total);
    return {
      ...page,
      // The sort values (`_sort_label`) go too: PRINCIPAL_LIST.pick() drops them.
      items: page.items.map((row): PrincipalView => ({
        ...row,
        key: `${row.kind}:${row.id}`,
      })),
    };
  }
}
