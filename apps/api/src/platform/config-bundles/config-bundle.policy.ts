import { Policy } from '@nestjs/authorization';
import { AccessPolicy } from '../../iam/access/policies.js';
import type { Principal } from '../../iam/auth/principal.js';

/**
 * Configuration bundles (config-bundles.service.ts): they carry settings
 * and roles, so exporting, previewing and applying one takes both
 * Access.manageSettings and Access.manageRoles (a user acting as
 * themselves, AccessPolicy's own rule).
 */
@Policy()
export class ConfigBundlePolicy {
  constructor(private readonly access: AccessPolicy) {}

  async manage(user: Principal | null) {
    return (
      (await this.access.manageSettings(user)) && this.access.manageRoles(user)
    );
  }
}
