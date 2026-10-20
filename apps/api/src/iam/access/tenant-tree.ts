import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Transaction } from '../../core/database/drizzle.js';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import {
  type Tenant,
  tenantClosure,
  tenants,
} from '../../core/tenancy/tenancy.tables.js';
import {
  consolidatedScope,
  requireTenantId,
} from '../../core/tenancy/tenant-scope.js';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { AccessPolicy } from './policies.js';

/** A tenant a consolidated read spans, below the reader's (`depth` 1: a child). */
export interface SubtreeTenant {
  id: string;
  slug: string;
  name: string;
  parentId: string | null;
  depth: number;
}

/**
 * The tenant tree of holding groups (docs/tenancy.md, "The tenant tree"):
 * `tenants.parent_id` and its closure (`tenant_closure`), kept together in
 * the transaction that places a tenant, under one lock for the whole tree
 * (two moves at once could otherwise close a cycle neither saw); and the
 * consolidated reads it allows: a member of a parent with
 * `Access.readConsolidated` reads its active subtree, read-only, audited
 * in the reader's tenant and in each tenant read.
 *
 * The read policies of every tenant table check the tree again
 * (`tenantPolicies()`): a tenant other than `app.tenant_id` is read only
 * when the closure says it is below it, so a child never reads its parent
 * or a sibling, even through a wrong `app.read_tenants`.
 */
@Injectable()
export class TenantTree {
  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly tenancy: Tenancy,
    private readonly audit: AuditService,
    private readonly policy: AccessPolicy,
  ) {}

  /**
   * Places `tenant` under `parentId` (null: makes it a root), in the
   * caller's transaction, which holds the tenant's row lock: its
   * `parent_id`, and the closure rows of it and everything below it.
   * Refused: the operator tenant, in a tree on either side (409
   * `operator_tenant`: the operators never read a tenant's data, nor does
   * a tenant theirs); a parent that isn't there (404), whose deletion is
   * pending (409 `tenant_deletion_pending`), or that is the tenant itself
   * or below it (409 `tenant_tree_cycle`).
   */
  async place(tx: Transaction, tenant: Tenant, parentId: string | null) {
    await lockTree(tx);
    if (tenant.operator) {
      throw operatorInTree();
    }
    if (parentId !== null) {
      // No row lock on the parent: the tree's lock (above) is what a
      // deletion request takes too, so its pending deletion is seen here.
      const [parent] = await tx
        .select()
        .from(tenants)
        .where(eq(tenants.id, parentId));
      if (!parent) {
        throw new NotFoundException({
          code: 'not_found',
          message: `Tenant ${parentId} not found.`,
          errors: [{ path: 'parentId', message: 'No such tenant.' }],
        });
      }
      if (parent.operator) {
        throw operatorInTree();
      }
      if (parent.deletionScheduledFor) {
        throw new ConflictException({
          code: 'tenant_deletion_pending',
          message: 'The parent’s deletion is pending: it takes no children.',
          errors: [{ path: 'parentId', message: 'Its deletion is pending.' }],
        });
      }
      if (
        parent.id === tenant.id ||
        (await this.isBelow(tx, parent.id, tenant.id))
      ) {
        throw new ConflictException({
          code: 'tenant_tree_cycle',
          message:
            'A tenant can’t be placed under itself or under one of its descendants.',
          errors: [
            { path: 'parentId', message: 'It is this tenant or below it.' },
          ],
        });
      }
    }
    // Detach the subtree (the tenant and everything below it) from its
    // ancestors, then link it under the new parent's ancestors and the
    // parent itself. The rows inside the subtree stay as they are.
    await tx.execute(sql`
      delete from ${tenantClosure} c
      where c.descendant_id in (
              select ${tenant.id}::uuid
              union all
              select descendant_id from ${tenantClosure} where ancestor_id = ${tenant.id}
            )
        and c.ancestor_id in (
              select ancestor_id from ${tenantClosure} where descendant_id = ${tenant.id}
            )`);
    if (parentId !== null) {
      await tx.execute(sql`
        insert into ${tenantClosure} (ancestor_id, descendant_id, depth)
        select above.id, below.id, above.depth + below.depth + 1
        from (
          select ${parentId}::uuid as id, 0 as depth
          union all
          select ancestor_id, depth from ${tenantClosure} where descendant_id = ${parentId}
        ) above
        cross join (
          select ${tenant.id}::uuid as id, 0 as depth
          union all
          select descendant_id, depth from ${tenantClosure} where ancestor_id = ${tenant.id}
        ) below`);
    }
    const [placed] = await tx
      .update(tenants)
      .set({ parentId })
      .where(eq(tenants.id, tenant.id))
      .returning();
    return placed!;
  }

  /** Whether the tenant has children (a tenant with some is never deleted). */
  async hasChildren(tx: Transaction, id: string) {
    await lockTree(tx);
    const [child] = await tx
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.parentId, id))
      .limit(1);
    return !!child;
  }

  /**
   * The tenants below `tenantId` a consolidated read spans: the active
   * ones none of whose ancestors up to `tenantId` is inactive (a
   * deactivated tenant exposes nothing, nor do the tenants below it), and
   * none whose deletion is pending. Nearest first.
   */
  async subtree(tenantId: string): Promise<SubtreeTenant[]> {
    return database(this.txHost)
      .select({
        id: tenants.id,
        slug: tenants.slug,
        name: tenants.name,
        parentId: tenants.parentId,
        depth: tenantClosure.depth,
      })
      .from(tenantClosure)
      .innerJoin(tenants, eq(tenants.id, tenantClosure.descendantId))
      .where(
        and(
          eq(tenantClosure.ancestorId, tenantId),
          eq(tenants.active, true),
          sql`${tenants.deletionScheduledFor} is null`,
          // No closed tenant between the reader's and this one.
          sql`not exists (
            select 1 from ${tenantClosure} up
            join ${tenants} middle on middle.id = up.ancestor_id
            join ${tenantClosure} reach on reach.descendant_id = up.ancestor_id and reach.ancestor_id = ${tenantId}
            where up.descendant_id = ${tenantClosure.descendantId}
              and (not middle.active or middle.deletion_scheduled_for is not null)
          )`,
        ),
      )
      .orderBy(asc(tenantClosure.depth), asc(tenants.slug));
  }

  /**
   * Runs `work` as a consolidated read of the principal's tenant and its
   * subtree (`subtree()`): reads see those tenants' rows, nothing is
   * written (every transaction `READ ONLY`). Needs `Access.readConsolidated`
   * (a user, not impersonating; 403 `consolidated_read_forbidden`
   * otherwise), checked here whatever the route checked. Audited
   * `tenant.consolidated-read` (`what`, the tenants read) in the reader's
   * tenant and in each tenant read, before the read: a child's
   * administrators see who read it.
   */
  async consolidated<T>(
    principal: Principal,
    what: string,
    work: (tenants: SubtreeTenant[]) => Promise<T>,
  ): Promise<T> {
    if (!(await this.policy.readConsolidated(principal))) {
      throw new ForbiddenException({
        code: 'consolidated_read_forbidden',
        message:
          'Reading the tenants below yours needs Access.readConsolidated.',
      });
    }
    const tenantId = requireTenantId('A consolidated read');
    const below = await this.subtree(tenantId);
    const entry = {
      action: 'tenant.consolidated-read',
      targetType: 'tenant',
      targetId: tenantId,
      details: { what, tenants: below.map((tenant) => tenant.id) },
    };
    await this.audit.record(principal, entry);
    for (const tenant of below) {
      await this.tenancy.run(tenant.id, () =>
        this.audit.record(principal, entry),
      );
    }
    return this.tenancy.run(
      consolidatedScope(
        tenantId,
        below.map((tenant) => tenant.id),
      ),
      () => work(below),
    );
  }

  /** Whether `id` is below `ancestor` in the tree (the closure says so). */
  private async isBelow(tx: Transaction, id: string, ancestor: string) {
    const [row] = await tx
      .select({ depth: tenantClosure.depth })
      .from(tenantClosure)
      .where(
        and(
          eq(tenantClosure.ancestorId, ancestor),
          eq(tenantClosure.descendantId, id),
        ),
      );
    return !!row;
  }
}

/**
 * One lock for the whole tree, for the transaction: a move reads the
 * closure, then writes it, and two moves at once (A under B, B under A)
 * would each pass the cycle check on what the other hasn't written yet.
 */
const lockTree = (tx: Transaction) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext('tenant-tree'))`);

/** 409 `operator_tenant`: the operator tenant is never in a tree. */
const operatorInTree = () =>
  new ConflictException({
    code: 'operator_tenant',
    message:
      'The operator tenant is never in a tenant tree: its members run the deployment and read no tenant’s data.',
  });
