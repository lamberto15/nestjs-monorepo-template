/**
 * How the audit log names its actors without importing the platform: the
 * platform provides this token (its PeopleService, the names comments and
 * revisions show). Absent, entries carry no name (`actorName: null`).
 */
export const ACTOR_NAMES = Symbol('ACTOR_NAMES');

export interface ActorNames {
  /**
   * The names of these principal keys (`user:<id>`, `client:<id>`) in the
   * current tenant, in one round whatever their number; null for a key
   * with none (`anonymous`, `system:<key>`, a deleted account, a removed
   * client).
   */
  names(keys: Iterable<string>): Promise<Map<string, string | null>>;
}
