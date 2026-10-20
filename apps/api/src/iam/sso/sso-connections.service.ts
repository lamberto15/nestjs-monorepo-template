import { X509Certificate } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { Queue } from 'bullmq';
import { and, asc, eq } from 'drizzle-orm';
import type { CoreEnv } from '../../core/config/core.env.js';
import { pgErrorCode, UNIQUE_VIOLATION } from '../../core/database/errors.js';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { EncryptionService } from '../../core/encryption/encryption.service.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { withTenant } from '../../core/tenancy/tenant-job.js';
import { AuditService } from '../audit/audit.service.js';
import type { Principal, UserPrincipal } from '../auth/principal.js';
import type { IamEnv } from '../iam.env.js';
import type { CreateConnection, UpdateConnection } from './sso.schemas.js';
import { SSO_QUEUE, type SsoJob } from './sso.queue.js';
import { ssoConnections } from './sso.tables.js';

export type SsoConnection = typeof ssoConnections.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const OIDC_FIELDS = ['issuer', 'clientId', 'clientSecret'] as const;
const SAML_FIELDS = [
  'idpEntityId',
  'idpSsoUrl',
  'idpCertificates',
  'allowIdpInitiated',
] as const;

/**
 * A tenant's SSO connections (docs/auth.md, "Enterprise SSO"): created off,
 * changed and deleted by its administrators (`Access.manageSso`), each
 * change audited in its transaction. The OIDC client secret is encrypted
 * (docs/encryption.md) and never read back out; the issuer's discovery
 * document is fetched on the queue (SsoProcessor), never in a request.
 */
@Injectable()
export class SsoConnectionsService {
  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly audit: AuditService,
    private readonly encryption: EncryptionService,
    private readonly tenancy: Tenancy,
    private readonly config: ConfigService<IamEnv & CoreEnv, true>,
    @InjectQueue(SSO_QUEUE) private readonly queue: Queue<SsoJob>,
  ) {}

  private get db() {
    return database(this.txHost);
  }

  async list() {
    const rows = await this.db
      .select()
      .from(ssoConnections)
      .orderBy(asc(ssoConnections.name));
    return rows.map((row) => this.view(row));
  }

  async get(id: string) {
    return this.view(await this.find(id));
  }

  async create(actor: UserPrincipal, input: CreateConnection, ip?: string) {
    const values =
      input.protocol === 'oidc'
        ? {
            issuer: this.checkUrl(input.issuer, 'issuer'),
            clientId: input.clientId,
            clientSecret: this.encryption.encrypt(
              ssoConnections.clientSecret,
              input.clientSecret,
            ),
          }
        : {
            idpEntityId: input.idpEntityId,
            idpSsoUrl: this.checkUrl(input.idpSsoUrl, 'idpSsoUrl'),
            idpCertificates: input.idpCertificates,
            allowIdpInitiated: input.allowIdpInitiated ?? false,
          };
    const row = await inTransaction(this.txHost, async (tx) => {
      const [created] = await tx
        .insert(ssoConnections)
        .values({
          name: input.name,
          protocol: input.protocol,
          enabled: input.enabled ?? false,
          jitProvisioning: input.jitProvisioning ?? false,
          ...values,
        })
        .returning()
        .catch((error: unknown) => {
          throw isUniqueViolation(error) ? nameTaken(input.name) : error;
        });
      await this.audit.record(
        actor,
        {
          action: 'sso.connection-created',
          targetType: 'sso-connection',
          targetId: created.id,
          details: {
            name: created.name,
            protocol: created.protocol,
            enabled: created.enabled,
            jitProvisioning: created.jitProvisioning,
          },
          ip,
        },
        tx,
      );
      return created;
    });
    if (row.protocol === 'oidc') {
      await this.queueDiscovery(row.id);
    }
    return this.view(row);
  }

  async update(
    actor: UserPrincipal,
    id: string,
    changes: UpdateConnection,
    ip?: string,
  ) {
    const before = await this.find(id);
    const other = before.protocol === 'oidc' ? SAML_FIELDS : OIDC_FIELDS;
    const wrong = other.filter((field) => changes[field] !== undefined);
    if (wrong.length > 0) {
      throw new BadRequestException({
        code: 'validation_failed',
        message: `A ${before.protocol} connection has no ${wrong.join(', ')}.`,
        errors: wrong.map((path) => ({
          path,
          message: `Not a field of a ${before.protocol} connection.`,
        })),
      });
    }
    const issuerChanged =
      changes.issuer !== undefined && changes.issuer !== before.issuer;
    const row = await inTransaction(this.txHost, async (tx) => {
      const [updated] = await tx
        .update(ssoConnections)
        .set({
          ...(changes.name !== undefined && { name: changes.name }),
          ...(changes.enabled !== undefined && { enabled: changes.enabled }),
          ...(changes.jitProvisioning !== undefined && {
            jitProvisioning: changes.jitProvisioning,
          }),
          ...(changes.issuer !== undefined && {
            issuer: this.checkUrl(changes.issuer, 'issuer'),
          }),
          // A new issuer: its document is fetched again before a sign-in.
          ...(issuerChanged && {
            oidcMetadata: null,
            metadataFetchedAt: null,
            metadataError: null,
          }),
          ...(changes.clientId !== undefined && { clientId: changes.clientId }),
          ...(changes.clientSecret !== undefined && {
            clientSecret: this.encryption.encrypt(
              ssoConnections.clientSecret,
              changes.clientSecret,
            ),
          }),
          ...(changes.idpEntityId !== undefined && {
            idpEntityId: changes.idpEntityId,
          }),
          ...(changes.idpSsoUrl !== undefined && {
            idpSsoUrl: this.checkUrl(changes.idpSsoUrl, 'idpSsoUrl'),
          }),
          ...(changes.idpCertificates !== undefined && {
            idpCertificates: changes.idpCertificates,
          }),
          ...(changes.allowIdpInitiated !== undefined && {
            allowIdpInitiated: changes.allowIdpInitiated,
          }),
        })
        .where(eq(ssoConnections.id, id))
        .returning()
        .catch((error: unknown) => {
          throw isUniqueViolation(error) ? nameTaken(changes.name!) : error;
        });
      await this.audit.record(
        actor,
        {
          action: 'sso.connection-updated',
          targetType: 'sso-connection',
          targetId: id,
          details: {
            name: updated.name,
            // Which fields changed, never a secret's value.
            changed: Object.keys(changes).filter(
              (key) => changes[key as keyof UpdateConnection] !== undefined,
            ),
            ...(changes.enabled !== undefined && {
              enabled: { from: before.enabled, to: changes.enabled },
            }),
          },
          ip,
        },
        tx,
      );
      return updated;
    });
    if (issuerChanged) {
      await this.queueDiscovery(id);
    }
    return this.view(row);
  }

  async remove(actor: UserPrincipal, id: string, ip?: string) {
    await inTransaction(this.txHost, async (tx) => {
      const [row] = await tx
        .delete(ssoConnections)
        .where(eq(ssoConnections.id, id))
        .returning();
      if (!row) {
        throw notFound(id);
      }
      await this.audit.record(
        actor,
        {
          action: 'sso.connection-deleted',
          targetType: 'sso-connection',
          targetId: id,
          details: { name: row.name, protocol: row.protocol },
          ip,
        },
        tx,
      );
    });
  }

  /** Fetches an OIDC connection's discovery document again (202: on the queue). */
  async refreshMetadata(id: string) {
    const row = await this.find(id);
    if (row.protocol !== 'oidc') {
      throw new BadRequestException(
        'Only an OpenID Connect connection has a discovery document.',
      );
    }
    await this.queueDiscovery(id);
  }

  /**
   * The job's work (SsoProcessor, in the connection's tenant): stores the
   * discovery document, or why it couldn't be had, and audits the outcome.
   */
  async storeDiscovery(
    actor: Principal,
    id: string,
    discover: (
      issuer: string,
      clientId: string,
    ) => Promise<Record<string, unknown>>,
  ) {
    const [row] = await this.db
      .select()
      .from(ssoConnections)
      .where(eq(ssoConnections.id, id));
    if (!row || row.protocol !== 'oidc' || !row.issuer || !row.clientId) {
      return;
    }
    let metadata: Record<string, unknown> | null = null;
    let error: string | null = null;
    try {
      metadata = await discover(row.issuer, row.clientId);
    } catch (failure) {
      error = (failure as Error).message.slice(0, 500);
    }
    await inTransaction(this.txHost, async (tx) => {
      // Only for the issuer it was fetched for: a change meanwhile queued another.
      await tx
        .update(ssoConnections)
        .set(
          metadata
            ? {
                oidcMetadata: metadata,
                metadataFetchedAt: new Date(),
                metadataError: null,
              }
            : { metadataError: error },
        )
        .where(
          and(
            eq(ssoConnections.id, id),
            eq(ssoConnections.issuer, row.issuer!),
          ),
        );
      await this.audit.record(
        actor,
        {
          action: metadata
            ? 'sso.metadata-fetched'
            : 'sso.metadata-fetch-failed',
          targetType: 'sso-connection',
          targetId: id,
          details: { issuer: row.issuer, ...(error && { error }) },
        },
        tx,
      );
    });
  }

  /**
   * The enabled connection `connectionId` of the active tenant `tenantId`,
   * read in that tenant's scope, or null: no such tenant, no such
   * connection in it, or one that is off. The public sign-in routes answer
   * all of these alike.
   */
  async resolveEnabled(tenantId: string, connectionId: string) {
    if (!UUID.test(tenantId) || !UUID.test(connectionId)) {
      return null;
    }
    const tenant = await this.tenancy.find(tenantId.toLowerCase());
    if (!tenant?.active) {
      return null;
    }
    const [row] = await this.tenancy.run(tenant.id, () =>
      this.db
        .select()
        .from(ssoConnections)
        .where(
          and(
            eq(ssoConnections.id, connectionId.toLowerCase()),
            eq(ssoConnections.enabled, true),
          ),
        ),
    );
    return row ?? null;
  }

  /** The OIDC client secret, for the token request (in the connection's tenant). */
  clientSecret(connection: SsoConnection) {
    return this.encryption.decrypt(
      ssoConnections.clientSecret,
      connection.clientSecret,
      connection.tenantId,
    );
  }

  /** The URLs of a connection, under APP_URL. */
  urls(connection: Pick<SsoConnection, 'id' | 'tenantId'>) {
    const base = `${this.config.get('APP_URL', { infer: true })}/v1/auth/sso/${connection.tenantId}/${connection.id}`;
    return {
      login: `${base}/login`,
      oidcCallback: `${base}/oidc/callback`,
      samlAcs: `${base}/saml/acs`,
      samlComplete: `${base}/saml/complete`,
      samlMetadata: `${base}/saml/metadata`,
    };
  }

  private async queueDiscovery(connectionId: string) {
    await this.queue.add(
      'oidc-discovery',
      withTenant({ kind: 'oidc-discovery' as const, connectionId }),
    );
  }

  /**
   * An URL the app will reach or send browsers to: https, or http on a
   * loopback host with SSO_ALLOW_LOOPBACK (development, tests). Where it
   * resolves to is checked when it is fetched (core/http/safe-fetch.ts).
   */
  private checkUrl(value: string, field: string) {
    const url = new URL(value);
    const loopback = this.config.get('SSO_ALLOW_LOOPBACK', { infer: true });
    if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
      throw new BadRequestException({
        code: 'validation_failed',
        message: `${field} must be an https:// URL.`,
        errors: [{ path: field, message: 'An https:// URL.' }],
      });
    }
    if (url.username || url.password) {
      throw new BadRequestException({
        code: 'validation_failed',
        message: `${field} carries credentials.`,
        errors: [{ path: field, message: 'No user name or password in it.' }],
      });
    }
    return value;
  }

  private async find(id: string) {
    const [row] = await this.db
      .select()
      .from(ssoConnections)
      .where(eq(ssoConnections.id, id));
    if (!row) {
      throw notFound(id);
    }
    return row;
  }

  /** What an administrator sees: never the client secret. */
  private view(row: SsoConnection) {
    const urls = this.urls(row);
    return {
      id: row.id,
      name: row.name,
      protocol: row.protocol,
      enabled: row.enabled,
      jitProvisioning: row.jitProvisioning,
      loginUrl: urls.login,
      oidc:
        row.protocol === 'oidc'
          ? {
              issuer: row.issuer ?? '',
              clientId: row.clientId ?? '',
              redirectUri: urls.oidcCallback,
              metadataFetchedAt: row.metadataFetchedAt,
              metadataError: row.metadataError,
            }
          : null,
      saml:
        row.protocol === 'saml'
          ? {
              idpEntityId: row.idpEntityId ?? '',
              idpSsoUrl: row.idpSsoUrl ?? '',
              idpCertificates: row.idpCertificates.map(describeCertificate),
              allowIdpInitiated: row.allowIdpInitiated,
              spEntityId: urls.samlMetadata,
              acsUrl: urls.samlAcs,
              metadataUrl: urls.samlMetadata,
            }
          : null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

function describeCertificate(pem: string) {
  const certificate = new X509Certificate(pem);
  return {
    subject: certificate.subject,
    notAfter: new Date(certificate.validTo).toISOString(),
    fingerprint256: certificate.fingerprint256,
  };
}

const isUniqueViolation = (error: unknown) =>
  pgErrorCode(error) === UNIQUE_VIOLATION;

const notFound = (id: string) =>
  new NotFoundException(`SSO connection ${id} not found.`);

const nameTaken = (name: string) =>
  new ConflictException({
    code: 'sso_connection_name_taken',
    message: `A connection named "${name}" exists.`,
    errors: [{ path: 'name', message: `"${name}" is taken.` }],
  });
