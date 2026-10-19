import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import {
  WebhookDeliveries,
  WebhookEndpoints,
  WebhooksStorage,
  WebhookWorker,
  type WebhookDelivery,
  type WebhookMessage,
} from '@nestjs/webhooks';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../../core/database/drizzle.js';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import type { ListQuery } from '../../core/http/list-query.js';
import {
  countPage,
  pageOffset,
  pageOrder,
  toPage,
} from '../../core/http/pagination.js';
import { AccessAdminService } from '../../iam/access/access-admin.service.js';
import { ApiClientCountsRegistry } from '../../iam/access/api-client-counts.registry.js';
import { ApiClientLifecycleRegistry } from '../../iam/access/api-client-lifecycle.registry.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { apiClients } from '../../iam/iam.tables.js';
import { PLATFORM_OPTIONS, type PlatformOptions } from '../platform.options.js';
import { switchedOn } from '../switches.js';
import type {
  CreateEndpointDto,
  RetryDeliveriesDto,
  UpdateEndpointDto,
} from './webhook.schemas.js';
import {
  DELIVERY_LIST,
  deliveryColumns,
  storeDeliveries,
  storeEndpoints,
} from './webhook-store.view.js';
import { eventTypeGroups, TEST_EVENT_TYPE } from './webhooks.config.js';
import { webhookDeliveryRequests } from './webhooks.tables.js';

/** The delivery's times, which the package keeps in epoch milliseconds. */
const DELIVERY_TIMES = [
  'createdAt',
  'nextAttemptAt',
  'lastAttemptAt',
  'completedAt',
] as const;

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * A delivery with its times as ISO 8601 strings, like the rest of the API
 * (the package and its store keep epoch milliseconds). Only the keys the
 * item has (`?fields=` may leave some out); null stays null.
 */
function deliveryView(delivery: object): Record<string, unknown> {
  const view: Record<string, unknown> = { ...delivery };
  for (const key of DELIVERY_TIMES) {
    const value = view[key];
    if (typeof value === 'number') {
      view[key] = iso(value);
    }
  }
  return view;
}

/**
 * Who manages a client's webhooks: the client itself (its API key), or a
 * signed-in administrator on its behalf (`by`), whose changes are audited
 * as theirs, with the client as the target.
 */
export interface WebhookOwner {
  /** The API client: the package's tenant (docs/webhooks-and-realtime.md). */
  clientId: string;
  /** The administrator acting for the client (the delegated routes). */
  by?: { user: UserPrincipal; ip?: string };
}

/**
 * An API client's webhook endpoints and deliveries, for both doors: the
 * client's own routes (`/v1/webhook-endpoints`, `/v1/webhook-deliveries`)
 * and an administrator's delegated ones (`/v1/access/clients/{id}/…`).
 * Each call goes to the webhooks package with the client as the tenant,
 * so another client's endpoint or delivery is a 404 either way.
 *
 * The package keeps endpoints and deliveries in its own store (its own
 * connection, not the request's transaction), so an administrator's audit
 * entry is written after the package's change succeeded, not in one
 * transaction with it.
 */
@Injectable()
export class WebhookManagementService {
  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly endpoints: WebhookEndpoints,
    private readonly deliveries: WebhookDeliveries,
    private readonly storage: WebhooksStorage,
    private readonly worker: WebhookWorker,
    private readonly admin: AccessAdminService,
    private readonly audit: AuditService,
    @Inject(PLATFORM_OPTIONS) private readonly options: PlatformOptions,
    clientLifecycle: ApiClientLifecycleRegistry,
    clientCounts: ApiClientCountsRegistry,
  ) {
    // A deleted client's endpoints go with it: nothing is sent to a client
    // that no longer exists (its pending deliveries fail as
    // `endpoint-deleted`; the log stays). After the deletion committed:
    // the package's store is its own connection.
    clientLifecycle.register({
      name: 'webhooks',
      afterDeletion: (clientId) => this.deleteAllEndpoints(clientId),
    });
    // GET /v1/access/clients shows how many endpoints each client has. With
    // WEBHOOKS=off the count is not registered, so it is absent (not 0).
    if (switchedOn('WEBHOOKS')) {
      clientCounts.register('webhookEndpoints', (ids, db) =>
        this.endpointCounts(ids, db),
      );
    }
  }

  /**
   * Endpoints per client, in one grouped query on the package's table
   * (`tenant` is the client's id). The package's tables have no row-level
   * security: the ids come from the caller's tenant's clients.
   */
  private async endpointCounts(
    clientIds: string[],
    db: Database | Transaction,
  ) {
    const rows = await db
      .select({ client: storeEndpoints.tenant, endpoints: count() })
      .from(storeEndpoints)
      .where(inArray(storeEndpoints.tenant, clientIds))
      .groupBy(storeEndpoints.tenant);
    return new Map(rows.map((row) => [row.client!, row.endpoints]));
  }

  /** Every endpoint of a client: listed a page at a time (the package's default is 50), then deleted. */
  private async deleteAllEndpoints(clientId: string) {
    const ids: string[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = await this.endpoints.list({
        tenant: clientId,
        limit: 100,
        offset,
      });
      ids.push(...page.map((endpoint) => endpoint.id));
      if (page.length < 100) {
        break;
      }
    }
    for (const id of ids) {
      await this.endpoints.delete(id, { tenant: clientId });
    }
  }

  private get db() {
    return database(this.txHost);
  }

  /** The declared event types, grouped (GET /v1/webhook-event-types). */
  eventTypes() {
    return { items: eventTypeGroups(this.options) };
  }

  /**
   * The owner for an administrator acting on `clientId`: a client of the
   * request's tenant (row-level security: another tenant's id is a 404), on
   * which the administrator has authority (they hold every permission the
   * client's roles give, as for rotating its key: its webhooks carry what
   * the client may read).
   */
  async delegated(
    user: UserPrincipal,
    clientId: string,
    ip?: string,
  ): Promise<WebhookOwner> {
    const [client] = await this.db
      .select({ id: apiClients.id, name: apiClients.name })
      .from(apiClients)
      .where(eq(apiClients.id, clientId));
    if (!client) {
      throw new NotFoundException(`API client ${clientId} not found.`);
    }
    await this.admin.assertAuthorityOver(
      user,
      await this.admin.permissionsOfHolder('client', client.id),
      client.name,
    );
    return { clientId: client.id, by: { user, ip } };
  }

  // Endpoints

  async createEndpoint(owner: WebhookOwner, dto: CreateEndpointDto) {
    const endpoint = await this.endpoints.create({
      url: dto.url,
      eventTypes: dto.eventTypes,
      description: dto.description ?? null,
      tenant: owner.clientId,
    });
    await this.audited(owner, 'webhook-endpoint.created', {
      endpointId: endpoint.id,
      url: endpoint.url,
      eventTypes: endpoint.eventTypes,
    });
    return endpoint;
  }

  async listEndpoints(owner: WebhookOwner) {
    return { items: await this.endpoints.list({ tenant: owner.clientId }) };
  }

  async getEndpoint(owner: WebhookOwner, id: string) {
    const endpoint = await this.endpoints.get(id, { tenant: owner.clientId });
    if (!endpoint) {
      throw new NotFoundException(`Webhook endpoint ${id} not found`);
    }
    return endpoint;
  }

  async updateEndpoint(
    owner: WebhookOwner,
    id: string,
    dto: UpdateEndpointDto,
  ) {
    const endpoint = await this.endpoints.update(id, dto, {
      tenant: owner.clientId,
    });
    await this.audited(owner, 'webhook-endpoint.updated', {
      endpointId: id,
      changed: Object.keys(dto),
    });
    return endpoint;
  }

  async deleteEndpoint(owner: WebhookOwner, id: string) {
    await this.endpoints.delete(id, { tenant: owner.clientId });
    await this.audited(owner, 'webhook-endpoint.deleted', { endpointId: id });
  }

  async rotateSecret(owner: WebhookOwner, id: string) {
    const secret = await this.endpoints.rotateSecret(id, {
      tenant: owner.clientId,
    });
    await this.audited(owner, 'webhook-endpoint.secret-rotated', {
      endpointId: id,
    });
    return { secret };
  }

  /**
   * Sends the reserved `webhook.test` event to this endpoint alone, whatever
   * it subscribed to, through the normal path: a message and a delivery in
   * the package's store, which the worker signs and sends as any other (its
   * retries too). The package's fan-out picks endpoints by subscription, so
   * the delivery is created here, as the fan-out does (the store contract's
   * `createDeliveries()`). Returns the delivery, pending.
   */
  async sendTest(owner: WebhookOwner, id: string) {
    const endpoint = await this.getEndpoint(owner, id);
    const now = Date.now();
    const [messageId, deliveryId] = await this.newIds();
    const message: WebhookMessage = {
      id: `msg_${messageId}`,
      type: TEST_EVENT_TYPE,
      tenant: owner.clientId,
      body: JSON.stringify({
        type: TEST_EVENT_TYPE,
        timestamp: new Date(now).toISOString(),
        data: { endpointId: endpoint.id, test: true },
      }),
      createdAt: now,
    };
    const delivery: WebhookDelivery = {
      id: `dlv_${deliveryId}`,
      messageId: message.id,
      endpointId: endpoint.id,
      tenant: owner.clientId,
      type: TEST_EVENT_TYPE,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: now,
      lastAttemptAt: null,
      lastStatusCode: null,
      lastError: null,
      failureReason: null,
      createdAt: now,
      completedAt: null,
    };
    await this.storage.deliveries.createDeliveries(message, [delivery]);
    this.worker.notify();
    await this.audited(owner, 'webhook-endpoint.tested', {
      endpointId: endpoint.id,
      deliveryId: delivery.id,
    });
    return deliveryView(delivery);
  }

  // Deliveries

  /** The client's deliveries, newest first, cursor-paged (DELIVERY_LIST). */
  async listDeliveries(owner: WebhookOwner, query: ListQuery) {
    const mine = eq(storeDeliveries.tenant, owner.clientId);
    const [rows, total] = await Promise.all([
      this.db
        .select({ ...deliveryColumns, ...DELIVERY_LIST.sortSelect(query) })
        .from(storeDeliveries)
        .where(and(mine, DELIVERY_LIST.where(query, storeDeliveries.id)))
        .orderBy(...pageOrder(storeDeliveries.id, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countPage(
        this.db,
        storeDeliveries,
        and(mine, DELIVERY_LIST.where(query)),
        query,
      ),
    ]);
    const page = DELIVERY_LIST.pick(toPage(rows, query, total), query);
    return { ...page, items: page.items.map(deliveryView) };
  }

  /**
   * One delivery: the package's (its message, every attempt), with the
   * request it last sent (the recording transport's) and the time all its
   * attempts took.
   */
  async getDelivery(owner: WebhookOwner, id: string) {
    const delivery = await this.deliveries.get(id, { tenant: owner.clientId });
    if (!delivery) {
      throw new NotFoundException(`Webhook delivery ${id} not found`);
    }
    const [request] = await this.db
      .select()
      .from(webhookDeliveryRequests)
      .where(eq(webhookDeliveryRequests.deliveryId, delivery.id));
    return {
      ...deliveryView(delivery),
      message: {
        ...delivery.message,
        createdAt: iso(delivery.message.createdAt),
      },
      history: delivery.history.map((attempt) => ({
        ...attempt,
        at: iso(attempt.at),
      })),
      durationMs: delivery.history.reduce(
        (sum, attempt) => sum + attempt.durationMs,
        0,
      ),
      lastRequest: request
        ? {
            attempt: request.attempt,
            sentAt: request.sentAt.toISOString(),
            headers: request.headers,
            signedWith:
              request.signedWith?.map(({ createdAt, expiresAt }) => ({
                createdAt: iso(createdAt),
                expiresAt: expiresAt === null ? null : iso(expiresAt),
              })) ?? null,
          }
        : null,
    };
  }

  async retry(owner: WebhookOwner, id: string) {
    const retried = await this.deliveries.retry(id, {
      tenant: owner.clientId,
    });
    await this.audited(owner, 'webhook-delivery.retried', {
      deliveryId: id,
      retried,
    });
    return { retried };
  }

  async retryFailed(owner: WebhookOwner, dto: RetryDeliveriesDto) {
    const since = dto.since === undefined ? undefined : new Date(dto.since);
    const retried = await this.deliveries.retry(
      { endpointId: dto.endpointId, status: 'failed', since },
      { tenant: owner.clientId },
    );
    await this.audited(owner, 'webhook-delivery.retried', {
      endpointId: dto.endpointId ?? null,
      since: dto.since ?? null,
      retried,
    });
    return { retried };
  }

  /** An administrator's change, audited as theirs on the client (a client's own isn't). */
  private async audited(
    owner: WebhookOwner,
    action: string,
    details: Record<string, unknown>,
  ) {
    if (!owner.by) {
      return;
    }
    await this.audit.record(owner.by.user, {
      action,
      targetType: 'client',
      targetId: owner.clientId,
      details,
      ip: owner.by.ip,
    });
  }

  /**
   * Two time-ordered ids shaped as the package's own (`msg_…`, `dlv_…`: a
   * UUIDv7 without its dashes), from PostgreSQL's uuidv7(): the package
   * doesn't export its generator.
   */
  private async newIds(): Promise<[string, string]> {
    const result = await this.db.execute<{ a: string; b: string }>(
      sql`select uuidv7()::text as a, uuidv7()::text as b`,
    );
    const [row] = (result as unknown as { rows: { a: string; b: string }[] })
      .rows;
    const bare = (id: string) => id.replaceAll('-', '');
    return [bare(row!.a), bare(row!.b)];
  }
}
