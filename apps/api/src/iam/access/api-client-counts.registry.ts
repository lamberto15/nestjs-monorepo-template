import { Injectable } from '@nestjs/common';
import type { Database, Transaction } from '../../core/database/drizzle.js';

/** The counts the platform adds to an API client (GET /v1/access/clients). */
export type ApiClientCountName = 'webhookEndpoints';

/**
 * Counts how many of something each of these clients has, in one grouped
 * query (never one per client); a client with none may be left out.
 */
export type ApiClientCounter = (
  clientIds: string[],
  db: Database | Transaction,
) => Promise<Map<string, number>>;

/**
 * What the platform counts about an API client, for its views
 * (`webhookEndpoints`: the endpoints the client has, kept by the webhooks
 * package, which IAM can't import). The same pattern as
 * ApiClientLifecycleRegistry: register from a constructor. A count nobody
 * registered (WEBHOOKS=off) is absent from the view, not 0.
 */
@Injectable()
export class ApiClientCountsRegistry {
  private readonly counters = new Map<ApiClientCountName, ApiClientCounter>();

  register(name: ApiClientCountName, counter: ApiClientCounter) {
    if (this.counters.has(name)) {
      throw new Error(`Two API client counts are named "${name}".`);
    }
    this.counters.set(name, counter);
  }

  /** Every registered count for these clients: `{ webhookEndpoints: { <clientId>: 2 } }`. */
  async counts(clientIds: string[], db: Database | Transaction) {
    const entries = await Promise.all(
      [...this.counters].map(
        async ([name, counter]) =>
          [name, await counter(clientIds, db)] as const,
      ),
    );
    return new Map(entries);
  }
}
