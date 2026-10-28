import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { eq } from 'drizzle-orm';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import type { UserPrincipal } from '../auth/principal.js';
import { UsersRepository } from '../auth/users.repository.js';
import { roles, userRoles } from '../iam.tables.js';
import { AccessRecordsRegistry } from './access-records.registry.js';
import { AccessService } from './access.service.js';
import { PermissionCatalog } from './permission-catalog.js';
import { isAll } from './permissions.js';

/**
 * Why a member may or may not act on a subject or one of its records
 * (docs/permissions.md, "Explaining access"): AccessService.explain() does
 * the checking, with the engine's own code; this adds who, which roles,
 * and keeps it to what the asker may see. The record is looked up as the
 * asker (one they may not read is a 404, as on its own routes), and an
 * answer that a field hidden from them decides is withheld.
 */
@Injectable()
export class AccessExplanationService {
  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly access: AccessService,
    private readonly catalog: PermissionCatalog,
    private readonly accounts: UsersRepository,
    private readonly tenancy: Tenancy,
    private readonly records: AccessRecordsRegistry,
  ) {}

  private get db() {
    return database(this.txHost);
  }

  async explain(
    asker: UserPrincipal,
    userId: string,
    subject: string,
    recordId?: string,
  ) {
    const declared = this.catalog.subjects[subject];
    if (!declared) {
      throw new BadRequestException({
        code: 'unknown_subject',
        message: `No permission subject is named ${subject}.`,
      });
    }
    const member = await this.accounts.findMember(
      this.tenancy.tenantId(),
      userId,
    );
    if (!member) {
      throw new NotFoundException(`User ${userId} not found.`);
    }
    let record: Record<string, unknown> | undefined;
    let hidden: string[] = [];
    if (recordId) {
      const finder = this.records.finder(subject);
      if (!finder) {
        throw new BadRequestException({
          code: 'subject_without_records',
          message: `${subject} has no records to explain: leave recordId out.`,
        });
      }
      const found = await finder.find(recordId, asker);
      if (!found) {
        throw new NotFoundException(`${subject} ${recordId} not found.`);
      }
      record = found;
      const shown = await this.access.redact(asker, 'read', subject, found);
      hidden = this.catalog
        .declaredFields(subject)
        .filter((field) => !(field in shown));
    }
    // The ability reads only the principal's kind and id (and the tenant: the request's).
    const principal = { kind: 'user', id: userId } as UserPrincipal;
    const [explanation, grants] = await Promise.all([
      this.access.explain(
        principal,
        subject,
        Object.keys(declared.actions),
        record,
        hidden,
      ),
      this.db
        .select({
          id: roles.id,
          name: roles.name,
          expiresAt: userRoles.expiresAt,
        })
        .from(userRoles)
        .innerJoin(roles, eq(roles.id, userRoles.roleId))
        .where(eq(userRoles.userId, userId))
        .orderBy(roles.name),
    ]);
    const now = Date.now();
    return {
      user: { id: member.id, name: member.name, email: member.email },
      subject,
      recordId: recordId ?? null,
      // Every grant, an ended one too: it counts for nothing (`expired`).
      roles: grants.map((grant) => ({
        id: grant.id,
        name: grant.name,
        expiresAt: grant.expiresAt?.toISOString() ?? null,
        expired: grant.expiresAt !== null && grant.expiresAt.getTime() <= now,
      })),
      units: {
        direct: explanation.context.directUnitIds,
        andBelow: explanation.context.unitIdsAndBelow,
        ledAndBelow: explanation.context.ledUnitIdsAndBelow,
      },
      actions: explanation.actions.map((action) => ({
        action: action.action,
        allowed: action.allowed,
        fields: action.fields,
        grants: action.grants.map((grant) => {
          const { permission, roleId, expiresAt } =
            explanation.held[grant.index]!;
          return {
            roleId,
            expiresAt: expiresAt?.toISOString() ?? null,
            all: isAll(permission),
            fields: permission.fields ?? null,
            matches: grant.matches,
            conditions: grant.conditions.map((condition, i) => ({
              key: condition.key,
              params: permission.conditions[i]?.params ?? null,
              matches: condition.matches,
            })),
          };
        }),
      })),
    };
  }
}
