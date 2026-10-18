import { Policy } from '@nestjs/authorization';
import { AccessService } from '../../iam/access/access.service.js';
import type { Principal } from '../../iam/auth/principal.js';
import { ListsRegistry } from './lists.registry.js';

/**
 * Who may read a subject's list description (GET /v1/lists/{subject}):
 * whoever may read the subject, on any of its records (the list route
 * itself answers them; others get an empty list there, a 403 here).
 */
@Policy()
export class ListPolicy {
  constructor(
    private readonly access: AccessService,
    private readonly registry: ListsRegistry,
  ) {}

  /** Or, for a list that isn't of records, what its registration says (`readable`). */
  async read(user: Principal | null, subject: string) {
    const readable = this.registry.get(subject)?.readable;
    return readable ? readable(user) : this.access.can(user, 'read', subject);
  }
}
