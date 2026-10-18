import { Injectable } from '@nestjs/common';

/**
 * What else goes when an API client is deleted (DELETE
 * /v1/access/clients/{id}): what the other groups keep about it outside
 * the database's foreign keys (its keys, role grants and usage go with the
 * row). The platform's webhooks drop its endpoints, kept by the webhooks
 * package in its own store; realtime ends its connections. The same
 * pattern as UserLifecycleRegistry: register from a constructor,
 * `lifecycle.register(this)`.
 */
export interface ApiClientLifecycleListener {
  /** For the uniqueness check and the logs: `webhooks`. */
  readonly name: string;
  /**
   * After the deletion committed (never for one that rolled back), in the
   * client's tenant: what lives outside the transaction.
   */
  afterDeletion(clientId: string, tenantId: string): void | Promise<void>;
}

@Injectable()
export class ApiClientLifecycleRegistry {
  private readonly listeners = new Map<string, ApiClientLifecycleListener>();

  register(listener: ApiClientLifecycleListener) {
    if (this.listeners.has(listener.name)) {
      throw new Error(
        `Two API client lifecycle listeners are named "${listener.name}".`,
      );
    }
    this.listeners.set(listener.name, listener);
  }

  all() {
    return [...this.listeners.values()];
  }
}
