import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { I18nService } from '@nestjs/i18n';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';
import { validationException } from '../../core/http/problem-details.filter.js';
import { PLATFORM_OPTIONS, type PlatformOptions } from '../platform.options.js';
import {
  ALL_MODE,
  ANY_MODE,
  PAYLOAD_CONDITION,
  QUORUM_MODE,
} from './approval-modes.js';
import {
  type ApprovalPolicy,
  policySchema,
  type Typed,
  typedSchema,
} from './approval-policy.js';
import {
  type ApprovalCondition,
  type ApprovalContext,
  type ApprovalDeclaration,
  type ApprovalHandler,
  type ApprovalHook,
  type ApprovalLifecycleEvent,
  type ApprovalListener,
  approvalKey,
  type ApproverRule,
  type StageMode,
} from './approval.types.js';
import type { Transaction } from '../../core/database/drizzle.js';

type Issue = { path: (string | number)[]; message: string };

/** Conditions made of others: `all` and `any` of a list, `not` of one. */
const COMBINATORS = {
  all: z.object({ conditions: z.array(typedSchema).min(1).max(20) }).strict(),
  any: z.object({ conditions: z.array(typedSchema).min(1).max(20) }).strict(),
  not: z.object({ condition: typedSchema }).strict(),
};

/**
 * Everything approvals are made of, by name: the approvable actions (from
 * `PlatformModule.forRoot({ approvals })`) and their handlers, approver
 * rules, stage modes, conditions and lifecycle listeners. The built-in
 * ones register here exactly as a project's own do, from a provider's
 * constructor (`registry.addRule(this)`), so a project extends approvals
 * without touching this module. Registrations are code, the same in every
 * process: nothing here is runtime state.
 */
@Injectable()
export class ApprovalsRegistry implements OnApplicationBootstrap {
  private readonly logger = new Logger('Approvals');
  private readonly declarations = new Map<string, ApprovalDeclaration>();
  private readonly handlers = new Map<string, ApprovalHandler>();
  private readonly rules = new Map<string, ApproverRule>();
  private readonly modes = new Map<string, StageMode>();
  private readonly conditions = new Map<string, ApprovalCondition>();
  private readonly listeners: ApprovalListener[] = [];

  constructor(
    @Inject(PLATFORM_OPTIONS) options: PlatformOptions,
    private readonly i18n: I18nService,
  ) {
    for (const declaration of options.approvals ?? []) {
      const key = approvalKey(declaration);
      if (this.declarations.has(key)) {
        throw new Error(`Approvals: "${key}" is declared twice.`);
      }
      this.declarations.set(key, declaration);
    }
    this.addMode(ANY_MODE);
    this.addMode(ALL_MODE);
    this.addMode(QUORUM_MODE);
    this.addCondition(PAYLOAD_CONDITION);
  }

  /** Every declared action's default policy must be valid, and each action needs its handler. */
  onApplicationBootstrap() {
    for (const [key, declaration] of this.declarations) {
      if (!this.handlers.has(key)) {
        throw new Error(
          `Approvals: "${key}" has no handler: a provider implementing ApprovalHandler must call registry.handle(this).`,
        );
      }
      // A setting its requesters could set for themselves would let them skip approval.
      if ((declaration.setting?.scopes ?? ['global']).includes('user')) {
        throw new Error(
          `Approvals: the setting of "${key}" (${declaration.setting!.key}) can be set per user: a requester could switch approval off for themselves. Declare it with scopes ['global'] or ['global', 'orgUnit'].`,
        );
      }
      const issues = this.policyIssues(declaration.policy);
      if (issues.length) {
        throw new Error(
          `Approvals: the default policy of "${key}" is invalid: ${issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; ')}`,
        );
      }
    }
    this.logger.log(
      `Actions: ${[...this.declarations.keys()].join(', ') || 'none'}; rules: ${[...this.rules.keys()].join(', ')}`,
    );
  }

  addRule(rule: ApproverRule) {
    this.add(this.rules, rule, 'approver rule');
  }

  addMode(mode: StageMode) {
    this.add(this.modes, mode, 'stage mode');
  }

  addCondition(condition: ApprovalCondition) {
    if (condition.type in COMBINATORS) {
      throw new Error(
        `Approvals: "${condition.type}" is a built-in condition.`,
      );
    }
    this.add(this.conditions, condition, 'condition');
  }

  /** The feature's handler of a declared action. */
  handle(handler: ApprovalHandler) {
    const key = approvalKey(handler.approval);
    if (!this.declarations.has(key)) {
      throw new Error(
        `Approvals: "${key}" has a handler but no declaration: add it to PlatformModule.forRoot({ approvals }).`,
      );
    }
    if (this.handlers.has(key)) {
      throw new Error(`Approvals: "${key}" has two handlers.`);
    }
    this.handlers.set(key, handler);
  }

  listen(listener: ApprovalListener) {
    this.listeners.push(listener);
  }

  private add<T extends { type: string }>(
    map: Map<string, T>,
    item: T,
    kind: string,
  ) {
    if (map.has(item.type)) {
      throw new Error(`Approvals: two ${kind}s are named "${item.type}".`);
    }
    map.set(item.type, item);
  }

  /** The declared actions. */
  actions() {
    return [...this.declarations.entries()].map(([key, declaration]) => ({
      key,
      declaration,
    }));
  }

  /** A declared action, or undefined. */
  declaration(key: string) {
    return this.declarations.get(key);
  }

  /** A declared action, or an error (a programming mistake: an undeclared action). */
  action(key: string) {
    const declaration = this.declarations.get(key);
    const handler = this.handlers.get(key);
    if (!declaration || !handler) {
      throw new Error(
        `Approvals: "${key}" is not an approvable action: declare it (defineApproval) and register its handler.`,
      );
    }
    return { declaration, handler };
  }

  /** The registered types, for GET /approvals/policy-types (an editor of policies). */
  types() {
    const view = (item: {
      type: string;
      label: string;
      schema: z.ZodType;
    }) => ({
      type: item.type,
      label: item.label,
      params: z.toJSONSchema(item.schema, { unrepresentable: 'any' }),
    });
    return {
      approverRules: [...this.rules.values()].map(view),
      modes: [...this.modes.values()].map(view),
      conditions: [
        ...Object.entries(COMBINATORS).map(([type, schema]) =>
          view({ type, label: `${type} of conditions`, schema }),
        ),
        ...[...this.conditions.values()].map(view),
      ],
    };
  }

  /**
   * A policy, checked against the registered types: each rule, mode and
   * condition must exist and its parameters pass its schema. Returns it
   * with defaults filled in; a 400 `validation_failed` naming each wrong
   * path otherwise (`stages.0.approvers.1.role`).
   */
  parsePolicy(input: unknown): ApprovalPolicy {
    const issues = this.policyIssues(input);
    if (issues.length) {
      throw validationException(
        issues.map((issue): StandardSchemaV1.Issue => ({
          path: issue.path,
          message: issue.message,
        })),
      );
    }
    return this.normalize(policySchema.parse(input));
  }

  private policyIssues(input: unknown): Issue[] {
    const parsed = policySchema.safeParse(input);
    if (!parsed.success) {
      return parsed.error.issues.map((issue) => ({
        path: issue.path as (string | number)[],
        message: issue.message,
      }));
    }
    const issues: Issue[] = [];
    const policy = parsed.data;
    policy.stages.forEach((stage, index) => {
      const at = ['stages', index];
      stage.approvers.forEach((rule, i) =>
        this.checkTyped(this.rules, rule, [...at, 'approvers', i], issues),
      );
      (stage.escalateTo ?? []).forEach((rule, i) =>
        this.checkTyped(this.rules, rule, [...at, 'escalateTo', i], issues),
      );
      this.checkTyped(this.modes, stage.mode, [...at, 'mode'], issues);
    });
    if (policy.when) {
      this.checkCondition(policy.when, ['when'], issues, 0);
    }
    return issues;
  }

  private checkTyped(
    map: Map<string, { schema: z.ZodType }>,
    entry: Typed,
    path: (string | number)[],
    issues: Issue[],
  ) {
    const item = map.get(entry.type);
    if (!item) {
      issues.push({
        path: [...path, 'type'],
        message: this.i18n.translate('approvals.unknownType', {
          args: { type: entry.type, known: [...map.keys()].join(', ') },
        }),
      });
      return;
    }
    const { type: _type, ...params } = entry;
    const result = item.schema.safeParse(params);
    if (!result.success) {
      for (const issue of result.error.issues) {
        issues.push({
          path: [...path, ...(issue.path as (string | number)[])],
          message: issue.message,
        });
      }
    }
  }

  private checkCondition(
    entry: Typed,
    path: (string | number)[],
    issues: Issue[],
    depth: number,
  ) {
    if (depth > 5) {
      issues.push({ path, message: 'conditions nest 5 deep at most' });
      return;
    }
    if (entry.type === 'all' || entry.type === 'any' || entry.type === 'not') {
      const { type: _type, ...params } = entry;
      const result = COMBINATORS[entry.type].safeParse(params);
      if (!result.success) {
        for (const issue of result.error.issues) {
          issues.push({
            path: [...path, ...(issue.path as (string | number)[])],
            message: issue.message,
          });
        }
        return;
      }
      const children =
        'conditions' in result.data
          ? result.data.conditions.map((child, i) => ({
              child,
              at: [...path, 'conditions', i],
            }))
          : [{ child: result.data.condition, at: [...path, 'condition'] }];
      for (const { child, at } of children) {
        this.checkCondition(child, at, issues, depth + 1);
      }
      return;
    }
    this.checkTyped(this.conditions, entry, path, issues);
  }

  /** Each typed entry with its parameters as its schema returns them (defaults filled in). */
  private normalize(policy: ApprovalPolicy): ApprovalPolicy {
    const typed = (map: Map<string, { schema: z.ZodType }>, entry: Typed) => {
      const { type, ...params } = entry;
      return {
        type,
        ...(map.get(type)!.schema.parse(params) as Record<string, unknown>),
      };
    };
    return {
      ...policy,
      stages: policy.stages.map((stage) => ({
        ...stage,
        approvers: stage.approvers.map((rule) => typed(this.rules, rule)),
        escalateTo: stage.escalateTo?.map((rule) => typed(this.rules, rule)),
        mode: typed(this.modes, stage.mode),
      })),
    };
  }

  /** The users a stage's rules name (before the requester and inactive users are left out). */
  async resolve(rules: readonly Typed[], context: ApprovalContext) {
    const ids = new Set<string>();
    for (const entry of rules) {
      const rule = this.rules.get(entry.type);
      if (!rule) {
        // A rule removed from the code since the policy was stored: it names nobody.
        this.logger.warn(`Unknown approver rule "${entry.type}": skipped.`);
        continue;
      }
      const { type: _type, ...params } = entry;
      for (const id of await rule.resolve({ ...context, params })) {
        ids.add(id);
      }
    }
    return [...ids];
  }

  /** A stage's outcome by its mode. */
  outcome(mode: Typed, votes: Parameters<StageMode['outcome']>[0]['votes']) {
    const found = this.modes.get(mode.type);
    if (!found) {
      throw new Error(`Approvals: unknown stage mode "${mode.type}".`);
    }
    const { type: _type, ...params } = mode;
    return found.outcome({ params, votes });
  }

  /** Whether a policy's `when` holds (no condition: it does). */
  async holds(
    entry: Typed | null | undefined,
    context: ApprovalContext,
  ): Promise<boolean> {
    if (!entry) {
      return true;
    }
    const { type, ...params } = entry;
    if (type === 'all' || type === 'any') {
      const children = (params.conditions ?? []) as Typed[];
      for (const child of children) {
        const result = await this.holds(child, context);
        if (type === 'all' && !result) {
          return false;
        }
        if (type === 'any' && result) {
          return true;
        }
      }
      return type === 'all';
    }
    if (type === 'not') {
      return !(await this.holds(params.condition as Typed, context));
    }
    const condition = this.conditions.get(type);
    if (!condition) {
      throw new Error(`Approvals: unknown condition "${type}".`);
    }
    return condition.evaluate({ ...context, params });
  }

  /** Tells the listeners, in the change's transaction. */
  async emit(
    hook: ApprovalHook,
    event: ApprovalLifecycleEvent,
    tx: Transaction,
  ) {
    for (const listener of this.listeners) {
      if (
        listener[hook] &&
        (!listener.subjects ||
          listener.subjects.includes(event.request.subject))
      ) {
        await listener[hook]!(event, tx);
      }
    }
  }
}
