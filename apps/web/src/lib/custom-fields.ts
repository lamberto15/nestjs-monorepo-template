import {
  unwrap,
  type GetResponse,
  type paths,
} from '@nestjs-monorepo-template/api-client';
import { queryOptions } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * The custom field definitions of a subject (docs/custom-fields.md): what
 * the admin page edits and what record forms and views are built from.
 * Reading them needs only `read` on the subject.
 */
export type CustomField = GetResponse<'/v1/custom-fields'>['items'][number];
export type CustomFieldType = CustomField['type'];
export type CustomFieldCreate = NonNullable<
  paths['/v1/custom-fields']['post']['requestBody']
>['content']['application/json'];
export type CustomFieldChanges = NonNullable<
  paths['/v1/custom-fields/{id}']['patch']['requestBody']
>['content']['application/json'];

/** Every definitions query starts with this key (one invalidation covers all). */
export const customFieldsKey = ['custom-fields'] as const;

/** The active fields, in order: what a record form or a record view shows. */
export const customFieldsQuery = (subject: string) =>
  queryOptions({
    queryKey: [...customFieldsKey, subject, 'active'],
    queryFn: async () =>
      (
        await unwrap(
          api.GET('/v1/custom-fields', { params: { query: { subject } } }),
        )
      ).items,
  });

/** Active and deactivated fields: the administration page. */
export const allCustomFieldsQuery = (subject: string) =>
  queryOptions({
    queryKey: [...customFieldsKey, subject, 'all'],
    queryFn: async () =>
      (
        await unwrap(
          api.GET('/v1/custom-fields', {
            params: { query: { subject, includeInactive: 'true' } },
          }),
        )
      ).items,
  });

/** The types that take `options` (the choices). */
export const hasOptions = (type: CustomFieldType) =>
  type === 'select' || type === 'multiSelect';

/** The types a pattern and lengths apply to. */
export const isTextual = (type: CustomFieldType) =>
  type === 'text' || type === 'longText' || type === 'email' || type === 'url';

/**
 * The most characters a textual type takes whatever its `maxLength`
 * (docs/custom-fields.md, "How it's stored").
 */
export const TEXT_LIMITS = {
  text: 1000,
  longText: 10_000,
  email: 254,
  url: 2048,
} as const;
