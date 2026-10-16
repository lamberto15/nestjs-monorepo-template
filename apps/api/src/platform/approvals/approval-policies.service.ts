import { Injectable, NotFoundException } from '@nestjs/common';
import { I18nService } from '@nestjs/i18n';
import { TransactionHost } from '@nestjs-cls/transactional';
import { desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import { principalKey, type Principal } from '../../iam/auth/principal.js';
import type { ApprovalPolicy } from './approval-policy.js';
import { approvalPolicies } from './approvals.tables.js';
import { ApprovalsRegistry } from './approvals.registry.js';

/** An action's policy in force: the code's default (version 0, or a reset) or an administrator's version. */
export interface EffectivePolicy {
  policy: ApprovalPolicy;
  version: number;
  source: 'code' | 'override';
}

/**
 * Policies in code with runtime overrides. The code declares each action's
 * default; administrators store versions of their own, numbered per action
 * (`PUT /v1/approvals/policies/{key}`), validated against the registered
 * rule, mode and condition types. The newest version applies to new
 * requests; a request keeps the copy it started with. Read from the
 * database every time (one indexed row): nothing to keep in step across
 * instances.
 */
@Injectable()
export class ApprovalPoliciesService {
  /** The code's defaults, with their defaults filled in: code, the same in every process. */
  private readonly defaults = new Map<string, ApprovalPolicy>();

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly registry: ApprovalsRegistry,
    private readonly audit: AuditService,
    private readonly i18n: I18nService,
  ) {}

  private get db() {
    return database(this.txHost);
  }

  /** The declared action, or a 404. */
  private declared(key: string) {
    const declaration = this.registry.declaration(key);
    if (!declaration) {
      throw new NotFoundException({
        code: 'not_found',
        message: this.i18n.translate('approvals.unknownAction', {
          args: { key },
        }),
      });
    }
    return declaration;
  }

  /** The code's default policy of an action. */
  codeDefault(key: string): ApprovalPolicy {
    let policy = this.defaults.get(key);
    if (!policy) {
      policy = this.registry.parsePolicy(this.declared(key).policy);
      this.defaults.set(key, policy);
    }
    return policy;
  }

  /** The policy new requests of `key` get. */
  async effective(key: string): Promise<EffectivePolicy> {
    const [latest] = await this.db
      .select()
      .from(approvalPolicies)
      .where(eq(approvalPolicies.key, key))
      .orderBy(desc(approvalPolicies.version))
      .limit(1);
    return latest?.definition
      ? {
          policy: latest.definition,
          version: latest.version,
          source: 'override',
        }
      : {
          policy: this.codeDefault(key),
          version: latest?.version ?? 0,
          source: 'code',
        };
  }

  /** One action as GET /approvals/policies shows it. */
  async view(key: string) {
    const declaration = this.declared(key);
    const effective = await this.effective(key);
    return {
      key,
      subject: declaration.subject,
      action: declaration.action,
      label: declaration.label,
      description: declaration.description ?? null,
      version: effective.version,
      source: effective.source,
      policy: effective.policy,
      default: this.codeDefault(key),
      setting: declaration.setting?.key ?? null,
      payloadSchema: z.toJSONSchema(declaration.payload, {
        unrepresentable: 'any',
      }) as Record<string, unknown>,
    };
  }

  async list() {
    const items = [];
    for (const { key } of this.registry.actions()) {
      items.push(await this.view(key));
    }
    return { items };
  }

  /** Stores a new version (validated), or with `null` goes back to the code's default. Audited. */
  async set(
    by: Principal,
    key: string,
    input: unknown,
    ip?: string,
    /** The caller's If-Match check, under the lock: the action as they would read it now. */
    unchanged?: (
      shown: Awaited<ReturnType<ApprovalPoliciesService['view']>>,
    ) => void,
  ) {
    this.declared(key);
    const definition = input === null ? null : this.registry.parsePolicy(input);
    await inTransaction(this.txHost, async (tx) => {
      // Two administrators saving at once take turns: versions stay gapless.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`approval-policy:${key}`}))`,
      );
      unchanged?.(await this.view(key));
      const [{ version } = { version: 0 }] = await tx
        .select({
          version: sql<number>`coalesce(max(${approvalPolicies.version}), 0)::int`,
        })
        .from(approvalPolicies)
        .where(eq(approvalPolicies.key, key));
      await tx.insert(approvalPolicies).values({
        key,
        version: version + 1,
        definition,
        changedBy: principalKey(by),
      });
      await this.audit.record(
        by,
        {
          action: definition
            ? 'approvalPolicy.updated'
            : 'approvalPolicy.reset',
          targetType: 'ApprovalPolicy',
          targetId: key,
          details: { version: version + 1, ...(definition && { definition }) },
          ip,
        },
        tx,
      );
    });
    return this.view(key);
  }
}
