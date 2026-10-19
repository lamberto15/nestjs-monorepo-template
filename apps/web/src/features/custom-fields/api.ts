import { unwrap } from '@nestjs-monorepo-template/api-client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import {
  allCustomFieldsQuery,
  customFieldsKey,
  type CustomField,
  type CustomFieldChanges,
  type CustomFieldCreate,
} from '@/lib/custom-fields';

/**
 * The subjects whose records take custom fields. The API has no list of
 * them (an open backend issue); `GET /v1/lists/{subject}` says per subject
 * (`capabilities.custom`), and the fields route answers 404 for one that
 * takes none. Add a subject here when a feature opts in
 * (`--with custom`, docs/custom-fields.md).
 */
export const CUSTOM_FIELD_SUBJECTS = ['Note'] as const;

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
