import {
  unwrap,
  type GetResponse,
  type paths,
} from '@nestjs-monorepo-template/api-client';
import {
  queryOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { api } from '@/lib/api';
import { settingsQuery } from '@/features/settings/settings';

/** A runtime form (docs/forms.md), as lists show it. */
/** A form's definition: sections of typed fields. */
export type FormDefinition = GetResponse<'/v1/forms/{id}/draft'>['definition'];
export type FormSection = FormDefinition['sections'][number];
export type FormField = FormSection['fields'][number];
export type FieldType = FormField['type'];
type CreateForm = NonNullable<
  paths['/v1/forms']['post']['requestBody']
>['content']['application/json'];

/** The field types, in the order the builder offers them. */
export const FIELD_TYPES: readonly FieldType[] = [
  'text',
  'textarea',
  'email',
  'url',
  'integer',
  'decimal',
  'date',
  'checkbox',
  'select',
  'radio',
  'multiSelect',
];
/** The types whose answer is one of `options` (or several, multiSelect). */
export const CHOICE_TYPES: readonly FieldType[] = [
  'select',
  'radio',
  'multiSelect',
];

/** Every forms query starts with this key (one invalidation covers all). */
const formsKey = ['forms'] as const;

/** `forms.enabled`: a public setting, so every signed-in user can read it. */
export const formsEnabledQuery = queryOptions({
  ...settingsQuery,
  staleTime: 5 * 60_000,
  meta: { errorToast: false },
  select: (items) =>
    items.find((s) => s.key === 'forms.enabled')?.value === true,
});

export const formsQuery = queryOptions({
  queryKey: [...formsKey, 'list'],
  queryFn: () =>
    unwrap(api.GET('/v1/forms', { params: { query: { limit: 100 } } })),
});

export const formQuery = (id: string) =>
  queryOptions({
    queryKey: [...formsKey, id],
    queryFn: () =>
      unwrap(api.GET('/v1/forms/{id}', { params: { path: { id } } })),
  });

export const draftQuery = (id: string) =>
  queryOptions({
    queryKey: [...formsKey, id, 'draft'],
    queryFn: () =>
      unwrap(api.GET('/v1/forms/{id}/draft', { params: { path: { id } } })),
  });

export const publishedQuery = (id: string) =>
  queryOptions({
    queryKey: [...formsKey, id, 'published'],
    queryFn: () =>
      unwrap(api.GET('/v1/forms/{id}/published', { params: { path: { id } } })),
  });

export const submissionsQuery = (formId: string) =>
  queryOptions({
    queryKey: [...formsKey, formId, 'submissions'],
    queryFn: () =>
      unwrap(
        api.GET('/v1/forms/{formId}/submissions', {
          params: { path: { formId }, query: { limit: 100 } },
        }),
      ),
  });

function useRefresh() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: formsKey });
}

/** Errors are the dialog's or the builder's: no global toast. */
export function useCreateForm() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (body: CreateForm) => unwrap(api.POST('/v1/forms', { body })),
    onSuccess: refresh,
    meta: { errorToast: false },
  });
}

export function useSaveDraft(id: string) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (body: { revision: number; definition: FormDefinition }) =>
      unwrap(
        api.PUT('/v1/forms/{id}/draft', { params: { path: { id } }, body }),
      ),
    onSuccess: refresh,
    meta: { errorToast: false },
  });
}

export function usePublish(id: string) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (revision: number) =>
      unwrap(
        api.POST('/v1/forms/{id}/publish', {
          params: { path: { id } },
          body: { revision },
        }),
      ),
    onSuccess: refresh,
    meta: { errorToast: false },
  });
}

/** Answers to a published version (the client sends the Idempotency-Key itself). */
export function useSubmit(formId: string) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (body: {
      versionId: string;
      answers: Record<string, unknown>;
    }) =>
      unwrap(
        api.POST('/v1/forms/{formId}/submissions', {
          params: { path: { formId } },
          body,
        }),
      ),
    onSuccess: refresh,
    meta: { errorToast: false },
  });
}

/** A problem's field errors (`errors[]`: dotted paths), by path. */
export function errorsByPath(error: unknown): Record<string, string> {
  const errors = (error as { errors?: { path: string; message: string }[] })
    ?.errors;
  return Object.fromEntries((errors ?? []).map((e) => [e.path, e.message]));
}
