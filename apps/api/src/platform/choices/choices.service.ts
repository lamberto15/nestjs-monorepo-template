import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import type { ChoiceOptionsQuery } from './choices.schemas.js';
import { DEFAULT_CHOICES } from './choices.schemas.js';
import {
  type ChoiceProvider,
  ChoicesRegistry,
  type ChoiceSet,
  paramFits,
} from './choices.registry.js';

const PARENT = 'parent.';

const invalid = (errors: { path: string; message: string }[]) =>
  new BadRequestException({
    code: 'validation_failed',
    message: 'The request is invalid.',
    errors,
  });

/**
 * Dependent dropdowns: the choices of a set's field for the values of the
 * fields it depends on, from a registered provider (never a URL or query
 * from a request). Each answer is bounded (`limit`, at most MAX_CHOICES) and
 * already filtered by the provider to what the caller may see. The same
 * check runs again on write (`assertValid`): the stored value must be one of
 * the choices the caller could pick for the parents' values sent with it, so
 * a changed parent invalidates a child that no longer fits, and nothing the
 * browser sent as a label is trusted.
 */
@Injectable()
export class ChoicesService {
  constructor(private readonly registry: ChoicesRegistry) {}

  /** The sets, with the fields whose provider the principal may use. */
  async sets(principal: RequestPrincipal) {
    const items = await Promise.all(
      this.registry.allSets().map((set) => this.describe(principal, set)),
    );
    return { items };
  }

  async set(principal: RequestPrincipal, key: string) {
    return this.describe(principal, this.getSet(key));
  }

  /** The choices of one field for its parents' values (`parent.<field>`). */
  async options(
    principal: RequestPrincipal,
    key: string,
    name: string,
    query: ChoiceOptionsQuery,
  ) {
    const set = this.getSet(key);
    const spec = set.fields[name];
    if (!spec) {
      throw new NotFoundException(
        `No field "${name}" in the choices "${key}".`,
      );
    }
    const provider = await this.usable(principal, spec.provider);
    const { q, limit, ...rest } = query;
    const errors: { path: string; message: string }[] = [];
    const parents: Record<string, string> = {};
    const wanted = new Set(Object.values(spec.params ?? {}));
    for (const [param, value] of Object.entries(rest)) {
      const parent = param.startsWith(PARENT) ? param.slice(PARENT.length) : '';
      if (!wanted.has(parent)) {
        errors.push({
          path: param,
          message: wanted.size
            ? `Not a parameter: use ${[...wanted].map((p) => PARENT + p).join(', ')}.`
            : `${name} depends on no field.`,
        });
      } else {
        parents[parent] = value;
      }
    }
    const params = this.paramsOf(provider, spec.params, parents, errors, '');
    if (errors.length) {
      throw invalid(errors);
    }
    const asked = limit ?? DEFAULT_CHOICES;
    // One more than asked says whether there are more, without counting.
    const found = await provider.options({
      principal,
      params,
      q,
      limit: asked + 1,
    });
    return {
      set: key,
      field: name,
      parents,
      items: found.slice(0, asked),
      hasMore: found.length > asked,
    };
  }

  /**
   * A 400 `validation_failed`, one error per field (path = its name), when a
   * value is not among the choices the principal could pick given the values
   * of the fields it depends on. Absent or `null` values are not checked
   * (whether a field is required is the record's); a value whose parent is
   * missing, or is not itself a choice, is refused.
   */
  async assertValid(
    principal: RequestPrincipal,
    key: string,
    values: Record<string, unknown>,
  ) {
    const set = this.getSet(key);
    const errors: { path: string; message: string }[] = [];
    for (const name of Object.keys(values)) {
      if (!(name in set.fields)) {
        errors.push({ path: name, message: `Not a field of "${key}".` });
      }
    }
    // Which fields are valid, so a child of an invalid parent is refused too.
    const valid = new Map<string, boolean>();
    const check = async (name: string): Promise<boolean> => {
      if (valid.has(name)) {
        return valid.get(name)!;
      }
      const value = values[name];
      const spec = set.fields[name]!;
      let ok = true;
      if (value !== undefined && value !== null) {
        const provider = await this.usable(principal, spec.provider);
        const parents: Record<string, string> = {};
        const here: typeof errors = [];
        for (const parent of Object.values(spec.params ?? {})) {
          const parentValue = values[parent];
          if (typeof parentValue !== 'string') {
            here.push({
              path: name,
              message: `Choose ${parent} first: ${name} depends on it.`,
            });
          } else if (!(await check(parent))) {
            here.push({
              path: name,
              message: `${parent} is not a valid choice, so ${name} cannot be checked.`,
            });
          } else {
            parents[parent] = parentValue;
          }
        }
        const params = here.length
          ? {}
          : this.paramsOf(provider, spec.params, parents, here, name);
        if (
          !here.length &&
          (typeof value !== 'string' ||
            !(await provider.has({ principal, params, value })))
        ) {
          here.push({
            path: name,
            message: `Not one of the choices available for ${name}${Object.keys(parents).length ? ` given ${Object.keys(parents).join(', ')}` : ''}.`,
          });
        }
        errors.push(...here);
        ok = here.length === 0;
      }
      valid.set(name, ok);
      return ok;
    };
    for (const name of Object.keys(set.fields)) {
      await check(name);
    }
    if (errors.length) {
      throw invalid(errors);
    }
  }

  private getSet(key: string): ChoiceSet {
    const set = this.registry.getSet(key);
    if (!set) {
      throw new NotFoundException(`No choices named "${key}".`);
    }
    return set;
  }

  /** The provider, unless the principal may not use it (403): never one a request names itself. */
  private async usable(principal: RequestPrincipal, key: string) {
    const provider = this.registry.getProvider(key)!;
    if (!(await provider.mayUse(principal))) {
      throw new ForbiddenException({
        code: 'forbidden',
        message: `You may not use the choices of ${provider.label}.`,
      });
    }
    return provider;
  }

  /** The provider's parameters from the parents' values, typed; problems go to `errors`. */
  private paramsOf(
    provider: ChoiceProvider,
    map: Readonly<Record<string, string>> | undefined,
    parents: Record<string, string>,
    errors: { path: string; message: string }[],
    path: string,
  ) {
    const params: Record<string, string> = {};
    for (const [param, type] of Object.entries(provider.params)) {
      const parent = map![param]!;
      const value = parents[parent];
      const at = path || `${PARENT}${parent}`;
      if (value === undefined) {
        errors.push({ path: at, message: `${PARENT}${parent} is required.` });
      } else if (!paramFits(type, value)) {
        errors.push({ path: at, message: `${parent} is not a valid ${type}.` });
      } else {
        params[param] = value;
      }
    }
    return params;
  }

  private async describe(principal: RequestPrincipal, set: ChoiceSet) {
    const fields = [];
    for (const [name, spec] of Object.entries(set.fields)) {
      const provider = this.registry.getProvider(spec.provider)!;
      if (await provider.mayUse(principal)) {
        fields.push({
          name,
          provider: provider.key,
          label: provider.label,
          dependsOn: [...new Set(Object.values(spec.params ?? {}))],
        });
      }
    }
    // Parents first: by the length of their chain of parents.
    const depth = (name: string): number =>
      1 +
      Math.max(0, ...Object.values(set.fields[name]!.params ?? {}).map(depth));
    fields.sort((a, b) => depth(a.name) - depth(b.name));
    return { key: set.key, label: set.label, fields };
  }
}
