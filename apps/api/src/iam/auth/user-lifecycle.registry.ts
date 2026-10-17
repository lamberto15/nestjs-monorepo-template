import { Injectable } from '@nestjs/common';
import type { Transaction } from '../../core/database/drizzle.js';
import type { Principal } from './principal.js';

/**
 * What else changes when an account is deactivated: the platform's data
 * that waits on a person (approvals assigned to them, delegations). Called
 * in the deactivation's transaction (AccessAdminService.updateUser), so it
 * commits with it. Register from the constructor: `lifecycle.register(this)`.
 * (Account deletion has its own hook: PersonalDataSource.erase.)
 */
export interface UserLifecycleListener {
  /** For the uniqueness check and the logs: `approvals`. */
  readonly name: string;
  /**
   * In the deactivation's transaction, in the tenant's scope. `by`: who
   * deactivated the membership (the actor of what follows from it).
   */
  deactivated?(tx: Transaction, userId: string, by: Principal): Promise<void>;
  /**
   * After the deactivation committed (never for one that rolled back):
   * what can't be undone, as ending live connections.
   */
  afterDeactivation?(userId: string, tenantId: string): void | Promise<void>;
}

@Injectable()
export class UserLifecycleRegistry {
  private readonly listeners = new Map<string, UserLifecycleListener>();

  register(listener: UserLifecycleListener) {
    if (this.listeners.has(listener.name)) {
      throw new Error(
        `Two user lifecycle listeners are named "${listener.name}".`,
      );
    }
    this.listeners.set(listener.name, listener);
  }

  all() {
    return [...this.listeners.values()];
  }
}
