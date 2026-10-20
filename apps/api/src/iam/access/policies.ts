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
 * features/<x>/<item>.policy.ts); this one guards access control itself.
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

  /** The teams and their tree: who sees what through `inMyTeams`. */
  async manageTeams(user: Principal | null) {
    return manager(user) && this.access.can(user, 'manageTeams', 'Access');
  }

  /** Custom field definitions (platform/custom-fields): what every record of a subject may carry. */
  async manageCustomFields(user: Principal | null) {
    return (
      manager(user) && this.access.can(user, 'manageCustomFields', 'Access')
    );
  }

  /** Settings and feature flags (platform/settings): values for everyone, a team or a user. */
  async manageSettings(user: Principal | null) {
    return manager(user) && this.access.can(user, 'manageSettings', 'Access');
  }

  /** Tags (platform/tags): the labels records of a subject may carry. */
  async manageTags(user: Principal | null) {
    return manager(user) && this.access.can(user, 'manageTags', 'Access');
  }

  /** Legal holds (iam/holds): records kept whatever a delete, a purge or a retention rule would do. */
  async manageLegalHolds(user: Principal | null) {
    return manager(user) && this.access.can(user, 'manageLegalHolds', 'Access');
  }

  /** Retention rules (platform/retention): how long a tenant keeps each kind of record. */
  async manageRetention(user: Principal | null) {
    return manager(user) && this.access.can(user, 'manageRetention', 'Access');
  }

  /** Naming series (platform/sequences): the number formats of numbered records, their counters. */
  async manageNamingSeries(user: Principal | null) {
    return (
      manager(user) && this.access.can(user, 'manageNamingSeries', 'Access')
    );
  }

  /** The deployment's tenants (TenantsController, also @OperatorOnly()). */
  async manageTenants(user: Principal | null) {
    return manager(user) && this.access.can(user, 'manageTenants', 'Access');
  }

  async readAudit(user: Principal | null) {
    return userOnly(user) && this.access.can(user, 'readAudit', 'Access');
  }

  /**
   * Read the tenants below the caller's in the tenant tree, read-only
   * (TenantTree.consolidated(), docs/tenancy.md "The tenant tree"): a user,
   * never while impersonating, nor an API client.
   */
  async readConsolidated(user: Principal | null) {
    return manager(user) && this.access.can(user, 'readConsolidated', 'Access');
  }

  /** The audit log of the caller's tenant and the tenants below it. */
  async readConsolidatedAudit(user: Principal | null) {
    return (await this.readAudit(user)) && this.readConsolidated(user);
  }

  /** Act as another user for a while (support): sessions only, never as an administrator. */
  async impersonate(user: Principal | null) {
    return (
      userOnly(user) &&
      !user.impersonator &&
      this.access.can(user, 'impersonate', 'Access')
    );
  }

  /** The tenant's single sign-on: its connections and verified domains (iam/sso). */
  async manageSso(user: Principal | null) {
    return manager(user) && this.access.can(user, 'manageSso', 'Access');
  }

  /**
   * SCIM 2.0 provisioning (`/v1/scim/…`): an API client only, the identity
   * provider's, whose key is its SCIM token.
   */
  async provisionScim(user: Principal | null) {
    return (
      user?.kind === 'client' &&
      this.access.can(user, 'provisionScim', 'Access')
    );
  }

  /**
   * The access API's read routes (the catalog, roles, users, teams, API
   * clients, principals): any permission of access administration, so
   * whoever manages teams lists them and whoever impersonates finds whom.
   */
  async open(user: Principal | null) {
    return (
      (await this.manageRoles(user)) ||
      (await this.manageUsers(user)) ||
      (await this.manageClients(user)) ||
      (await this.manageTeams(user)) ||
      (await this.impersonate(user)) ||
      (await this.readAudit(user))
    );
  }
}
