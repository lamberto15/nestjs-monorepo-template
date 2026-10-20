import { randomBytes } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { Queue } from 'bullmq';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { pgErrorCode, UNIQUE_VIOLATION } from '../../core/database/errors.js';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { withTenant } from '../../core/tenancy/tenant-job.js';
import { AuditService } from '../audit/audit.service.js';
import type { Principal, UserPrincipal } from '../auth/principal.js';
import {
  SSO_QUEUE,
  SSO_TXT_RESOLVER,
  type SsoJob,
  type TxtResolver,
} from './sso.queue.js';
import { ssoDomainRoutes, ssoDomains } from './sso.tables.js';

/** Where the TXT record goes, under the domain. */
export const VERIFICATION_RECORD = '_sso-verification';
/** What its value starts with. */
const VALUE_PREFIX = 'sso-verification=';

type Domain = typeof ssoDomains.$inferSelect;

/** The domain part of an address, lower case; undefined for anything that isn't one. */
export function emailDomain(email: string | undefined | null) {
  const at = email?.lastIndexOf('@') ?? -1;
  return at > 0 ? email!.slice(at + 1).toLowerCase() : undefined;
}

/**
 * The email domains a tenant proved it controls (docs/auth.md, "Verified
 * domains"): a TXT record `_sso-verification.<domain>` holding the value
 * the tenant was given. The lookup runs on the queue (SsoProcessor), never
 * in the request. An SSO connection may assert, and SCIM provision, only
 * addresses of these domains.
 */
@Injectable()
export class SsoDomainsService {
  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly audit: AuditService,
    @Inject(SSO_TXT_RESOLVER) private readonly dns: TxtResolver,
    @InjectQueue(SSO_QUEUE) private readonly queue: Queue<SsoJob>,
  ) {}

  private get db() {
    return database(this.txHost);
  }

  async list() {
    const rows = await this.db
      .select()
      .from(ssoDomains)
      .orderBy(asc(ssoDomains.domain));
    return rows.map(view);
  }

  /** Adds a domain to verify: the record to publish, then POST …/verify. */
  async create(actor: UserPrincipal, domain: string, ip?: string) {
    const row = await inTransaction(this.txHost, async (tx) => {
      const [created] = await tx
        .insert(ssoDomains)
        .values({
          domain,
          verificationToken: `${VALUE_PREFIX}${randomBytes(24).toString('base64url')}`,
        })
        .returning()
        .catch((error: unknown) => {
          throw pgErrorCode(error) === UNIQUE_VIOLATION
            ? new ConflictException({
                code: 'sso_domain_exists',
                message: `${domain} is listed already.`,
                errors: [{ path: 'domain', message: 'Listed already.' }],
              })
            : error;
        });
      await this.audit.record(
        actor,
        {
          action: 'sso.domain-added',
          targetType: 'sso-domain',
          targetId: created.id,
          details: { domain },
          ip,
        },
        tx,
      );
      return created;
    });
    return view(row);
  }

  async remove(actor: UserPrincipal, id: string, ip?: string) {
    await inTransaction(this.txHost, async (tx) => {
      const [row] = await tx
        .delete(ssoDomains)
        .where(eq(ssoDomains.id, id))
        .returning();
      if (!row) {
        throw notFound(id);
      }
      // Global: filtered by the tenant here (no row-level security).
      await tx
        .delete(ssoDomainRoutes)
        .where(
          and(
            eq(ssoDomainRoutes.domain, row.domain),
            eq(ssoDomainRoutes.tenantId, row.tenantId),
          ),
        );
      await this.audit.record(
        actor,
        {
          action: 'sso.domain-removed',
          targetType: 'sso-domain',
          targetId: id,
          details: { domain: row.domain },
          ip,
        },
        tx,
      );
    });
  }

  /** Queues the DNS check (202). */
  async requestVerification(id: string) {
    await this.find(id);
    await this.queue.add(
      'domain-verification',
      withTenant({ kind: 'domain-verification' as const, domainId: id }),
    );
  }

  /**
   * The job's work: looks the TXT record up and records the outcome. A
   * domain stays verified once it was (removing it is the way back); a
   * failed check of a verified domain records only the error.
   */
  async verify(actor: Principal, id: string) {
    const [row] = await this.db
      .select()
      .from(ssoDomains)
      .where(eq(ssoDomains.id, id));
    if (!row) {
      return;
    }
    let found = false;
    let error: string | null = null;
    try {
      const records = await this.dns.resolveTxt(
        `${VERIFICATION_RECORD}.${row.domain}`,
      );
      found = records.some(
        (chunks) => chunks.join('') === row.verificationToken,
      );
      if (!found) {
        error = 'The TXT record was not found or holds another value.';
      }
    } catch (failure) {
      error = `DNS lookup failed: ${(failure as { code?: string }).code ?? (failure as Error).message}`;
    }
    const now = new Date();
    await inTransaction(this.txHost, async (tx) => {
      await tx
        .update(ssoDomains)
        .set({
          lastCheckedAt: now,
          lastError: found ? null : error,
          ...(found && !row.verifiedAt && { verifiedAt: now }),
        })
        .where(eq(ssoDomains.id, id));
      if (found) {
        // The sign-in page's lookup (global; kept with the verification).
        await tx
          .insert(ssoDomainRoutes)
          .values({ domain: row.domain, tenantId: row.tenantId })
          .onConflictDoNothing();
      }
      if (found && !row.verifiedAt) {
        await this.audit.record(
          actor,
          {
            action: 'sso.domain-verified',
            targetType: 'sso-domain',
            targetId: id,
            details: { domain: row.domain },
          },
          tx,
        );
      }
    });
  }

  /** Whether the current tenant verified `domain`. */
  async isVerified(domain: string | undefined) {
    if (!domain) {
      return false;
    }
    const [row] = await this.db
      .select({ id: ssoDomains.id })
      .from(ssoDomains)
      .where(
        and(eq(ssoDomains.domain, domain), isNotNull(ssoDomains.verifiedAt)),
      );
    return !!row;
  }

  private async find(id: string) {
    const [row] = await this.db
      .select()
      .from(ssoDomains)
      .where(eq(ssoDomains.id, id));
    if (!row) {
      throw notFound(id);
    }
    return row;
  }
}

function view(row: Domain) {
  return {
    id: row.id,
    domain: row.domain,
    verified: row.verifiedAt !== null,
    verifiedAt: row.verifiedAt,
    lastCheckedAt: row.lastCheckedAt,
    lastError: row.lastError,
    record: {
      type: 'TXT' as const,
      name: `${VERIFICATION_RECORD}.${row.domain}`,
      value: row.verificationToken,
    },
    createdAt: row.createdAt,
  };
}

const notFound = (id: string) =>
  new NotFoundException(`Domain ${id} not found.`);
