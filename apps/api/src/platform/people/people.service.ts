import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, asc, count, desc, eq, ilike, inArray } from 'drizzle-orm';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import { escapeLike } from '../../core/http/list-query.js';
import { afterCursor, toPage } from '../../core/http/pagination.js';
import { requireTenantId } from '../../core/tenancy/tenant-scope.js';
import {
  apiClients,
  memberships,
  teams,
  teamTree,
  users,
} from '../../iam/iam.tables.js';
import { avatarUrl } from '../../iam/account/avatar-url.js';
import type { Principal } from '../../iam/auth/principal.js';
import { UsersRepository } from '../../iam/auth/users.repository.js';
import type { TeamsQuery } from './people.schemas.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Who someone is, as any member of the tenant may see them: their key and name. */
export interface Person {
  /** `user:<id>`: what `@user:<id>` mentions, and what `author`, `changedBy`, `ownerId` hold. */
  key: string;
  name: string;
  /** The user's picture (`/v1/people/<id>/avatar?v=…`); null: none, and for an API client. */
  avatarUrl: string | null;
}

/** A team, as any member of the tenant may see it: its name and its place in the tree. */
export interface TeamRef {
  id: string;
  name: string;
  parentId: string | null;
  /** 0 for a top-level team. */
  depth: number;
}

/**
 * The people of the current tenant, as its members see each other: the
 * names behind the principal keys records store (a comment's `author`, a
 * revision's `changedBy`; GET /v1/people?key=), the directory @mention
 * autocomplete searches (GET /v1/people), and the teams' names and tree
 * (GET /v1/teams). Only a key and a name, never an address or a role (a
 * team: its id, name and place, never its members): the access API
 * (`Access.manageUsers`, `manageTeams`) is where they are managed. Users are global (docs/tenancy.md): every query is held to
 * the tenant's memberships, so a key of someone outside it has no name
 * here. API clients are tenant rows behind row-level security.
 * Custom code: no @nestjs package resolves the app's own principals.
 */
@Injectable()
export class PeopleService {
  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly users: UsersRepository,
  ) {}

  /**
   * The `user:<id>` keys behind these addresses (lower-cased, as
   * `users.email` is), among `among` only: a mention is told by an address
   * only where it already resolved to one of the keys a comment holds, so
   * this never says whether an address belongs to anyone else.
   */
  async keysOfEmails(
    emails: Iterable<string>,
    among: Iterable<string>,
  ): Promise<Map<string, string>> {
    const ids = [...new Set(among)]
      .filter((key) => key.startsWith('user:'))
      .map((key) => key.slice('user:'.length))
      .filter((id) => UUID.test(id));
    const addresses = [...new Set(emails)];
    if (!ids.length || !addresses.length) {
      return new Map();
    }
    const rows = await this.db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(and(inArray(users.id, ids), inArray(users.email, addresses)));
    return new Map(rows.map((row) => [row.email, `user:${row.id}`]));
  }

  /**
   * The names of these principal keys, in two queries whatever their
   * number (a page's authors): a user who is or was a member of the
   * tenant (their membership may be inactive since: the name stays on
   * what they wrote), an API client of the tenant. Anything else (a
   * deleted account's `anonymous`, `unknown`, another tenant's user, a
   * removed client) is null.
   */
  async names(keys: Iterable<string>): Promise<Map<string, string | null>> {
    const found = await this.find(keys);
    return new Map(
      [...found].map(([key, person]) => [key, person?.name ?? null]),
    );
  }

  /** `names()` with each user's picture: the person behind each key, or null. */
  private async find(
    keys: Iterable<string>,
  ): Promise<Map<string, { name: string; avatarUrl: string | null } | null>> {
    const tenantId = requireTenantId('A name');
    const all = [...new Set(keys)];
    const ids = (kind: string) =>
      all
        .filter((key) => key.startsWith(`${kind}:`))
        .map((key) => key.slice(kind.length + 1))
        .filter((id) => UUID.test(id));
    const userIds = ids('user');
    const clientIds = ids('client');
    const [people, clients] = await Promise.all([
      userIds.length
        ? this.db
            .select({
              id: users.id,
              name: users.name,
              avatarKey: users.avatarKey,
            })
            .from(users)
            .innerJoin(
              memberships,
              and(
                eq(memberships.userId, users.id),
                eq(memberships.tenantId, tenantId),
              ),
            )
            .where(inArray(users.id, userIds))
        : [],
      clientIds.length
        ? this.db
            .select({ id: apiClients.id, name: apiClients.name })
            .from(apiClients)
            .where(
              and(
                inArray(apiClients.id, clientIds),
                eq(apiClients.tenantId, tenantId),
              ),
            )
        : [],
    ]);
    const found = new Map<string, { name: string; avatarUrl: string | null }>([
      ...people.map(
        (row) =>
          [
            `user:${row.id}`,
            { name: row.name, avatarUrl: avatarUrl(row.id, row.avatarKey) },
          ] as const,
      ),
      ...clients.map(
        (row) =>
          [`client:${row.id}`, { name: row.name, avatarUrl: null }] as const,
      ),
    ]);
    return new Map(all.map((key) => [key, found.get(key) ?? null]));
  }

  /**
   * The people behind these keys (`user:<id>`, `client:<id>`), in the order
   * asked, each once: who `names()` names (a member or former member of the
   * tenant, an API client of it). A key with no name here (another
   * tenant's user, a removed client, an unknown id) is left out, so the
   * answer never tells such a key from one that doesn't exist.
   */
  async named(keys: readonly string[]): Promise<Person[]> {
    const found = await this.find(keys);
    return [...found].flatMap(([key, person]) =>
      person === null ? [] : [{ key, ...person }],
    );
  }

  /**
   * The tenant's teams as every member sees them (GET /v1/teams): id, name,
   * parent and depth, nothing else (no members; the access API manages
   * them). Newest first in cursor pages; `q` a part of the name (any case,
   * `%` and `_` themselves), `id` the ones to name. Row-level security
   * holds teams to the tenant; the explicit tenant condition keeps a
   * scope that reads several tenants (an operator's) to the current one.
   */
  async teams(query: TeamsQuery) {
    const tenantId = requireTenantId('The teams');
    const rows = await this.db
      .select({
        id: teams.id,
        name: teams.name,
        parentId: teams.parentId,
      })
      .from(teams)
      .where(
        and(
          eq(teams.tenantId, tenantId),
          query.q ? ilike(teams.name, `%${escapeLike(query.q)}%`) : undefined,
          query.id ? inArray(teams.id, query.id) : undefined,
          afterCursor(teams.id, query),
        ),
      )
      .orderBy(desc(teams.id))
      .limit(query.limit + 1);
    const page = toPage(rows, query);
    const ids = page.items.map((team) => team.id);
    // A team is its own ancestor in the closure table: its depth is the count of its ancestors, minus one.
    const depths = ids.length
      ? await this.db
          .select({ id: teamTree.descendantId, ancestors: count() })
          .from(teamTree)
          .where(
            and(
              eq(teamTree.tenantId, tenantId),
              inArray(teamTree.descendantId, ids),
            ),
          )
          .groupBy(teamTree.descendantId)
      : [];
    const depthOf = new Map(depths.map((row) => [row.id, row.ancestors - 1]));
    return {
      items: page.items.map((team): TeamRef => ({
        ...team,
        depth: depthOf.get(team.id) ?? 0,
      })),
      nextCursor: page.nextCursor,
    };
  }

  /**
   * The tenant's active members (an active account, an active membership
   * in this tenant) whose name contains `q` (any case; `%` and `_` are
   * themselves), by name: for @mention autocomplete. Without `q`, the
   * first by name. API clients are not people here: a mention names a user.
   */
  async directory(q: string | undefined, limit: number): Promise<Person[]> {
    const tenantId = requireTenantId('The directory');
    const rows = await this.db
      .select({ id: users.id, name: users.name, avatarKey: users.avatarKey })
      .from(users)
      .innerJoin(
        memberships,
        and(
          eq(memberships.userId, users.id),
          eq(memberships.tenantId, tenantId),
          eq(memberships.active, true),
        ),
      )
      .where(
        and(
          eq(users.active, true),
          q ? ilike(users.name, `%${escapeLike(q)}%`) : undefined,
        ),
      )
      .orderBy(asc(users.name), asc(users.id))
      .limit(limit);
    return rows.map((row) => ({
      key: `user:${row.id}`,
      name: row.name,
      avatarUrl: avatarUrl(row.id, row.avatarKey),
    }));
  }

  /**
   * The principal behind a key, as it is now in the current tenant: an
   * active member, an active API client of the tenant; null for anyone
   * else (deactivated, gone, another tenant's). What a push to someone
   * checks their permissions with (a record's watchers: RecordActivity).
   */
  async principal(key: string): Promise<Principal | null> {
    const tenantId = requireTenantId('A principal');
    const [kind, id] = key.split(':') as [string, string | undefined];
    if (!id || !UUID.test(id)) {
      return null;
    }
    if (kind === 'user') {
      const user = await this.users.inTenant(id, tenantId);
      return user?.tenantId === tenantId ? user : null;
    }
    if (kind !== 'client') {
      return null;
    }
    const [client] = await this.db
      .select()
      .from(apiClients)
      .where(and(eq(apiClients.id, id), eq(apiClients.tenantId, tenantId)));
    return client?.active
      ? {
          kind: 'client',
          id: client.id,
          name: client.name,
          tenantId: client.tenantId,
          dailyQuota: client.dailyQuota,
        }
      : null;
  }
}
