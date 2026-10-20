import {
  isApiError,
  unwrap,
  type GetResponse,
} from '@nestjs-monorepo-template/api-client';
import {
  queryOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { api } from '@/lib/api';
import {
  allCustomFieldsQuery,
  customFieldsKey,
  type CustomField,
  type CustomFieldChanges,
  type CustomFieldCreate,
} from '@/lib/custom-fields';

/** A subject that takes custom fields, named as the API names it. */
export type CustomFieldSubject =
  GetResponse<'/v1/custom-fields/subjects'>['items'][number];

/**
 * `GET /v1/custom-fields/subjects`: the subjects whose fields the caller may
 * read, each with its name in the response's language (docs/custom-fields.md).
 * The app keeps no list of its own. The language is in the key because the
 * labels follow it (the request's Accept-Language is the UI's).
 */
export const customFieldSubjectsQuery = (language: string) =>
  queryOptions({
    queryKey: ['custom-field-subjects', language],
    queryFn: async () => {
      try {
        return (await unwrap(api.GET('/v1/custom-fields/subjects'))).items;
      } catch (error) {
        // The API answers 403 when no subject takes fields (or none may be
        // read): that is the empty list, not a failure.
        if (isApiError(error) && error.status === 403) return [];
        throw error;
      }
    },
  });

/**
 * A change of the definitions reaches the forms and views built from them
 * and the lists' columns (`GET /v1/lists/{subject}` carries the fields).
 */
function useRefresh(subject: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: customFieldsKey }),
      queryClient.invalidateQueries({ queryKey: ['lists', subject] }),
    ]);
}

// The dialog and the page show the errors (a refused type change is a
// 409 with its reason): the global handler stays quiet for the dialog's.
export function useCreateField(subject: string) {
  const refresh = useRefresh(subject);
  return useMutation({
    mutationFn: (body: CustomFieldCreate) =>
      unwrap(api.POST('/v1/custom-fields', { body })),
    onSuccess: refresh,
    meta: { errorToast: false },
  });
}

export function useUpdateField(subject: string) {
  const refresh = useRefresh(subject);
  return useMutation({
    mutationFn: (input: { id: string; changes: CustomFieldChanges }) =>
      unwrap(
        api.PATCH('/v1/custom-fields/{id}', {
          params: { path: { id: input.id } },
          body: input.changes,
        }),
      ),
    onSuccess: refresh,
    meta: { errorToast: false },
  });
}

/** DELETE deactivates: values stay, `PATCH { active: true }` brings it back. */
export function useDeactivateField(subject: string) {
  const refresh = useRefresh(subject);
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(
        api.DELETE('/v1/custom-fields/{id}', { params: { path: { id } } }),
      ),
    onSuccess: refresh,
  });
}

/**
 * These fields first, in this order (the others follow). The new order shows
 * at once; a refused one is put back by the refetch.
 */
export function useReorderFields(subject: string) {
  const queryClient = useQueryClient();
  const refresh = useRefresh(subject);
  const key = allCustomFieldsQuery(subject).queryKey;
  return useMutation({
    mutationFn: (ids: string[]) =>
      unwrap(api.PUT('/v1/custom-fields/order', { body: { subject, ids } })),
    onMutate: async (ids) => {
      await queryClient.cancelQueries({ queryKey: key });
      queryClient.setQueryData<CustomField[]>(key, (fields) =>
        fields
          ? [
              ...ids.flatMap((id) => fields.filter((f) => f.id === id)),
              ...fields.filter((f) => !ids.includes(f.id)),
            ]
          : fields,
      );
    },
    onSettled: refresh,
  });
}
