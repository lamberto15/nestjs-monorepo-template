import { Injectable } from '@nestjs/common';
import type { RequestPrincipal } from '../../iam/auth/principal.js';

/** The types a provider's parameter may have: a value is checked against it before the provider sees it. */
export type ChoiceParamType = 'uuid' | 'string';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a parameter's value has its declared type (and a sane size). */
export const paramFits = (type: ChoiceParamType, value: string) =>
  value.length > 0 &&
  value.length <= 200 &&
  (type === 'uuid' ? UUID.test(value) : true);

/** One choice, as a dropdown shows it. Only `value` is ever stored or trusted. */
export interface ChoiceItem {
  value: string;
  label: string;
}

/**
 * A server-side source of choices, registered by trusted code (never by a
 * request: no URL, no SQL from a client). Its queries are the provider's
 * own and bounded by the `limit` it is given; what it returns must already
 * be what `principal` may see.
 */
export interface ChoiceProvider {
  readonly key: string;
  readonly label: string;
  /**
   * The parameters it takes, by name and type: the allowlist. Every one is
   * required, and a set's field fills each from a sibling field's value.
   */
  readonly params: Readonly<Record<string, ChoiceParamType>>;
  /** Whether the principal may use the provider at all (a 403 otherwise). */
  mayUse(principal: RequestPrincipal): Promise<boolean>;
  /** Up to `limit` choices matching `q`, for these parameters, among those `principal` may see. */
  options(input: {
    principal: RequestPrincipal;
    params: Record<string, string>;
    q: string | undefined;
    limit: number;
  }): Promise<ChoiceItem[]>;
  /** Whether `value` is one of the choices `principal` may see for these parameters (the check on write). */
  has(input: {
    principal: RequestPrincipal;
    params: Record<string, string>;
    value: string;
  }): Promise<boolean>;
}

/** A field of a set: a provider, and which sibling field fills each of its parameters. */
export interface ChoiceFieldSpec {
  readonly provider: string;
  /** Parameter name → the name of the field (of the same set) whose value it takes. */
  readonly params?: Readonly<Record<string, string>>;
}

/**
 * Fields that choose from providers together, as a form declares them:
 * `{ unit: { provider: 'units' }, member: { provider: 'unit-members', params: { unitId: 'unit' } } }`
 * makes `member` depend on `unit`.
 */
export interface ChoiceSet {
  readonly key: string;
  readonly label: string;
  readonly fields: Readonly<Record<string, ChoiceFieldSpec>>;
}

/** The longest chain of dependent fields (a parent of a parent…): each level is a request. */
export const MAX_CHOICE_DEPTH = 4;

/**
 * The providers and sets of choices, registered by trusted code at boot
 * (the codebase's registry pattern, ListsRegistry). A set is checked when
 * registered: a provider that exists, exactly its parameters filled, from
 * fields of the set, and no cycle (A depends on B depends on A) or chain
 * longer than MAX_CHOICE_DEPTH. A bad declaration fails the boot. A feature
 * registers from one injectable's constructor (providers first, then its
 * sets), as `ChoicesBuiltins` does.
 */
@Injectable()
export class ChoicesRegistry {
  private readonly providers = new Map<string, ChoiceProvider>();
  private readonly sets = new Map<string, ChoiceSet>();

  provider(provider: ChoiceProvider) {
    if (this.providers.has(provider.key)) {
      throw new Error(`Two choice providers are named "${provider.key}".`);
    }
    this.providers.set(provider.key, provider);
  }

  set(set: ChoiceSet) {
    if (this.sets.has(set.key)) {
      throw new Error(`Two choice sets are named "${set.key}".`);
    }
    this.check(set);
    this.sets.set(set.key, set);
  }

  getProvider(key: string) {
    return this.providers.get(key);
  }

  getSet(key: string) {
    return this.sets.get(key);
  }

  allSets() {
    return [...this.sets.values()];
  }

  allProviders() {
    return [...this.providers.values()];
  }

  /** Throws when the set is not sound (see the class). */
  private check(set: ChoiceSet) {
    const fail = (message: string): never => {
      throw new Error(`Choice set "${set.key}": ${message}`);
    };
    for (const [name, spec] of Object.entries(set.fields)) {
      const provider =
        this.providers.get(spec.provider) ??
        fail(`${name} names the unregistered provider "${spec.provider}".`);
      const given = Object.keys(spec.params ?? {}).sort((a, b) =>
        a.localeCompare(b),
      );
      const wanted = Object.keys(provider.params).sort((a, b) =>
        a.localeCompare(b),
      );
      if (given.join() !== wanted.join()) {
        fail(
          `${name} must fill exactly the parameters of "${provider.key}" (${wanted.join(', ') || 'none'}), not (${given.join(', ') || 'none'}).`,
        );
      }
      for (const parent of Object.values(spec.params ?? {})) {
        if (parent === name) {
          fail(`${name} depends on itself.`);
        }
        if (!(parent in set.fields)) {
          fail(
            `${name} depends on "${parent}", which is not a field of the set.`,
          );
        }
      }
    }
    // Depth-first from each field up its parents: meeting a field on the way is a cycle.
    const depth = (name: string, path: string[]): number => {
      if (path.includes(name)) {
        fail(`a cycle: ${[...path, name].join(' → ')}.`);
      }
      const parents = Object.values(set.fields[name]!.params ?? {});
      return (
        1 +
        Math.max(0, ...parents.map((parent) => depth(parent, [...path, name])))
      );
    };
    for (const name of Object.keys(set.fields)) {
      if (depth(name, []) > MAX_CHOICE_DEPTH) {
        fail(`${name} is more than ${MAX_CHOICE_DEPTH} levels deep.`);
      }
    }
  }
}
