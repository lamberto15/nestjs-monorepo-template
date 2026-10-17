import { isApiError, unwrap } from '@nestjs-monorepo-template/api-client';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** A person a comment can mention. */
export type Mentionable = { id: string; email: string; name: string };

/**
 * Where a mention can come from: the tenant's users, `GET /v1/access/users`.
 * Backend issue #111: the OpenAPI types that route's answer as `never`
 * (`content?: never`), but the body is a page of users (`fields=` picks
 * them). The cast below is the only one; it can go when the schema is fixed.
 *
 * The route belongs to user management: a reader without that right gets 403,
 * and then the directory is empty (mentions are typed by hand as
 * `@address`, names show as "someone"). Backend finding: a directory open to
 * everyone who can read the record.
 */
async function fetchUsers(): Promise<Mentionable[]> {
  const users: Mentionable[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const result = (await unwrap(
      api.GET('/v1/access/users', {
        params: {
          query: {
            active: 'true',
            fields: 'id,email,name',
            sort: 'name',
            limit: 100,
            cursor,
          },
        },
      }),
    )) as unknown as { items: Mentionable[]; nextCursor?: string | null };
    users.push(...result.items);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return users;
}

export function useMentionable() {
  return useQuery({
    queryKey: ['panels', 'users'],
    queryFn: async () => {
      try {
        return await fetchUsers();
      } catch (error) {
        if (isApiError(error) && error.status === 403) {
          return [];
        }
        throw error;
      }
    },
    // The directory changes rarely; a 403 is not worth asking again.
    staleTime: 5 * 60 * 1000,
    meta: { errorToast: false },
    retry: false,
  });
}
