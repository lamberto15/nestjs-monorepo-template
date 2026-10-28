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

/** Access management: users only, never while an administrator acts as someone else, never through break-glass. */
const manager = (user: Principal | null): user is Principal =>
  user?.kind === 'user' && !user.impersonator && !user.breakGlass;

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

  /** The organizational units and their tree: who sees what through the unit conditions. */
  async manageOrganizationalUnits(user: Principal | null) {
    return (
      manager(user) &&
      this.access.can(user, 'manageOrganizationalUnits', 'Access')
    );
  }

  /** Custom field definitions (platform/custom-fields): what every record of a subject may carry. */
  async manageCustomFields(user: Principal | null) {
    return (
      manager(user) && this.access.can(user, 'manageCustomFields', 'Access')
    );
  }

  /** Settings and feature flags (platform/settings): values for everyone, a unit or a user. */
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

  /** Business calendars (platform/calendars): working hours, time zone and holidays for deadlines. */
  async manageCalendars(user: Principal | null) {
    return manager(user) && this.access.can(user, 'manageCalendars', 'Access');
  }

  /** The deployment's tenants (TenantsController, also @OperatorOnly()). */
  async manageTenants(user: Principal | null) {
    return manager(user) && this.access.can(user, 'manageTenants', 'Access');
  }

  /**
   * Opening a tenant read only without its invitation (break-glass, also
   * @OperatorOnly()): `Platform.breakGlass`, a user acting as themselves.
   */
  async breakGlass(user: Principal | null) {
    return manager(user) && this.access.can(user, 'breakGlass', 'Platform');
  }

  async readAudit(user: Principal | null) {
    return userOnly(user) && this.access.can(user, 'readAudit', 'Access');
  }

  /** Act as another user for a while (support): sessions only, never as an administrator. */
  async impersonate(user: Principal | null) {
    return (
      userOnly(user) &&
      !user.impersonator &&
      !user.breakGlass &&
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
   * The access API's read routes (the catalog, roles, users, units, API
   * clients, principals): any permission of access administration, so
   * whoever manages units lists them and whoever impersonates finds whom.
   */
  async open(user: Principal | null) {
    return (
      (await this.manageRoles(user)) ||
      (await this.manageUsers(user)) ||
      (await this.manageClients(user)) ||
      (await this.manageOrganizationalUnits(user)) ||
      (await this.impersonate(user)) ||
      (await this.readAudit(user))
    );
  }

  /**
   * The two lists the SSO page's pickers need (the roles of the role
   * mappings, the users of the exemptions): `open`, and also whoever
   * manages SSO. Narrower than adding `manageSso` to `open`, which would
   * open the catalog, units, API clients and principals to it too.
   */
  async openForSso(user: Principal | null) {
    return (await this.open(user)) || (await this.manageSso(user));
  }
}
