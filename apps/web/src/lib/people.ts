import { unwrap, type GetResponse } from '@nestjs-monorepo-template/api-client';
import { queryOptions, useQueries } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * A member of the tenant as `GET /v1/people` gives them: their key
 * (`user:<id>`) and name, nothing else. Unlike `GET /v1/access/principals`
 * (lib/principals.ts), every member may read it: what pickers for ordinary
 * users search (an @mention, a delegate).
 */
export type Person = GetResponse<'/v1/people'>['items'][number];

/**
 * The roots of the people and unit caches (searches, names, pictures): what
 * changes who they are or what they are called invalidates the root, from
 * wherever that happens.
 */
export const peopleKey = ['people'] as const;
export const unitsKey = ['units'] as const;

/** The longest `q` the route takes (a longer one is a 400). */
const MAX_TERM = 100;

/** The user id in a person's key (`user:<id>`). */
export function personUserId(key: string): string {
  return key.startsWith('user:') ? key.slice('user:'.length) : key;
}

/**
 * The active members whose name contains `term`, by name. An empty term asks
 * for the first ones by name (the route refuses an empty `q`, so none is sent).
 */
export function peopleQuery(term: string) {
  const q = term.trim().slice(0, MAX_TERM);
  return queryOptions({
    queryKey: [...peopleKey, q],
    queryFn: async () =>
      (
        await unwrap(
          api.GET('/v1/people', { params: { query: q ? { q } : {} } }),
        )
      ).items,
    staleTime: 60_000,
  });
}

// ------------------------------------------------------------------ names

/**
 * Names for the keys and ids a page shows (`ownerId`, `unitId`, an audit
 * actor, a mention): `usePeopleNames(keys)` asks `GET /v1/people?key=`,
 * `useUnitNames(ids)` asks `GET /v1/organizational-units?id=`, both open to every member.
 *
 * Each key is a query of its own (TanStack Query's `useQueries`: the same key
 * asked by many cells is one query, kept long), but the requests are not:
 * every key asked within one tick of the clock goes in one request, the
 * "batcher" (DataLoader's pattern) below, in chunks of what the route takes.
 * Custom code, because Query has no batching of its own.
 */
type Waiter<T> = {
  resolve: (found: T | null) => void;
  reject: (error: unknown) => void;
};

/** The wait for more keys before asking: one render's effects all land within it. */
const BATCH_DELAY_MS = 5;

function createBatcher<T>(
  size: number,
  load: (keys: string[]) => Promise<Map<string, T>>,
) {
  let waiting = new Map<string, Waiter<T>[]>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    const batch = waiting;
    waiting = new Map();
    timer = undefined;
    const keys = [...batch.keys()];
    for (let at = 0; at < keys.length; at += size) {
      const chunk = keys.slice(at, at + size);
      load(chunk).then(
        (found) => {
          for (const key of chunk) {
            for (const waiter of batch.get(key) ?? []) {
              waiter.resolve(found.get(key) ?? null);
            }
          }
        },
        (error: unknown) => {
          for (const key of chunk) {
            for (const waiter of batch.get(key) ?? []) waiter.reject(error);
          }
        },
      );
    }
  };

  return (key: string) =>
    new Promise<T | null>((resolve, reject) => {
      const waiters = waiting.get(key) ?? [];
      waiters.push({ resolve, reject });
      waiting.set(key, waiters);
      timer ??= setTimeout(flush, BATCH_DELAY_MS);
    });
}

/** The most keys `GET /v1/people?key=` takes at once. */
const PEOPLE_BATCH = 20;
/** The most ids `GET /v1/organizational-units?id=` takes at once. */
const UNIT_BATCH = 100;

// One request serves a key's name and its picture.
const askPerson = createBatcher<Person>(PEOPLE_BATCH, async (keys) => {
  const { items } = await unwrap(
    api.GET('/v1/people', { params: { query: { key: keys.join(',') } } }),
  );
  return new Map(items.map((person) => [person.key, person]));
});

const askUnit = createBatcher<string>(UNIT_BATCH, async (ids) => {
  const found = new Map<string, string>();
  for await (const unit of api.items('/v1/organizational-units', {
    id: ids.join(','),
    limit: 100,
  })) {
    found.set(unit.id, unit.name);
  }
  return found;
});

// What the routes accept: anything else is a 400, so it is never asked.
const PERSON_KEY =
  /^(?:user|client):[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const UNIT_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/** Names rarely change, and a new name is not worth a request per page. */
const NAME_STALE_MS = 30 * 60_000;

/** One person's name by key (null: nobody of this tenant has it). */
export const personNameQuery = (key: string) =>
  queryOptions({
    queryKey: [...peopleKey, 'name', key],
    queryFn: async () => (await askPerson(key))?.name ?? null,
    staleTime: NAME_STALE_MS,
    gcTime: 2 * NAME_STALE_MS,
    retry: false,
    meta: { errorToast: false },
  });

/** One unit's name by id (null: this tenant has no such unit). */
export const unitNameQuery = (id: string) =>
  queryOptions({
    queryKey: [...unitsKey, 'name', id],
    queryFn: () => askUnit(id),
    staleTime: NAME_STALE_MS,
    gcTime: 2 * NAME_STALE_MS,
    retry: false,
    meta: { errorToast: false },
  });

/** The names of some keys: the key itself while loading and when unknown. */
export interface Names {
  /** The name, or the key itself (loading, unknown, or not a person's key). */
  name: (key: string) => string;
  /** The name; undefined while loading and when unknown. */
  get: (key: string) => string | undefined;
  /** Some name is still being asked for. */
  pending: boolean;
}

function useNames(
  keys: readonly (string | null | undefined)[],
  valid: RegExp,
  options: (key: string) => ReturnType<typeof personNameQuery>,
): Names {
  const wanted = [
    ...new Set(keys.filter((k): k is string => !!k && valid.test(k))),
  ];
  const { found, pending } = useQueries({
    queries: wanted.map(options),
    combine: (results) => {
      const found = new Map<string, string>();
      results.forEach((result, index) => {
        if (result.data) found.set(wanted[index]!, result.data);
      });
      return { found, pending: results.some((r) => r.isPending) };
    },
  });
  return {
    name: (key) => found.get(key) ?? key,
    get: (key) => found.get(key),
    pending,
  };
}

/** The names of these principal keys (`user:<id>`, `client:<id>`), one request per 20. */
export function usePeopleNames(
  keys: readonly (string | null | undefined)[],
): Names {
  return useNames(keys, PERSON_KEY, personNameQuery);
}

/** The names of these unit ids, one request per 100. */
export function useUnitNames(
  ids: readonly (string | null | undefined)[],
): Names {
  return useNames(ids, UNIT_ID, unitNameQuery);
}

// --------------------------------------------------------------- pictures

/** One person's picture address by key (null: none, or nobody of this tenant has the key). */
export const personAvatarQuery = (key: string) =>
  queryOptions({
    queryKey: [...peopleKey, 'avatar', key],
    queryFn: async () => (await askPerson(key))?.avatarUrl ?? null,
    // A picture changes more often than a name: the same window is long enough for a page, short for a session.
    staleTime: 5 * 60_000,
    gcTime: 2 * NAME_STALE_MS,
    retry: false,
    meta: { errorToast: false },
  });

/**
 * The pictures of these principal keys, asked together with their names
 * (the same batched `GET /v1/people?key=`): `avatarUrl(key)` is the address
 * to put in an `<img>`, undefined while loading and for no picture.
 */
export function usePeopleAvatars(
  keys: readonly (string | null | undefined)[],
): { avatarUrl: (key: string | null | undefined) => string | undefined } {
  const wanted = [
    ...new Set(keys.filter((k): k is string => !!k && PERSON_KEY.test(k))),
  ];
  const found = useQueries({
    queries: wanted.map(personAvatarQuery),
    combine: (results) => {
      const found = new Map<string, string>();
      results.forEach((result, index) => {
        if (result.data) found.set(wanted[index]!, result.data);
      });
      return found;
    },
  });
  return { avatarUrl: (key) => (key ? found.get(key) : undefined) };
}
