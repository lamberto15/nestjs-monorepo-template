import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { Outbox, type OutboxHandlerContext } from '@nestjs/outbox';
import { Webhooks } from '@nestjs/webhooks';
import { and, count, desc, eq, gt, inArray, type SQL } from 'drizzle-orm';
import type { Transaction } from '../../core/database/drizzle.js';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { withoutEncrypted } from '../../core/encryption/encrypted-columns.js';
import type { ListQuery } from '../../core/http/list-query.js';
import {
  afterCursor,
  countPage,
  pageOrder,
  toPage,
} from '../../core/http/pagination.js';
import type { TenantEnvelope } from '../../core/tenancy/tenant-job.js';
import { currentTenantId } from '../../core/tenancy/tenant-scope.js';
import { AccessService } from '../../iam/access/access.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import {
  type Principal,
  principalKey,
  type SystemPrincipal,
} from '../../iam/auth/principal.js';
import { UsersRepository } from '../../iam/auth/users.repository.js';
import { apiClients } from '../../iam/iam.tables.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { TagsService } from '../tags/tags.service.js';
import { tags } from '../tags/tags.tables.js';
import { AUTOMATION_WEBHOOK_EVENT } from './automation-events.js';
import {
  AUTOMATION_RULE_LIST,
  AUTOMATION_RUN_LIST,
} from './automation.list.js';
import type {
  AutomationAction,
  AutomationRunAction,
  AutomationSimulation,
  CreateAutomationRuleDto,
  SimulateAutomationRuleDto,
  UpdateAutomationRuleDto,
} from './automation.schemas.js';
import {
  type AutomationRecord,
  type AutomationTarget,
  AutomationsRegistry,
} from './automations.registry.js';
import {
  type AutomationRuleRow,
  type AutomationRunRow,
  automationRules,
  automationRuns,
} from './automations.tables.js';

/** The outbox topic of a rule's run on one record's change. */
export const AUTOMATIONS_TOPIC = 'automations.run';
/** At most this many active rules per tenant: a write starts at most this many runs. */
export const MAX_ACTIVE_RULES = 20;
/** Runs of one rule in an hour, at most: past it the rule is disabled (`run_limit`). */
export const MAX_RUNS_PER_HOUR = 100;
/** Failed runs in a row before the rule is disabled (`failing`). */
export const MAX_FAILURES = 5;

/** What a rule's run carries through the outbox. */
export interface AutomationMessage extends TenantEnvelope {
  tenantId: string;
  ruleId: string;
  version: number;
  recordId: string;
}

/** The parts of a rule that decide what it does. */
type Definition = Pick<
  AutomationRuleRow,
  'subject' | 'trigger' | 'field' | 'filters' | 'actions'
>;

/** One action, checked: what it would do and, when allowed, how. */
interface Planned {
  result: AutomationRunAction;
  apply?: (tx: Transaction) => Promise<void>;
}

/** A run that cannot succeed by trying again (a permission, a gone record). */
class AutomationRefused extends Error {}

/**
 * Set while a rule's actions run: the writes they make start no rule
 * (RecordLifecycle and the features call `changed()`, which skips them),
 * so rules never trigger themselves or each other in a loop.
 */
const AUTOMATING = new AsyncLocalStorage<true>();

const NOT_SETTABLE = 'field_forbidden';

const view = (rule: AutomationRuleRow) => ({
  id: rule.id,
  name: rule.name,
  subject: rule.subject,
  trigger: rule.trigger,
  field: rule.field,
  filters: rule.filters,
  actions: rule.actions,
  status: rule.status,
  version: rule.version,
  owner: rule.owner,
  activatedAt: rule.activatedAt?.toISOString() ?? null,
  disabledReason: rule.disabledReason,
  failures: rule.failures,
  lastRunAt: rule.lastRunAt?.toISOString() ?? null,
  lastStatus: rule.lastStatus ?? null,
  createdAt: rule.createdAt.toISOString(),
  updatedAt: rule.updatedAt.toISOString(),
});

const runView = (run: AutomationRunRow) => ({
  id: run.id,
  ruleVersion: run.ruleVersion,
  recordId: run.recordId,
  status: run.status,
  actions: run.actions,
  error: run.error,
  createdAt: run.createdAt.toISOString(),
});

const invalid = (errors: { path: string; message: string }[]) =>
  new BadRequestException({
    code: 'validation_failed',
    message: 'The request is invalid.',
    errors,
  });

/** Page parameters a rule's conditions never take: they are a filter, not a page. */
const PAGE_KEYS = [
  'limit',
  'cursor',
  'page',
  'count',
  'sort',
  'fields',
  'deleted',
];

/**
 * Tenant automation rules (docs/automations.md): when a record of a
 * subject that takes the `automation` capability is created or updated
 * and matches the conditions, the actions run, on a worker, through the
 * outbox (the run is queued in the write's transaction: it happens if
 * and only if the write commits, once: the consumer's inbox). One
 * evaluator for both runs and simulations (`evaluate()`, `plan()`): a
 * simulation is a run without `apply`. A rule runs as the user who
 * activated it, with their permissions as they are at each run.
 */
@Injectable()
export class AutomationsService {
  private readonly logger = new Logger('Automations');

  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly registry: AutomationsRegistry,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly users: UsersRepository,
    private readonly tagsService: TagsService,
    private readonly notifications: NotificationsService,
    private readonly outbox: Outbox<Transaction>,
    private readonly webhooks: Webhooks<Transaction>,
  ) {}

  /** The subjects rules may be about. */
  subjects() {
    return this.registry.all().map((target) => ({
      subject: target.subject,
      path: target.path,
      fields: [...target.fields],
      settable: Object.keys(target.settable),
      tags: target.tags,
    }));
  }

  async page(query: ListQuery) {
    const where = AUTOMATION_RULE_LIST.where(query);
    const [rows, total] = await Promise.all([
      this.db
        .select()
        .from(automationRules)
        .where(and(where, afterCursor(automationRules.id, query)))
        .orderBy(...pageOrder(automationRules.id, query))
        .limit(query.limit + 1),
      countPage(this.db, automationRules, where, query),
    ]);
    const page = toPage(rows, query, total);
    return { ...page, items: page.items.map(view) };
  }

  private async find(id: string) {
    const [rule] = await this.db
      .select()
      .from(automationRules)
      .where(eq(automationRules.id, id));
    if (!rule) {
      throw new NotFoundException(`Automation rule ${id} not found.`);
    }
    return rule;
  }

  async get(id: string) {
    return view(await this.find(id));
  }

  async runs(id: string, query: ListQuery) {
    await this.find(id);
    const where = and(
      eq(automationRuns.ruleId, id),
      AUTOMATION_RUN_LIST.where(query),
    );
    const rows = await this.db
      .select()
      .from(automationRuns)
      .where(and(where, afterCursor(automationRuns.id, query)))
      .orderBy(...pageOrder(automationRuns.id, query))
      .limit(query.limit + 1);
    const page = toPage(rows, query, undefined);
    return { ...page, items: page.items.map(runView) };
  }

  /** A draft rule: checked as its author would run it, but not run until activated. */
  async create(user: Principal, dto: CreateAutomationRuleDto, ip?: string) {
    await this.check(user, dto);
    const rule = await inTransaction(this.txHost, async (tx) => {
      const [row] = await tx
        .insert(automationRules)
        .values({
          name: dto.name,
          subject: dto.subject,
          trigger: dto.trigger,
          field: dto.field,
          filters: dto.filters,
          actions: dto.actions,
        })
        .returning();
      await this.audit.record(
        user,
        {
          action: 'automation-rule.created',
          targetType: 'automationRule',
          targetId: row!.id,
          details: { name: dto.name, subject: dto.subject },
          ip,
        },
        tx,
      );
      return row!;
    });
    return view(rule);
  }

  /**
   * Only what is sent changes. A change of the trigger, the conditions or
   * the actions is a new version, and an active rule becomes a draft
   * again: it takes effect once activated (and so simulated) again.
   */
  async update(
    user: Principal,
    id: string,
    dto: UpdateAutomationRuleDto,
    ip?: string,
  ) {
    const current = await this.find(id);
    const definition: Definition = {
      subject: current.subject,
      trigger: dto.trigger ?? current.trigger,
      field: dto.field === undefined ? current.field : dto.field,
      filters: dto.filters ?? current.filters,
      actions: dto.actions ?? current.actions,
    };
    const changed = (['trigger', 'field', 'filters', 'actions'] as const).some(
      (key) => !isDeepStrictEqual(definition[key], current[key]),
    );
    if (changed) {
      await this.check(user, definition);
    }
    const rule = await inTransaction(this.txHost, async (tx) => {
      const [row] = await tx
        .update(automationRules)
        .set({
          ...(dto.name !== undefined && { name: dto.name }),
          ...(changed && {
            ...definition,
            version: current.version + 1,
            ...(current.status === 'active' && { status: 'draft' as const }),
          }),
        })
        .where(eq(automationRules.id, id))
        .returning();
      await this.audit.record(
        user,
        {
          action: 'automation-rule.updated',
          targetType: 'automationRule',
          targetId: id,
          details: {
            version: row!.version,
            changed: Object.keys(dto),
            from: current.status,
            to: row!.status,
          },
          ip,
        },
        tx,
      );
      return row!;
    });
    return view(rule);
  }

  async remove(user: Principal, id: string, ip?: string) {
    const rule = await this.find(id);
    await inTransaction(this.txHost, async (tx) => {
      await tx.delete(automationRules).where(eq(automationRules.id, id));
      await this.audit.record(
        user,
        {
          action: 'automation-rule.deleted',
          targetType: 'automationRule',
          targetId: id,
          details: { name: rule.name, version: rule.version },
          ip,
        },
        tx,
      );
    });
  }

  /**
   * The rule runs from now on, as `user` (its owner): checked again as
   * them. At most MAX_ACTIVE_RULES active rules in the tenant.
   */
  async activate(user: Principal, id: string, ip?: string) {
    const current = await this.find(id);
    if (current.status === 'active') {
      throw new ConflictException({
        code: 'automation_active',
        message: 'The rule is active already.',
      });
    }
    await this.check(user, current);
    const [row] = await this.db
      .select({ active: count() })
      .from(automationRules)
      .where(eq(automationRules.status, 'active'));
    if ((row?.active ?? 0) >= MAX_ACTIVE_RULES) {
      throw invalid([
        {
          path: 'status',
          message: `At most ${MAX_ACTIVE_RULES} active automation rules: disable one first.`,
        },
      ]);
    }
    const rule = await inTransaction(this.txHost, async (tx) => {
      const [updated] = await tx
        .update(automationRules)
        .set({
          status: 'active',
          owner: principalKey(user),
          activatedAt: new Date(),
          disabledReason: null,
          failures: 0,
        })
        .where(eq(automationRules.id, id))
        .returning();
      await this.audit.record(
        user,
        {
          action: 'automation-rule.activated',
          targetType: 'automationRule',
          targetId: id,
          details: { version: updated!.version },
          ip,
        },
        tx,
      );
      return updated!;
    });
    return view(rule);
  }

  /** Stops the rule (`manual`); runs already queued find it disabled and do nothing. */
  async disable(user: Principal, id: string, ip?: string) {
    const current = await this.find(id);
    if (current.status === 'disabled') {
      return view(current);
    }
    const rule = await inTransaction(this.txHost, async (tx) => {
      const updated = await this.setDisabled(tx, current, 'manual', user, ip);
      return updated;
    });
    return view(rule);
  }

  private async setDisabled(
    tx: Transaction,
    rule: AutomationRuleRow,
    reason: string,
    by: Principal,
    ip?: string,
  ) {
    const [updated] = await tx
      .update(automationRules)
      .set({ status: 'disabled', disabledReason: reason })
      .where(eq(automationRules.id, rule.id))
      .returning();
    await this.audit.record(
      by,
      {
        action: 'automation-rule.disabled',
        targetType: 'automationRule',
        targetId: rule.id,
        details: { reason, version: rule.version },
        ip,
      },
      tx,
    );
    return updated!;
  }

  /**
   * What the rule would do now, without doing any of it: its conditions
   * matched against the most recently changed records the caller may read
   * (or the ones named), at most `limit`, and each action checked as the
   * caller (who would own the rule once they activate it). The same
   * evaluator a run uses (`evaluate()`, `plan()`), without `apply`: no
   * write, no notification, no webhook.
   */
  async simulate(
    user: Principal,
    dto: SimulateAutomationRuleDto,
  ): Promise<AutomationSimulation> {
    const { target, query } = await this.check(user, dto);
    const rows = await this.evaluate(target, user, query, {
      ids: dto.recordIds,
      limit: dto.limit,
    });
    const matches = [];
    for (const row of rows) {
      const planned = await this.plan(target, user, dto, row);
      const shown = await this.access.redact(
        user,
        'read',
        target.subject,
        target.view(row),
      );
      matches.push({
        recordId: row.id,
        title: target.title(shown as AutomationRecord) || null,
        actions: planned.map((p) => p.result),
      });
    }
    return {
      subject: target.subject,
      limit: dto.limit,
      matched: rows.length,
      truncated: !dto.recordIds && rows.length >= dto.limit,
      triggerSimulated: !(dto.trigger === 'updated' && dto.field),
      matches,
    };
  }

  /**
   * A record of `subject` was written (in `tx`): queues a run of each
   * active rule its change triggers. Nothing while a rule's own actions
   * write (AUTOMATING): no rule triggers itself or another.
   */
  async changed(
    tx: Transaction,
    {
      subject,
      event,
      before,
      after,
    }: {
      subject: string;
      event: 'created' | 'updated';
      before?: Record<string, unknown>;
      after: AutomationRecord;
    },
  ) {
    if (AUTOMATING.getStore() || !this.registry.find(subject)) {
      return;
    }
    const rules = await tx
      .select({
        id: automationRules.id,
        version: automationRules.version,
        field: automationRules.field,
      })
      .from(automationRules)
      .where(
        and(
          eq(automationRules.subject, subject),
          eq(automationRules.status, 'active'),
          eq(automationRules.trigger, event),
        ),
      )
      .limit(MAX_ACTIVE_RULES);
    const due = rules.filter(
      (rule) =>
        event === 'created' ||
        !rule.field ||
        !isDeepStrictEqual(before?.[rule.field], after[rule.field]),
    );
    if (!due.length) {
      return;
    }
    const tenantId = currentTenantId()!;
    await this.outbox.add(
      tx,
      due.map((rule) => ({
        topic: AUTOMATIONS_TOPIC,
        key: null,
        payload: {
          tenantId,
          ruleId: rule.id,
          version: rule.version,
          recordId: after.id,
        } satisfies AutomationMessage,
      })),
    );
  }

  /**
   * One rule's run on one record (the outbox handler, as `system`): the
   * rule as it is now (a disabled one, or one changed since, does
   * nothing), its owner as they are now (gone: the rule is disabled), the
   * hourly limit, then the evaluator as the owner, and every action, in
   * one transaction with the run's record and the consumer's inbox: done
   * once, or not at all. A refusal (a permission, a field) is a failed
   * run, kept; MAX_FAILURES in a row disable the rule. Anything else (the
   * database away) is retried by the outbox.
   */
  async execute(
    message: AutomationMessage,
    ctx: OutboxHandlerContext<Transaction>,
    system: SystemPrincipal,
  ) {
    const [rule] = await this.db
      .select()
      .from(automationRules)
      .where(eq(automationRules.id, message.ruleId));
    if (!rule || rule.status !== 'active' || rule.version !== message.version) {
      return;
    }
    const disable = (reason: string) =>
      inTransaction(
        this.txHost,
        async (tx) =>
          await ctx.processInTransaction(tx, () =>
            this.setDisabled(tx, rule, reason, system),
          ),
      );
    const target = this.registry.find(rule.subject);
    if (!target) {
      return disable('subject_gone');
    }
    const owner = await this.owner(rule);
    if (!owner) {
      return disable('owner_inactive');
    }
    const [recent] = await this.db
      .select({ runs: count() })
      .from(automationRuns)
      .where(
        and(
          eq(automationRuns.ruleId, rule.id),
          gt(automationRuns.createdAt, new Date(Date.now() - 3_600_000)),
        ),
      );
    if ((recent?.runs ?? 0) >= MAX_RUNS_PER_HOUR) {
      return disable('run_limit');
    }
    let planned: Planned[] = [];
    try {
      await inTransaction(
        this.txHost,
        async (tx) =>
          await ctx.processInTransaction(tx, async () => {
            const { query } = await this.check(owner, rule);
            const [row] = await this.evaluate(target, owner, query, {
              ids: [message.recordId],
              limit: 1,
            });
            if (!row) {
              return; // it doesn't match (or is gone, or hidden from the owner)
            }
            planned = await this.plan(target, owner, rule, row);
            const refused = planned.find((p) => !p.result.allowed);
            if (refused) {
              throw new AutomationRefused(
                `${refused.result.type}: ${refused.result.reason}`,
              );
            }
            await AUTOMATING.run(true, async () => {
              for (const { apply } of planned) {
                await apply!(tx);
              }
            });
            await this.recordRun(tx, rule, message.recordId, planned, null);
          }),
      );
    } catch (error) {
      if (!(
        error instanceof AutomationRefused || error instanceof HttpException
      )) {
        throw error; // retried by the outbox, then a dead letter
      }
      const reason = error.message;
      this.logger.warn('An automation rule failed', {
        rule: rule.id,
        record: message.recordId,
        error: reason,
      });
      await inTransaction(
        this.txHost,
        async (tx) =>
          await ctx.processInTransaction(tx, async () => {
            const failures = await this.recordRun(
              tx,
              rule,
              message.recordId,
              planned,
              reason,
            );
            if (failures >= MAX_FAILURES) {
              await this.setDisabled(tx, rule, 'failing', system);
            }
          }),
      );
    }
  }

  /** Keeps the run, and the rule's last run; returns its failures in a row. */
  private async recordRun(
    tx: Transaction,
    rule: AutomationRuleRow,
    recordId: string,
    planned: Planned[],
    error: string | null,
  ) {
    const status = error ? 'failed' : 'succeeded';
    await tx.insert(automationRuns).values({
      ruleId: rule.id,
      ruleVersion: rule.version,
      recordId,
      status,
      actions: planned.map((p) => p.result),
      error,
    });
    const failures = error ? rule.failures + 1 : 0;
    await tx
      .update(automationRules)
      .set({ lastRunAt: new Date(), lastStatus: status, failures })
      .where(eq(automationRules.id, rule.id));
    return failures;
  }

  /** The rule's owner as they are now, in its tenant; null when no longer an active member. */
  private async owner(rule: AutomationRuleRow) {
    const [kind, id] = (rule.owner ?? '').split(':') as [string, string];
    if (kind !== 'user') {
      return null;
    }
    const user = await this.users.inTenant(id, rule.tenantId);
    return user?.tenantId === rule.tenantId ? user : null;
  }

  /**
   * The rule's definition checked as `principal` would run it: a subject
   * that takes automations, a watched field it has, conditions its list
   * takes and that use no field hidden from them (403 `field_forbidden`),
   * actions it supports with values its fields take. Returns the target
   * and the parsed conditions.
   */
  private async check(principal: Principal, definition: Definition) {
    const target = this.registry.find(definition.subject);
    if (!target) {
      throw invalid([
        {
          path: 'subject',
          message: `No subject "${definition.subject}" takes automation rules (GET /v1/automation-rules/subjects).`,
        },
      ]);
    }
    if (definition.field) {
      if (definition.trigger !== 'updated') {
        throw invalid([
          { path: 'field', message: 'A field is watched only on `updated`.' },
        ]);
      }
      if (!target.fields.includes(definition.field)) {
        throw invalid([
          {
            path: 'field',
            message: `${target.subject} has no field "${definition.field}".`,
          },
        ]);
      }
    }
    const page = Object.keys(definition.filters).filter((key) =>
      PAGE_KEYS.includes(key),
    );
    if (page.length) {
      throw invalid(
        page.map((key) => ({
          path: `filters.${key}`,
          message: 'Conditions are filters: no paging, sorting or fields.',
        })),
      );
    }
    let query: ListQuery;
    try {
      query = target.list.parse(definition.filters);
    } catch (error) {
      if (error instanceof BadRequestException) {
        const body = error.getResponse() as {
          errors?: { path: string; message: string }[];
        };
        throw invalid(
          (body.errors ?? []).map((e) => ({
            path: `filters.${e.path}`,
            message: e.message,
          })),
        );
      }
      throw error;
    }
    await this.access.assertQueryFields(principal, target.subject, query);
    const errors: { path: string; message: string }[] = [];
    for (const [index, action] of definition.actions.entries()) {
      const path = `actions.${index}`;
      if (action.type === 'setField') {
        const schema = target.settable[action.field];
        if (!schema) {
          errors.push({
            path: `${path}.field`,
            message: `${target.subject}.${action.field} cannot be set by a rule.`,
          });
        } else if (!schema.safeParse(action.value).success) {
          errors.push({
            path: `${path}.value`,
            message: `Not a value of ${action.field}.`,
          });
        }
      } else if (action.type === 'addTag') {
        if (!target.tags) {
          errors.push({
            path,
            message: `${target.subject} records take no tags.`,
          });
        } else if (!(await this.tag(target.subject, action.tagId))) {
          errors.push({
            path: `${path}.tagId`,
            message: `No ${target.subject} tag ${action.tagId}.`,
          });
        }
      } else if (action.type === 'webhook') {
        if (!(await this.client(action.clientId))) {
          errors.push({
            path: `${path}.clientId`,
            message: `No active API client ${action.clientId}.`,
          });
        }
      }
    }
    if (errors.length) {
      throw invalid(errors);
    }
    return { target, query };
  }

  /**
   * The evaluator: the records matching the conditions, among those
   * `principal` may read (in SQL: the conditions are the subject's list
   * filters), the most recently changed first, at most `limit`; with
   * `ids`, only those.
   */
  private async evaluate(
    target: AutomationTarget,
    principal: Principal,
    query: ListQuery,
    { ids, limit }: { ids?: readonly string[]; limit: number },
  ): Promise<AutomationRecord[]> {
    const where: SQL | undefined = and(
      await this.access.sqlFilter(principal, target.subject, 'read'),
      target.list.where(query),
      ids ? inArray(target.columns.id, [...ids]) : undefined,
    );
    return (await this.db
      .select()
      .from(target.table)
      .where(where)
      .orderBy(desc(target.columns.updatedAt), desc(target.columns.id))
      .limit(limit)) as AutomationRecord[];
  }

  /**
   * Each action checked as `principal` on the record: what it would do,
   * whether they may, and (allowed) how it is done. A run applies them;
   * a simulation shows them.
   */
  private async plan(
    target: AutomationTarget,
    principal: Principal,
    rule: { name?: string; actions: readonly AutomationAction[] },
    row: AutomationRecord,
  ): Promise<Planned[]> {
    const planned: Planned[] = [];
    for (const action of rule.actions) {
      planned.push(
        await this.planOne(target, principal, action, row, rule.name ?? ''),
      );
    }
    return planned;
  }

  private async planOne(
    target: AutomationTarget,
    principal: Principal,
    action: AutomationAction,
    row: AutomationRecord,
    name: string,
  ): Promise<Planned> {
    const subject = target.subject;
    const refused = (reason: string, detail: string): Planned => ({
      result: { type: action.type, allowed: false, reason, detail },
    });
    switch (action.type) {
      case 'setField': {
        const detail = `${action.field} = ${JSON.stringify(action.value)}`;
        const dto = { [action.field]: action.value };
        if (!(await this.access.can(principal, 'update', subject, row))) {
          return refused('forbidden', detail);
        }
        const forbidden = await this.access.forbiddenFields(
          principal,
          'update',
          subject,
          dto,
          row,
        );
        if (forbidden.length || !target.settable[action.field]) {
          return refused(NOT_SETTABLE, detail);
        }
        return {
          result: { type: action.type, allowed: true, reason: null, detail },
          apply: () => target.update(principal, row, dto),
        };
      }
      case 'addTag': {
        const tag = await this.tag(subject, action.tagId);
        if (!tag) {
          return refused('unknown_tag', action.tagId);
        }
        const detail = tag.name;
        if (!(await this.access.can(principal, 'update', subject, row))) {
          return refused('forbidden', detail);
        }
        return {
          result: { type: action.type, allowed: true, reason: null, detail },
          apply: async () => {
            const record = { subject, recordId: row.id };
            const current = (
              await this.tagsService.tagsOf(subject, [row.id])
            ).get(row.id)!;
            if (current.some((t) => t.id === tag.id)) return;
            await this.tagsService.setTags(principal, record, [
              ...current.map((t) => t.id),
              tag.id,
            ]);
          },
        };
      }
      case 'notify': {
        const recipients: string[] = [];
        for (const id of action.userIds) {
          const user = await this.users.inTenant(id, currentTenantId());
          if (user && (await this.access.can(user, 'read', subject, row))) {
            recipients.push(principalKey(user));
          }
        }
        const detail = `${recipients.length} of ${action.userIds.length}`;
        if (!recipients.length) {
          return refused('no_recipient', detail);
        }
        return {
          result: { type: action.type, allowed: true, reason: null, detail },
          apply: async (tx) => {
            await this.notifications.notify(tx, {
              type: 'automation.notified',
              to: recipients,
              data: {
                rule: name,
                subject,
                recordId: row.id,
                title: target.title(row),
              },
              link: `/${target.path}/${row.id}`,
            });
          },
        };
      }
      case 'webhook': {
        const client = await this.client(action.clientId);
        const detail = client?.name ?? action.clientId;
        const receiver = client && {
          kind: 'client' as const,
          id: client.id,
          name: client.name,
          tenantId: client.tenantId,
        };
        if (
          !receiver ||
          !(await this.access.can(receiver, 'read', subject, row))
        ) {
          return refused('client_cannot_read', detail);
        }
        return {
          result: { type: action.type, allowed: true, reason: null, detail },
          apply: async (tx) => {
            const data = await this.access.redact(
              receiver,
              'read',
              subject,
              target.view(row),
            );
            await this.webhooks.dispatch(tx, {
              type: AUTOMATION_WEBHOOK_EVENT,
              tenant: receiver.id,
              // Never an encrypted column's value, even as ciphertext.
              data: { subject, record: withoutEncrypted(data) },
            });
          },
        };
      }
    }
  }

  private async tag(subject: string, id: string) {
    const [tag] = await this.db
      .select({ id: tags.id, name: tags.name })
      .from(tags)
      .where(and(eq(tags.id, id), eq(tags.subject, subject)));
    return tag;
  }

  /** An active API client of the tenant (row-level security: another tenant's is none). */
  private async client(id: string) {
    const [client] = await this.db
      .select({
        id: apiClients.id,
        name: apiClients.name,
        tenantId: apiClients.tenantId,
      })
      .from(apiClients)
      .where(and(eq(apiClients.id, id), eq(apiClients.active, true)));
    return client;
  }
}
