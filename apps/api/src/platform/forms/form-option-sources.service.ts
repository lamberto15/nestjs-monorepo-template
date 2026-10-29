import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import {
  type ChoiceProvider,
  ChoicesRegistry,
} from '../choices/choices.registry.js';
import { DEFAULT_CHOICES } from '../choices/choices.schemas.js';
import {
  fieldsOf,
  type FormDefinition,
  type FormField,
  type SchemaIssue,
} from './form-schema.js';

/** How long one provider call may take before the answer is a 503 (form_source_unavailable). */
export const SOURCE_TIMEOUT_MS = 5_000;

/**
 * Option sources (docs/forms.md, "Option sources"): a choice field's
 * `optionsSource` names a provider of the choices registry
 * (docs/choices.md), which only trusted server code fills: never a URL or
 * a query from a request. A form may name one that takes no parameters.
 * The provider's queries are its own, through the request's transaction
 * behind row-level security, and return what the caller may see (its
 * field-level permissions included): a form never widens that.
 *
 * - Saving or publishing checks each source: registered, without
 *   parameters, and one the editor may use.
 * - Filling in reads a published field's choices through the form, never
 *   by the provider's name: `limit` at most 50, `q` to narrow, a 403 when
 *   the person may not use it.
 * - Sending checks every chosen value with the provider's `has`: a label,
 *   another tenant's id or a choice since removed is refused at its path.
 * - Each call is bounded by SOURCE_TIMEOUT_MS; a slow or failing provider
 *   is a 503, never a partial answer.
 */
@Injectable()
export class FormOptionSourcesService {
  constructor(private readonly registry: ChoicesRegistry) {}

  /** The providers an editor may give a field: registered, without parameters, usable by them. */
  async usable(principal: RequestPrincipal) {
    const items = [];
    for (const provider of this.registry.allProviders()) {
      if (
        Object.keys(provider.params).length === 0 &&
        (await bounded(provider.mayUse(principal)))
      ) {
        items.push({ key: provider.key, label: provider.label });
      }
    }
    return { items };
  }

  /** The problems of a definition's sources for this editor, at `sections.<s>.fields.<f>.optionsSource`. */
  async issues(
    principal: RequestPrincipal,
    definition: FormDefinition,
  ): Promise<SchemaIssue[]> {
    const issues: SchemaIssue[] = [];
    for (const [s, section] of definition.sections.entries()) {
      for (const [f, field] of section.fields.entries()) {
        if (!field.optionsSource) continue;
        const path = `sections.${s}.fields.${f}.optionsSource.provider`;
        const provider = this.registry.getProvider(
          field.optionsSource.provider,
        );
        if (!provider) {
          issues.push({ path, message: 'Not a registered option source.' });
        } else if (Object.keys(provider.params).length > 0) {
          issues.push({
            path,
            message: 'A source that takes parameters is not for forms yet.',
          });
        } else if (!(await bounded(provider.mayUse(principal)))) {
          issues.push({ path, message: 'You may not use this option source.' });
        }
      }
    }
    return issues;
  }

  /** A sourced field's choices for the person filling in: at most `limit`, `hasMore` when more match. */
  async options(
    principal: RequestPrincipal,
    definition: FormDefinition,
    key: string,
    query: { q?: string; limit?: number },
  ) {
    const field = fieldsOf(definition).find((one) => one.key === key);
    if (!field?.optionsSource) {
      throw new NotFoundException(`No field "${key}" with an option source.`);
    }
    const provider = await this.provider(principal, field);
    const limit = query.limit ?? DEFAULT_CHOICES;
    const found = await bounded(
      provider.options({ principal, params: {}, q: query.q, limit: limit + 1 }),
    );
    return {
      field: key,
      items: found
        .slice(0, limit)
        .map(({ value, label }) => ({ value, label })),
      hasMore: found.length > limit,
    };
  }

  /**
   * Whether each sourced answer is one of the choices the person may pick,
   * by value only (`has`): its problems at `answers.<key>` (`.<index>` in a
   * list). Run after checkAnswers, on the answers it normalized.
   */
  async answerIssues(
    principal: RequestPrincipal,
    definition: FormDefinition,
    answers: Record<string, unknown>,
  ): Promise<SchemaIssue[]> {
    const issues: SchemaIssue[] = [];
    for (const field of fieldsOf(definition)) {
      const answer = answers[field.key];
      if (!field.optionsSource || answer === undefined) continue;
      const provider = await this.provider(principal, field);
      const values = Array.isArray(answer) ? answer : [answer];
      for (const [index, value] of values.entries()) {
        const ok = await bounded(
          provider.has({ principal, params: {}, value: String(value) }),
        );
        if (!ok) {
          issues.push({
            path: Array.isArray(answer)
              ? `answers.${field.key}.${index}`
              : `answers.${field.key}`,
            message: 'Must be one of the options.',
          });
        }
      }
    }
    return issues;
  }

  /** The field's provider, when the person may use it: a 403 otherwise (a 503 if it is gone). */
  private async provider(
    principal: RequestPrincipal,
    field: FormField,
  ): Promise<ChoiceProvider> {
    const provider = this.registry.getProvider(field.optionsSource!.provider);
    if (!provider) {
      // Published while it was registered, unregistered since (a code change).
      throw unavailable();
    }
    if (!(await bounded(provider.mayUse(principal)))) {
      throw new ForbiddenException({
        code: 'form_source_forbidden',
        message: `You may not use the choices of "${field.key}".`,
      });
    }
    return provider;
  }
}

const unavailable = () =>
  new ServiceUnavailableException({
    code: 'form_source_unavailable',
    message: 'The choices could not be read now: try again.',
  });

/** A provider's call, or a 503 when it fails or takes longer than SOURCE_TIMEOUT_MS. */
async function bounded<T>(call: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(unavailable()), SOURCE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([call, timeout]);
  } catch (error) {
    if (error instanceof ForbiddenException) throw error;
    throw unavailable();
  } finally {
    clearTimeout(timer);
  }
}
