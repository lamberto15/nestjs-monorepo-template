import { Policy } from '@nestjs/authorization';
import { AccessService } from '../../iam/access/access.service.js';
import type { Principal } from '../../iam/auth/principal.js';

/**
 * Who may read a subject's list description (GET /v1/lists/{subject}):
 * whoever may read the subject, on any of its records (the list route
 * itself answers them; others get an empty list there, a 403 here).
 */
@Policy()
export class ListPolicy {
  constructor(private readonly access: AccessService) {}

  async read(user: Principal | null, subject: string) {
    return this.access.can(user, 'read', subject);
  }
}
