import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  tenantTables,
  type TenantTableInfo,
} from '../../core/database/tenant-tables.js';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { AccessService } from '../../iam/access/access.service.js';
import { actsAsOperator } from '../../iam/auth/operator-only.js';
import type { Principal } from '../../iam/auth/principal.js';
import { memberships, users } from '../../iam/iam.tables.js';
import { DataTransferRegistry } from '../data-transfer/data-transfer.registry.js';
import type {
  DataExporter,
  TransferColumn,
} from '../data-transfer/data-transfer.types.js';

/** The exporter's name: `startExport({ name: TENANT_EXPORT, internal: true })`. */
export const TENANT_EXPORT = 'tenant';

/** One record of the archive: its table, its id, and all of it. */
export interface TenantRow extends Record<string, unknown> {
  kind: string;
  id: string | null;
  data: Record<string, unknown>;
}

/** Rows read per page of a table. */
const PAGE = 1000;

const filters = z.object({ tenantId: z.uuid() });

/**
 * Every record of one tenant, as a file (the operators'
 * `POST /v1/tenants/{id}/export`, through the data transfers: a queue
 * job, a file on the private disk, a link valid 30 minutes; docs/tenancy.md,
 * "Exporting a tenant"). One row per record: `kind` (its table), `id`,
 * `data` (all of it, as JSON in CSV and Excel); first the tenant itself,
 * then its members' accounts (`member`: id, address, name), then every
 * table with a `tenant_id` (tenantTables(): a feature's own included),
 * keyset-paged by its primary key. Stored credentials' hashes are left
 * out (`tokenHash`, `keyHash`); the stored files are not in it, their
 * rows are (attachments, documents: names, sizes, keys).
 *
 * Read in that tenant's scope (each page in `Tenancy.run()`, so row-level
 * security walls it in as any request of it), and filtered by its
 * `tenant_id` too (the global tables, and the rows of no tenant that some
 * policies show everywhere): never the bypass, never another tenant's
 * row. The job is queued in the operator's tenant, by the operator, so
 * its file is the operators' (`tenants/<operator tenant>/transfers/…`) and
 * stays when the exported tenant is erased.
 *
 * `internal`: started only by its route, which asks a recent sign-in;
 * never through `POST /v1/data/exports` or a scheduled report.
 */
@Injectable()
export class TenantTransfer implements DataExporter<TenantRow> {
  readonly name = TENANT_EXPORT;
  readonly subject = 'Tenant';
  readonly action = 'manageTenants';
  readonly internal = true;
  readonly filters = filters;
  readonly columns: readonly TransferColumn[] = [
    { key: 'kind' },
    { key: 'id' },
    { key: 'data' },
  ];

  /** The current transaction, or the database outside one. */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly tenancy: Tenancy,
    private readonly access: AccessService,
    registry: DataTransferRegistry,
  ) {
    registry.registerExporter(this);
  }

  /**
   * The operators only: a user (never while impersonating) acting in the
   * operator tenant with `Access.manageTenants`, as the route's guards ask.
   */
  async allowed(principal: Principal) {
    return (
      principal.kind === 'user' &&
      !principal.impersonator &&
      (await actsAsOperator(this.tenancy, principal)) &&
      (await this.access.can(principal, 'manageTenants', 'Access'))
    );
  }

  async *batches(
    _principal: Principal,
    query: Record<string, unknown>,
  ): AsyncIterable<TenantRow[]> {
    const { tenantId } = filters.parse(query);
    const tenant = await this.tenancy.find(tenantId);
    if (!tenant) {
      throw new Error('The tenant to export no longer exists.');
    }
    yield [row('tenant', tenant)];
    const members = await this.db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.tenantId, tenantId))
      .orderBy(asc(users.id));
    if (members.length > 0) {
      yield members.map((member) => row('member', member));
    }
    for (const table of tenantTables()) {
      yield* this.tableRows(tenantId, table);
    }
  }

  /** One table's rows of the tenant, a page at a time, after the last page's key. */
  private async *tableRows(
    tenantId: string,
    info: TenantTableInfo,
  ): AsyncIterable<TenantRow[]> {
    let after: unknown[] | undefined;
    for (;;) {
      const keys = info.key.map(({ column }) => column);
      const rows = await this.tenancy.run(tenantId, () =>
        this.db
          .select()
          .from(info.table)
          .where(
            and(
              eq(info.tenantId, tenantId),
              after
                ? sql`(${sql.join(keys, sql`, `)}) > (${sql.join(
                    after.map((value, i) => sql.param(value, keys[i])),
                    sql`, `,
                  )})`
                : undefined,
            ),
          )
          .orderBy(...keys.map((column) => asc(column)))
          .limit(PAGE),
      );
      if (rows.length === 0) {
        return;
      }
      yield rows.map((record: Record<string, unknown>) =>
        row(
          info.name,
          Object.fromEntries(
            Object.entries(record).filter(
              ([property]) => !info.hidden.includes(property),
            ),
          ),
        ),
      );
      if (rows.length < PAGE) {
        return;
      }
      const last = rows[rows.length - 1] as Record<string, unknown>;
      after = info.key.map(({ property }) => last[property]);
    }
  }
}

const row = (kind: string, record: Record<string, unknown>): TenantRow => ({
  kind,
  id: typeof record.id === 'string' ? record.id : null,
  data: record,
});
