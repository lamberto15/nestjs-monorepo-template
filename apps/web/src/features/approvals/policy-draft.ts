import type { PolicyBody, PolicyTypes, PolicyView } from './api';

/**
 * A policy as the editor holds it (docs/approvals.md, "Policies at runtime").
 * The API names a rule, mode or condition by `type` with its parameters
 * beside it; here the parameters are kept apart (`params`), so editing them
 * never touches `type`. Empty optional text is "not set".
 */
export type Typed = { type: string; params: Record<string, unknown> };

export type StageDraft = {
  name: string;
  approvers: Typed[];
  mode: Typed;
  remindAfter: string;
  dueAfter: string;
  onOverdue: 'expire' | 'escalate';
  escalateTo: Typed[];
  escalationDueAfter: string;
};

export type PolicyDraft = {
  enabled: boolean;
  resubmitWithin: string;
  when: Typed | null;
  stages: StageDraft[];
};

export type TypeOption = PolicyTypes['modes'][number];
export type TypeKind = 'rule' | 'mode' | 'condition';

/** The subset of JSON Schema the registered types' parameters use. */
export type JsonSchema = {
  type?: string | string[];
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
};

/** Conditions made of others (`all`, `any` of a list; `not` of one). */
export const COMBINATORS = ['all', 'any', 'not'] as const;
export const isCombinator = (type: string) =>
  (COMBINATORS as readonly string[]).includes(type);

type Wire = { type: string } & Record<string, unknown>;

export function typedFromWire(entry: Wire): Typed {
  const { type, ...params } = entry;
  return { type, params };
}

export function typedToWire(entry: Typed): Wire {
  return { ...entry.params, type: entry.type };
}

/** A condition with its nested ones, converted either way. */
function conditionFromWire(entry: Wire): Typed {
  const typed = typedFromWire(entry);
  if (typed.type === 'not' && typed.params.condition) {
    typed.params = {
      condition: conditionFromWire(typed.params.condition as Wire),
    };
  } else if (
    isCombinator(typed.type) &&
    Array.isArray(typed.params.conditions)
  ) {
    typed.params = {
      conditions: (typed.params.conditions as Wire[]).map(conditionFromWire),
    };
  }
  return typed;
}

function conditionToWire(entry: Typed): Wire {
  const wire = typedToWire(entry);
  if (entry.type === 'not' && entry.params.condition) {
    wire.condition = conditionToWire(entry.params.condition as Typed);
  } else if (
    isCombinator(entry.type) &&
    Array.isArray(entry.params.conditions)
  ) {
    wire.conditions = (entry.params.conditions as Typed[]).map(conditionToWire);
  }
  return wire;
}

export function toDraft(policy: PolicyView['policy']): PolicyDraft {
  return {
    enabled: policy.enabled,
    resubmitWithin: policy.resubmitWithin,
    when: policy.when ? conditionFromWire(policy.when as Wire) : null,
    stages: policy.stages.map((stage) => ({
      name: stage.name,
      approvers: stage.approvers.map((rule) => typedFromWire(rule as Wire)),
      mode: typedFromWire(stage.mode as Wire),
      remindAfter: stage.remindAfter ?? '',
      dueAfter: stage.dueAfter ?? '',
      onOverdue: stage.onOverdue,
      escalateTo: (stage.escalateTo ?? []).map((rule) =>
        typedFromWire(rule as Wire),
      ),
      escalationDueAfter: stage.escalationDueAfter ?? '',
    })),
  };
}

/** The body of `PUT /v1/approvals/policies/{key}`: what is empty is left out. */
export function toBody(draft: PolicyDraft): PolicyBody {
  return {
    enabled: draft.enabled,
    ...(draft.when && { when: conditionToWire(draft.when) }),
    stages: draft.stages.map((stage) => {
      const escalate = stage.onOverdue === 'escalate';
      return {
        name: stage.name.trim(),
        approvers: stage.approvers.map(typedToWire),
        mode: typedToWire(stage.mode),
        ...(stage.remindAfter.trim() && {
          remindAfter: stage.remindAfter.trim(),
        }),
        ...(stage.dueAfter.trim() && { dueAfter: stage.dueAfter.trim() }),
        onOverdue: stage.onOverdue,
        // Only an escalation has someone to hand the stage to, and a deadline of its own.
        ...(escalate && { escalateTo: stage.escalateTo.map(typedToWire) }),
        ...(escalate &&
          stage.escalationDueAfter.trim() && {
            escalationDueAfter: stage.escalationDueAfter.trim(),
          }),
      };
    }),
    resubmitWithin: draft.resubmitWithin.trim() || '30d',
  };
}

/** What a property of a type's parameters is edited with. */
export type ParamKind =
  'enum' | 'boolean' | 'string' | 'number' | 'list' | 'json';

export function paramKind(schema: JsonSchema | undefined): ParamKind {
  if (!schema) return 'json';
  if (schema.enum?.every((value) => typeof value === 'string')) return 'enum';
  const type = Array.isArray(schema.type) ? undefined : schema.type;
  switch (type) {
    case 'boolean':
      return 'boolean';
    case 'string':
      return 'string';
    case 'integer':
    case 'number':
      return 'number';
    case 'array':
      return schema.items?.type === 'string' ? 'list' : 'json';
    default:
      // No type (`z.unknown()`), an object, a union: JSON.
      return 'json';
  }
}

/** The parameters of a type, as a new use of it starts: defaults, then a valid-looking value for each required one. */
export function initialOf(option: TypeOption): Typed {
  const schema = option.params as JsonSchema;
  const params: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    if (property.default !== undefined) {
      params[name] = property.default;
    } else if (schema.required?.includes(name)) {
      switch (paramKind(property)) {
        case 'enum':
          params[name] = property.enum?.[0];
          break;
        case 'boolean':
          params[name] = false;
          break;
        case 'string':
          params[name] = '';
          break;
        case 'number':
          params[name] = property.minimum ?? 0;
          break;
        case 'list':
          params[name] = [];
          break;
      }
    }
  }
  return { type: option.type, params };
}

export function emptyStage(
  rules: readonly TypeOption[],
  modes: readonly TypeOption[],
): StageDraft {
  const any = modes.find((mode) => mode.type === 'any') ?? modes[0];
  return {
    name: '',
    approvers: rules[0] ? [initialOf(rules[0])] : [],
    mode: any ? initialOf(any) : { type: 'any', params: {} },
    remindAfter: '',
    dueAfter: '',
    onOverdue: 'expire',
    escalateTo: [],
    escalationDueAfter: '',
  };
}

/** A value typed into a free field: JSON when it parses (`1000`, `["a"]`, `true`), else the text itself. */
export function looseFromText(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return text;
  }
}

/** The text a free field shows for a value: a string that would read as JSON keeps its quotes. */
export function looseToText(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') {
    try {
      JSON.parse(value);
      return JSON.stringify(value);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value);
}

/** The errors of a failed save that name this stage: `stages.<i>.…`. */
export function stageErrors(
  errors: readonly { path: string; message: string }[],
  index: number,
) {
  const prefix = `stages.${index}.`;
  return errors.filter((error) => error.path.startsWith(prefix));
}
