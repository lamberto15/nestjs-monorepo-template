import { z } from 'zod';

/**
 * Targeting rules of a feature flag: an ordered list, each rule a set of
 * conditions on the principal (and its tenant) and an outcome. The first
 * rule whose conditions all hold decides, before the scope's plain value
 * (docs/settings.md, "Targeting rules").
 *
 * A condition has the shape of a permission's (`PermissionCondition`,
 * docs/permissions.md): a `key` naming a template of the catalog below and
 * its `params`. The catalog is closed and evaluated in code, never an
 * expression language: nothing a stored rule says is executed.
 *
 * Fails closed: a condition that cannot be evaluated (an attribute the
 * principal does not have, a key this code does not know, params that do
 * not parse) does not hold, so its rule never matches and never switches
 * anything on. The API refuses such rules when they are written.
 */

export const MAX_RULES = 20;
export const MAX_CONDITIONS = 10;
export const MAX_VALUES = 50;

/** What a rule is evaluated against: the principal's and its tenant's attributes. */
export interface RuleAttributes {
  kind: 'user' | 'client';
  /** A user's email address, only when it is verified (an unverified one is no evidence of a domain). */
  email: string | null;
  /** A user's chosen language, or null. */
  locale: string | null;
  /** The ids of the roles held in the tenant (unexpired grants); undefined: not loaded. */
  roleIds?: ReadonlySet<string>;
  tenant: { slug: string; operator: boolean } | null;
}

const values = <T extends z.ZodType>(item: T) =>
  z.array(item).min(1).max(MAX_VALUES);

interface ConditionTemplate {
  /** At which scopes it may be used: roles are a tenant's own. */
  scopes: readonly ('tenant' | 'platform')[];
  params: z.ZodType<Record<string, unknown>>;
  /** Whether the condition holds; reads only the attributes it names. */
  holds: (params: any, attributes: RuleAttributes) => boolean;
}

const lower = (text: string) => text.toLowerCase();

export const RULE_CONDITIONS = {
  /** `{ kinds: ['client'] }`: API clients only. */
  principalKind: {
    scopes: ['tenant', 'platform'],
    params: z.object({ kinds: values(z.enum(['user', 'client'])) }).strict(),
    holds: (params: { kinds: string[] }, a) => params.kinds.includes(a.kind),
  },
  /** `{ roleIds: [...] }`: holds any of these roles of the tenant. */
  role: {
    scopes: ['tenant'],
    params: z.object({ roleIds: values(z.uuid()) }).strict(),
    holds: (params: { roleIds: string[] }, a) =>
      !!a.roleIds && params.roleIds.some((id) => a.roleIds!.has(id)),
  },
  /** `{ domains: ['acme.com'] }`: a user whose verified email is at exactly that domain (no subdomains). */
  emailDomain: {
    scopes: ['tenant', 'platform'],
    params: z
      .object({
        domains: values(
          z
            .string()
            .max(253)
            .regex(
              /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i,
              'a domain: example.com',
            )
            .transform(lower),
        ),
      })
      .strict(),
    holds: (params: { domains: string[] }, a) => {
      const at = a.email?.lastIndexOf('@') ?? -1;
      return (
        a.kind === 'user' &&
        at > 0 &&
        params.domains.includes(lower(a.email!.slice(at + 1)))
      );
    },
  },
  /** `{ locales: ['en', 'pt-BR'] }`: the user's language (`en` also covers `en-GB`). */
  locale: {
    scopes: ['tenant', 'platform'],
    params: z
      .object({
        locales: values(
          z
            .string()
            .max(35)
            .regex(
              /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i,
              'a language tag: en, pt-BR',
            )
            .transform(lower),
        ),
      })
      .strict(),
    holds: (params: { locales: string[] }, a) => {
      const locale = a.locale ? lower(a.locale) : null;
      return (
        locale !== null &&
        params.locales.some((l) => locale === l || locale.startsWith(`${l}-`))
      );
    },
  },
  /** `{ slugs: ['acme'] }`: the principal acts in one of these tenants. */
  tenantSlug: {
    scopes: ['tenant', 'platform'],
    params: z
      .object({ slugs: values(z.string().min(1).max(100).transform(lower)) })
      .strict(),
    holds: (params: { slugs: string[] }, a) =>
      !!a.tenant && params.slugs.includes(lower(a.tenant.slug)),
  },
  /** `{ operator: true }`: the tenant is (or, false, is not) the deployment's operator tenant. */
  tenantOperator: {
    scopes: ['tenant', 'platform'],
    params: z.object({ operator: z.boolean() }).strict(),
    holds: (params: { operator: boolean }, a) =>
      !!a.tenant && a.tenant.operator === params.operator,
  },
} satisfies Record<string, ConditionTemplate>;

export type RuleConditionKey = keyof typeof RULE_CONDITIONS;
const TEMPLATES: Record<RuleConditionKey, ConditionTemplate> = RULE_CONDITIONS;
export const RULE_CONDITION_KEYS = Object.keys(
  RULE_CONDITIONS,
) as RuleConditionKey[];

export interface RuleCondition {
  key: string;
  params: Record<string, unknown>;
}

/** What a matching rule decides: on or off, or on for a stable share of the matched group. */
export type RuleOutcome = { value: boolean } | { rollout: number };

export interface FlagRule {
  conditions: RuleCondition[];
  outcome: RuleOutcome;
}

/** The rules as the API takes them (the conditions' params parsed and normalised by their template). */
export const flagRuleSchema = z
  .object({
    conditions: z
      .array(
        z
          .object({
            key: z.enum(RULE_CONDITION_KEYS as [string, ...string[]]),
            params: z.record(z.string(), z.unknown()),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_CONDITIONS)
      .describe('All must hold (and). Keys: ' + RULE_CONDITION_KEYS.join(', ')),
    outcome: z.union([
      z.object({ value: z.boolean() }).strict(),
      z.object({ rollout: z.int().min(0).max(100) }).strict(),
    ]),
  })
  .strict();

export const flagRulesSchema = z.array(flagRuleSchema).max(MAX_RULES);

/**
 * The rules checked for a scope: each condition's params against its
 * template (and normalised, domains in lower case), and its template
 * allowed at that scope. Issues carry a `path` under `rules`.
 */
export function parseRules(
  input: unknown,
  scope: 'tenant' | 'platform',
):
  | { ok: true; rules: FlagRule[] }
  | { ok: false; issues: { path: string; message: string }[] } {
  const shape = flagRulesSchema.safeParse(input);
  if (!shape.success) {
    return {
      ok: false,
      issues: shape.error.issues.map((issue) => ({
        path: ['rules', ...issue.path].join('.'),
        message: issue.message,
      })),
    };
  }
  const issues: { path: string; message: string }[] = [];
  const rules = shape.data.map((rule, r) => ({
    outcome: rule.outcome,
    conditions: rule.conditions.map((condition, c) => {
      const template = TEMPLATES[condition.key as RuleConditionKey];
      const at = `rules.${r}.conditions.${c}`;
      if (!template.scopes.includes(scope)) {
        issues.push({
          path: `${at}.key`,
          message: `"${condition.key}" is not available at the ${scope} scope.`,
        });
        return condition;
      }
      const parsed = template.params.safeParse(condition.params);
      if (!parsed.success) {
        issues.push(
          ...parsed.error.issues.map((issue) => ({
            path: [`${at}.params`, ...issue.path].join('.'),
            message: issue.message,
          })),
        );
        return condition;
      }
      return { key: condition.key, params: parsed.data };
    }),
  }));
  return issues.length ? { ok: false, issues } : { ok: true, rules };
}

/** Whether every condition of the rule holds; an unknown or malformed one never does (fail closed). */
export function ruleMatches(rule: FlagRule, attributes: RuleAttributes) {
  return (
    rule.conditions.length > 0 &&
    rule.conditions.every((condition) => {
      if (!Object.hasOwn(RULE_CONDITIONS, condition.key)) {
        return false;
      }
      const template = TEMPLATES[condition.key as RuleConditionKey];
      const params = template.params.safeParse(condition.params);
      return params.success && template.holds(params.data, attributes);
    })
  );
}

/** Whether any rule names a condition that needs the roles loaded / the tenant read. */
export const rulesNeed = (
  rules: readonly FlagRule[],
  keys: readonly RuleConditionKey[],
) =>
  rules.some((rule) =>
    rule.conditions.some((condition) =>
      keys.includes(condition.key as RuleConditionKey),
    ),
  );
