import { Policy } from '@nestjs/authorization';
import type { Principal } from '../auth/principal.js';
import { AccessService } from './access.service.js';

/**
 * The policies of @nestjs/authorization: what routes and services check, by
 * name, type-checked. Each ability asks the principal's CASL ability, so what
 * a role may do changes through the access API while the checks stay in code. A
 * guest (`null`) is denied everywhere.
 *
 * Each group and feature keeps its own policy next to its code (e.g.
 * features/notes/note.policy.ts); this one guards access control itself.
 */

/** For abilities only users may hold, whatever an API client's permissions say. */
export const userOnly = (user: Principal | null) => user?.kind === 'user';

/** Access management: users only, and never while an administrator acts as someone else. */
const manager = (user: Principal | null): user is Principal =>
  user?.kind === 'user' && !user.impersonator;

@Policy()
export class AccessPolicy {
  constructor(private readonly access: AccessService) {}

  async manageRoles(user: Principal | null) {
    return manager(user) && this.access.can(user, 'manageRoles', 'Access');
  }

  async manageUsers(user: Principal | null) {
    return manager(user) && this.access.can(user, 'manageUsers', 'Access');
  }

  async manageClients(user: Principal | null) {
    return manager(user) && this.access.can(user, 'manageClients', 'Access');
  }

  /** The org units and their tree: who sees what through `inMyUnits`. */
  async manageOrgUnits(user: Principal | null) {
    return manager(user) && this.access.can(user, 'manageOrgUnits', 'Access');
  }

  /** Custom field definitions (platform/custom-fields): what every record of a subject may carry. */
  async manageCustomFields(user: Principal | null) {
    return (
      manager(user) && this.access.can(user, 'manageCustomFields', 'Access')
    );
  }

  /** Settings and feature flags (platform/settings): values for everyone, an org unit or a user. */
  async manageSettings(user: Principal | null) {
    return manager(user) && this.access.can(user, 'manageSettings', 'Access');
  }

  /** Tags (platform/tags): the labels records of a subject may carry. */
  async manageTags(user: Principal | null) {
    return manager(user) && this.access.can(user, 'manageTags', 'Access');
  }

  /** The deployment's tenants (TenantsController, also @OperatorOnly()). */
  async manageTenants(user: Principal | null) {
    return manager(user) && this.access.can(user, 'manageTenants', 'Access');
  }

  async readAudit(user: Principal | null) {
    return userOnly(user) && this.access.can(user, 'readAudit', 'Access');
  }

  /** Act as another user for a while (support): sessions only, never as an administrator. */
  async impersonate(user: Principal | null) {
    return (
      userOnly(user) &&
      !user.impersonator &&
      this.access.can(user, 'impersonate', 'Access')
    );
  }

  /** The access API's read routes: any Access permission. */
  async open(user: Principal | null) {
    return (
      (await this.manageRoles(user)) ||
      (await this.manageUsers(user)) ||
      (await this.manageClients(user)) ||
      (await this.readAudit(user))
    );
  }
}
