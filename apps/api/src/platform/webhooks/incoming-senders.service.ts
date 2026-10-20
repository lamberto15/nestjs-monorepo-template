import { Injectable, NotFoundException } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, asc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { requireTenantId } from '../../core/tenancy/tenant-scope.js';
import { uniqueToConflict } from '../../iam/access/api-clients.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { Principal } from '../../iam/auth/principal.js';
import type {
  CreateIncomingSenderDto,
  RotateIncomingSenderDto,
  UpdateIncomingSenderDto,
} from './incoming-sender.schemas.js';
import {
  generateSenderSecret,
  SenderSecretCipher,
} from './incoming-sender-secrets.js';
import { incomingWebhookSenders } from './incoming-senders.tables.js';
import type { ResolvedSender } from './tenant-sender.scheme.js';

type Sender = typeof incomingWebhookSenders.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where a tenant's sender POSTs, under the API origin. */
export const senderPath = (tenantId: string, name: string) =>
  `/v1/webhooks/tenants/${tenantId}/senders/${name}`;

const view = (sender: Sender, now = new Date()) => ({
  id: sender.id,
  name: sender.name,
  description: sender.description,
  enabled: sender.enabled,
  path: senderPath(sender.tenantId, sender.name),
  // Only while the old secret still verifies.
  previousSecretExpiresAt:
    sender.previousSecret &&
    sender.previousSecretExpiresAt &&
    sender.previousSecretExpiresAt > now
      ? sender.previousSecretExpiresAt.toISOString()
      : null,
  createdAt: sender.createdAt.toISOString(),
  updatedAt: sender.updatedAt.toISOString(),
});

/**
 * The senders of a tenant's incoming webhooks: managed by its
 * administrators (`Access.manageClients`: a sender is a system, as an API
 * client is), found by the receiver route inside the tenant the URL names.
 * Each write is one transaction with its audit entry, which never carries a
 * secret. docs/webhooks-and-realtime.md, "Incoming webhooks of a tenant".
 */
@Injectable()
export class IncomingSendersService {
  private readonly cipher = SenderSecretCipher.fromEnv();

  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly audit: AuditService,
    private readonly tenancy: Tenancy,
  ) {}

  async list() {
    const rows = await this.db
      .select()
      .from(incomingWebhookSenders)
      .orderBy(asc(incomingWebhookSenders.name));
    return { items: rows.map((row) => view(row)) };
  }

  async get(id: string) {
    return view(await this.find(id));
  }

  /** A new sender and its secret, shown this once. */
  async create(
    principal: Principal,
    dto: CreateIncomingSenderDto,
    ip?: string,
  ) {
    const id = randomUUID();
    const secret = generateSenderSecret();
    const row = await inTransaction(this.txHost, async (tx) => {
      const [created] = await tx
        .insert(incomingWebhookSenders)
        .values({
          id,
          name: dto.name,
          description: dto.description ?? null,
          secret: this.cipher.seal(id, secret),
        })
        .returning();
      await this.audit.record(
        principal,
        {
          action: 'webhookSender.created',
          targetType: 'webhookSender',
          targetId: id,
          details: { name: dto.name },
          ip,
        },
        tx,
      );
      return created!;
    }).catch((error: unknown) => {
      throw uniqueToConflict(
        error,
        `A webhook sender named "${dto.name}" exists.`,
      );
    });
    return { ...view(row), secret };
  }

  async update(
    principal: Principal,
    id: string,
    dto: UpdateIncomingSenderDto,
    ip?: string,
  ) {
    const before = await this.find(id);
    const values = Object.fromEntries(
      Object.entries(dto).filter(([, value]) => value !== undefined),
    ) as UpdateIncomingSenderDto;
    if (Object.keys(values).length === 0) {
      return view(before);
    }
    const row = await inTransaction(this.txHost, async (tx) => {
      const [updated] = await tx
        .update(incomingWebhookSenders)
        .set(values)
        .where(eq(incomingWebhookSenders.id, id))
        .returning();
      await this.audit.record(
        principal,
        {
          action: 'webhookSender.updated',
          targetType: 'webhookSender',
          targetId: id,
          details: { name: before.name, changed: Object.keys(values) },
          ip,
        },
        tx,
      );
      return updated!;
    });
    return view(row);
  }

  /** A new secret, shown this once; the old one verifies for `graceSeconds` more. */
  async rotate(
    principal: Principal,
    id: string,
    dto: RotateIncomingSenderDto,
    ip?: string,
  ) {
    const before = await this.find(id);
    const secret = generateSenderSecret();
    const graceEnds =
      dto.graceSeconds > 0
        ? new Date(Date.now() + dto.graceSeconds * 1000)
        : null;
    const row = await inTransaction(this.txHost, async (tx) => {
      const [updated] = await tx
        .update(incomingWebhookSenders)
        .set({
          secret: this.cipher.seal(id, secret),
          // Sealed for this row's id already: it moves as it is.
          previousSecret: graceEnds ? before.secret : null,
          previousSecretExpiresAt: graceEnds,
        })
        .where(eq(incomingWebhookSenders.id, id))
        .returning();
      await this.audit.record(
        principal,
        {
          action: 'webhookSender.secret-rotated',
          targetType: 'webhookSender',
          targetId: id,
          details: {
            name: before.name,
            previousSecretEnds: graceEnds?.toISOString() ?? null,
          },
          ip,
        },
        tx,
      );
      return updated!;
    });
    return { ...view(row), secret };
  }

  async remove(principal: Principal, id: string, ip?: string) {
    const before = await this.find(id);
    await inTransaction(this.txHost, async (tx) => {
      await tx
        .delete(incomingWebhookSenders)
        .where(eq(incomingWebhookSenders.id, id));
      await this.audit.record(
        principal,
        {
          action: 'webhookSender.deleted',
          targetType: 'webhookSender',
          targetId: id,
          details: { name: before.name },
          ip,
        },
        tx,
      );
    });
  }

  /**
   * The enabled sender `name` of tenant `tenantId`, with the secrets that
   * verify now, or null: no such tenant (or deactivated), no such sender in
   * it, a disabled one, or a secret that does not open. The lookup runs in
   * that tenant's scope, so a sender of another tenant is never visible
   * under this URL; the caller answers all of these alike (401).
   */
  async resolve(
    tenantId: string,
    name: string,
  ): Promise<ResolvedSender | null> {
    if (!UUID.test(tenantId)) {
      return null;
    }
    const tenant = await this.tenancy.find(tenantId.toLowerCase());
    if (!tenant?.active) {
      return null;
    }
    const [row] = await this.tenancy.run(tenant.id, () =>
      this.db
        .select()
        .from(incomingWebhookSenders)
        .where(
          and(
            eq(incomingWebhookSenders.name, name),
            eq(incomingWebhookSenders.enabled, true),
          ),
        ),
    );
    if (!row) {
      return null;
    }
    const secrets = [
      this.cipher.open(row.id, row.secret),
      row.previousSecret &&
      row.previousSecretExpiresAt &&
      row.previousSecretExpiresAt > new Date()
        ? this.cipher.open(row.id, row.previousSecret)
        : undefined,
    ].filter((secret): secret is string => !!secret);
    return secrets.length > 0
      ? { id: row.id, tenantId: row.tenantId, name: row.name, secrets }
      : null;
  }

  private async find(id: string): Promise<Sender> {
    // The policies show this tenant's rows only; the tenant is said anyway.
    const [row] = await this.db
      .select()
      .from(incomingWebhookSenders)
      .where(
        and(
          eq(incomingWebhookSenders.id, id),
          eq(incomingWebhookSenders.tenantId, requireTenantId()),
        ),
      );
    if (!row) {
      throw new NotFoundException(`Webhook sender ${id} not found.`);
    }
    return row;
  }
}
