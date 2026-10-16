import { Policy } from '@nestjs/authorization';
import { AccessService } from '../../iam/access/access.service.js';
import { AccessPolicy } from '../../iam/access/policies.js';
import type { Principal } from '../../iam/auth/principal.js';

/**
 * Who sees a subject's custom field definitions: whoever may read the
 * subject (clients render forms and tables from them), and whoever manages
 * them. Changing them is `AccessPolicy.manageCustomFields`.
 */
@Policy()
export class CustomFieldPolicy {
  constructor(
    private readonly access: AccessService,
    private readonly accessPolicy: AccessPolicy,
  ) {}

  async read(user: Principal | null, subject: string) {
    return (
      (await this.access.can(user, 'read', subject)) ||
      (await this.accessPolicy.manageCustomFields(user))
    );
  }
}
