import { Injectable } from '@nestjs/common';
import { type NewWebhookMessage, Webhooks } from '@nestjs/webhooks';
import { and, eq, inArray } from 'drizzle-orm';
import type { Transaction } from '../../core/database/drizzle.js';
import { AccessService } from '../../iam/access/access.service.js';
import type { ClientPrincipal } from '../../iam/auth/principal.js';
import { apiClients } from '../../iam/iam.tables.js';
import { webhookClientScopes } from './webhooks.tables.js';

/** One record's webhook event, before it is addressed and redacted. */
export interface RecordWebhookEvent {
  /** `<item>.created`… */
  type: string;
  /** The record's CASL subject (`Note`): what each receiver must `read`. */
  subject: string;
  /** The record as stored: its owner, its tenant and what the subject's conditions read. */
  row: { ownerId: string; tenantId: string } & Record<string, unknown>;
  /** What is sent, before each receiver's field-level redaction. */
  data: Record<string, unknown>;
}

const CLIENT = 'client:';

/**
 * Who receives a record's webhook, and what (docs/webhooks-and-realtime.md,
 * "Subscriber scope"). The package routes a message by its `tenant`, which
 * is an API client's id, so each receiver gets a message of its own:
 *
 * - the client that owns the record (`ownerId` `client:<id>`), as always;
 * - each other active client of the record's tenant whose scope is
 *   `tenant` (webhookClientScopes), only when its own ability may `read`
 *   this record (roles, conditions; the recycle bin aside: a deletion is
 *   told to whoever could read the record before it).
 *
 * Each message's data is redacted to the fields its receiver may read.
 * Never a broad tenant id: a client of another tenant is out of the query
 * (row-level security, and the record's tenant named in it), and a client
 * that may not read the record gets nothing. Dispatched through `tx`: the
 * messages exist if and only if the write commits (the outbox), and the
 * package's retries and per-endpoint idempotency apply to each.
 */
@Injectable()
export class RecordWebhooks {
  constructor(
    private readonly webhooks: Webhooks<Transaction>,
    private readonly access: AccessService,
  ) {}

  async dispatch(tx: Transaction, events: readonly RecordWebhookEvent[]) {
    if (events.length === 0) {
      return;
    }
    const subscribers = await this.tenantSubscribers(tx, events);
    const messages: NewWebhookMessage[] = [];
    for (const event of events) {
      const owner = event.row.ownerId.startsWith(CLIENT)
        ? event.row.ownerId.slice(CLIENT.length)
        : null;
      if (owner) {
        messages.push(
          await this.message(event, {
            kind: 'client',
            id: owner,
            name: owner,
            tenantId: event.row.tenantId,
          }),
        );
      }
      // Whether it may read the record, recycle bin aside (AccessService.can
      // refuses a soft-deleted one but to restore).
      const record = { ...event.row, deletedAt: null };
      for (const client of subscribers) {
        if (
          client.id === owner ||
          client.tenantId !== event.row.tenantId ||
          !(await this.access.can(client, 'read', event.subject, record))
        ) {
          continue;
        }
        messages.push(await this.message(event, client));
      }
    }
    if (messages.length > 0) {
      await this.webhooks.dispatch(tx, messages);
    }
  }

  /** The active clients of the events' tenants that chose the `tenant` scope. */
  private async tenantSubscribers(
    tx: Transaction,
    events: readonly RecordWebhookEvent[],
  ): Promise<ClientPrincipal[]> {
    const tenants = [...new Set(events.map((event) => event.row.tenantId))];
    const rows = await tx
      .select({
        id: apiClients.id,
        name: apiClients.name,
        tenantId: apiClients.tenantId,
      })
      .from(webhookClientScopes)
      .innerJoin(
        apiClients,
        and(
          eq(apiClients.tenantId, webhookClientScopes.tenantId),
          eq(apiClients.id, webhookClientScopes.clientId),
        ),
      )
      .where(
        and(
          eq(webhookClientScopes.scope, 'tenant'),
          inArray(webhookClientScopes.tenantId, tenants),
          eq(apiClients.active, true),
        ),
      );
    return rows.map((row) => ({ kind: 'client', ...row }));
  }

  private async message(
    event: RecordWebhookEvent,
    receiver: ClientPrincipal,
  ): Promise<NewWebhookMessage> {
    return {
      type: event.type,
      tenant: receiver.id,
      data: await this.access.redact(
        receiver,
        'read',
        event.subject,
        event.data,
      ),
    };
  }
}
