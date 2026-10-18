import { useQuery } from '@tanstack/react-query';
import { principalDirectoryQuery } from '@/lib/principals';

/** A person a comment can mention, or an author to name. */
export type Mentionable = {
  id: string;
  email: string;
  name: string;
  /** Deactivated people are still named, never offered for a mention. */
  active: boolean;
};

/**
 * Where a mention and an author's name come from: the tenant's users,
 * `GET /v1/access/principals?kind=user` (typed by the client), inactive ones
 * too so that old authors keep their names.
 *
 * The route answers the callers who may list users or clients (any of
 * Access.manageRoles, manageUsers, manageClients, readAudit). Anyone else
 * gets 403 and the directory is empty: mentions are typed by hand as
 * `@address`, names show as "someone" (backend #119: a people directory
 * open to everyone who can read the record).
 */
export function useMentionable() {
  return useQuery({
    ...principalDirectoryQuery('user'),
    select: (principals): Mentionable[] =>
      principals.map((principal) => ({
        id: principal.id,
        email: principal.email ?? '',
        name: principal.label,
        active: principal.active,
      })),
  });
}
