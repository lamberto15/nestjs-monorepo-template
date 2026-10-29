import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import type { Principal } from '../../iam/auth/principal.js';
import type { ApprovalPolicyInput } from '../approvals/approval-policy.js';
import {
  type ApprovalDeclaration,
  defineApproval,
} from '../approvals/approval.types.js';
import { flag, type SettingDeclaration } from '../settings/setting.types.js';
import type { RecordDeclaration } from './record.js';
import { camelPath, wordsOf } from './record-settings.js';

/**
 * An action of a record that needs approval (`approvals` in
 * `<item>.record.ts`), one line each:
 *
 * ```ts
 * approvals: {
 *   publish: { label: 'Publish an invoice' },
 * },
 * ```
 *
 * The platform declares the approvable action (`Invoice.publish`: its
 * policy, the flag that switches it on, the handler that registers it) and
 * the route that asks for it, `POST /v1/invoices/{id}/publish`; the feature
 * writes only what happens once it is approved, in `<item>.approvals.ts`
 * (`recordApprovalEffects()`). While a request is open, the record's writes
 * wait (409 `approval_pending`). See [approvals](../../../../../docs/approvals.md).
 */
export interface RecordApproval {
  /** The action in the inbox and on the route: "Publish an invoice". */
  label: string;
  description?: string;
  /**
   * The default policy (administrators may store their own at runtime).
   * Default: one stage, "Review", decided by any user who may update the
   * record, but not the requester.
   */
  policy?: ApprovalPolicyInput;
  /**
   * `true` (the default): off until a flag, `<path>.<action>Approval`, is
   * switched on for the tenant or a unit (`/v1/settings`); the action then
   * runs at once. `false`: always needs approval.
   */
  flag?: boolean;
}

/** The actions a record may declare: a word, and none the record's own routes already use. */
export const APPROVAL_ACTION = /^[a-z][a-zA-Z0-9]*$/;
export const RESERVED_ACTIONS = [
  'restore',
  'tags',
  'comments',
  'attachments',
  'revisions',
  'pdf',
  'watch',
  'bulk',
  'shares',
  'merge',
  'duplicates',
];

/** `markPaid` → `mark-paid`: the action in the route's path. */
export const actionPath = (action: string) =>
  action.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

/** `markPaid` → `MarkPaid`. */
export const actionClass = (action: string) =>
  action[0]!.toUpperCase() + action.slice(1);

/** What a request carries: the record's name, read from the record itself (never sent). */
export const recordApprovalPayload = z.object({ title: z.string().max(200) });
export type RecordApprovalPayload = z.infer<typeof recordApprovalPayload>;

/** The flag that switches an action's approval on: `invoices.publishApproval`. */
export const approvalFlagKey = (
  declaration: RecordDeclaration,
  action: string,
) => `${camelPath(declaration.path)}.${action}Approval`;

const DEFAULT_POLICY: ApprovalPolicyInput = {
  stages: [
    {
      name: 'Review',
      approvers: [{ type: 'permission', action: 'update' }],
      mode: { type: 'any' },
    },
  ],
};

export interface DeclaredApproval {
  action: string;
  declaration: ApprovalDeclaration<RecordApprovalPayload>;
  /** The flag that switches it on, unless `flag: false`. */
  flag: SettingDeclaration<boolean> | null;
}

const BUILT = new WeakMap<RecordDeclaration, DeclaredApproval[]>();

/**
 * The approvable actions a record declares and their flags, built once per
 * declaration (`featureDeclarations` hands them to the platform).
 */
export function recordApprovalActions(
  declaration: RecordDeclaration,
): DeclaredApproval[] {
  let built = BUILT.get(declaration);
  if (!built) {
    built = Object.entries(declaration.approvals ?? {}).map(
      ([action, approval]) => {
        const switchable =
          approval.flag === false
            ? null
            : flag({
                // Never per user: a requester could switch their own approval off
                // (ApprovalsRegistry refuses such a setting at startup).
                scopes: ['tenant', 'unit'],
                key: approvalFlagKey(declaration, action),
                label: `${wordsOf(action)} needs approval`,
                description: `When on, ${action} runs only once it is approved (GET /v1/approvals); the policy: GET /v1/approvals/policies/${declaration.subject}.${action}.`,
                default: false,
              });
        return {
          action,
          flag: switchable,
          declaration: defineApproval({
            subject: declaration.subject,
            action,
            label: approval.label,
            description: approval.description,
            payload: recordApprovalPayload,
            policy: approval.policy ?? DEFAULT_POLICY,
            ...(switchable && { setting: switchable }),
          }),
        };
      },
    );
    BUILT.set(declaration, built);
  }
  return built;
}

/** What a feature's effect is told when an action is applied. */
export interface RecordApprovalApplied<Service = unknown> {
  /** The record. */
  id: string;
  /**
   * Who applies it: the requester when no approval was needed, the
   * workflow's system principal (`system:approvals`) once approved: the
   * audit's actor, and the principal of any permission the effect checks.
   */
  actor: Principal;
  /** The feature's service. */
  service: Service;
}

/** What happens when an action is applied: the feature's business logic. */
export interface RecordApprovalEffect<Service = any> {
  /**
   * Runs at once when the action needs no approval, and as a workflow step
   * once it is approved: at least once, so make it idempotent (do nothing
   * when the effect is already there). Writes it makes through the service
   * don't wait for the record's open requests (applyEffect()), this action's
   * or a sibling's.
   */
  apply(applied: RecordApprovalApplied<Service>): Promise<void>;
}

const EFFECT = new AsyncLocalStorage<true>();

/** Whether the code running is a record's approval effect (`applyEffect()`). */
export const applyingEffect = () => EFFECT.getStore() === true;

/**
 * Runs an effect, at once or once approved. The writes it makes through the
 * feature's service don't wait for the record's open requests (a sibling
 * action's too: an approved action must not be stuck behind another's
 * pending request); an ordinary update or delete still waits for any
 * (RecordLifecycle).
 */
export const applyEffect = (
  effect: RecordApprovalEffect,
  applied: RecordApprovalApplied,
) => EFFECT.run(true, () => effect.apply(applied));

/** An effect for each action the record declares: a missing one fails the build. */
export type RecordApprovalEffects<D extends RecordDeclaration> = {
  [Action in keyof NonNullable<D['approvals']> & string]: RecordApprovalEffect;
};

/**
 * The effects of a record's approvable actions (`<item>.approvals.ts`),
 * handed to `recordParts(…, { approvals })`:
 *
 * ```ts
 * export const INVOICE_APPROVALS = recordApprovalEffects(INVOICE, {
 *   publish: {
 *     async apply({ id, actor, service }: RecordApprovalApplied<InvoicesService>) { … },
 *   },
 * });
 * ```
 */
export const recordApprovalEffects = <const D extends RecordDeclaration>(
  _declaration: D,
  effects: RecordApprovalEffects<D>,
) => effects;
