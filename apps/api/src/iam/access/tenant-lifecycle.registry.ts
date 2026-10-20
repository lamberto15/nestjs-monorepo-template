import { Injectable } from '@nestjs/common';

/**
 * What else ends when an operator deactivates a tenant
 * (`PATCH /v1/tenants/{id} { active: false }`): what lives outside the
 * database, which the `tenants.active` checks can't reach (realtime
 * connections, authenticated at their handshake, keep their tenant's
 * rooms); and what a tenant's erase (TenantDeletionJob) removes besides
 * its rows (`beforeErase`: its stored files, queued jobs, workflows,
 * outbox messages). The same pattern as UserLifecycleRegistry: register
 * from a constructor, `lifecycle.register(this)`.
 */
export interface TenantLifecycleListener {
  /** For the uniqueness check and the logs: `realtime`. */
  readonly name: string;
  /**
   * After the deactivation committed (never for one that rolled back):
   * the tenant's members and API clients, every one, active or not.
   */
  afterDeactivation?(
    tenantId: string,
    principals: readonly { kind: 'user' | 'client'; id: string }[],
  ): void | Promise<void>;
  /**
   * Before the erase deletes the tenant's row (the database cascading to
   * its rows): what of the tenant lives outside its tables, in a worker,
   * outside any tenant's scope. It must be safe to run again: a listener
   * that throws stops the erase, the tenant stays marked, and the next
   * night's run starts over.
   */
  beforeErase?(tenantId: string): void | Promise<void>;
}

@Injectable()
export class TenantLifecycleRegistry {
  private readonly listeners = new Map<string, TenantLifecycleListener>();

  register(listener: TenantLifecycleListener) {
    if (this.listeners.has(listener.name)) {
      throw new Error(
        `Two tenant lifecycle listeners are named "${listener.name}".`,
      );
    }
    this.listeners.set(listener.name, listener);
  }

  all() {
    return [...this.listeners.values()];
  }
}
