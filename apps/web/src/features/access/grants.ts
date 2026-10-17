import type { Grant } from '@/features/access/api';

/**
 * Role grants as the forms edit them: the roles ticked, each with an end
 * (`datetime-local` text, '' for none). A grant whose end has passed counts
 * for nothing (docs/permissions.md, "Roles and grants"), so it isn't ticked:
 * sending its role again without an end would make it permanent.
 */
export type GrantDraft = Record<string, string>;

/** `2026-10-17T12:30` (the input's local time) from an ISO instant. */
export function toLocalInput(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function isEnded(grant: Grant, now = Date.now()): boolean {
  return grant.expiresAt !== null && Date.parse(grant.expiresAt) <= now;
}

/** The live grants of a member as a draft. */
export function draftOf(
  grants: readonly Grant[],
  now = Date.now(),
): GrantDraft {
  return Object.fromEntries(
    grants
      .filter((grant) => !isEnded(grant, now))
      .map((grant) => [
        grant.roleId,
        grant.expiresAt ? toLocalInput(grant.expiresAt) : '',
      ]),
  );
}

/**
 * A draft as the API's `roleIds` and `roleExpiresAt`. The map is always
 * sent whole (the API replaces every end with it), so ends are explicit.
 */
export function grantsBody(draft: GrantDraft): {
  roleIds: string[];
  roleExpiresAt: Record<string, string>;
} {
  const roleIds = Object.keys(draft);
  const roleExpiresAt: Record<string, string> = {};
  for (const [roleId, until] of Object.entries(draft)) {
    if (until) {
      roleExpiresAt[roleId] = new Date(until).toISOString();
    }
  }
  return { roleIds, roleExpiresAt };
}

/** Whether an end is set and already past (the API refuses those). */
export function endInPast(until: string, now = Date.now()): boolean {
  return until !== '' && new Date(until).getTime() <= now;
}
