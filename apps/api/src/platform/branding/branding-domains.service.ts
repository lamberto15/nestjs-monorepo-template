import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import type { CoreEnv } from '../../core/config/core.env.js';
import { REDIS } from '../../core/redis/redis.js';
import { pgErrorCode, UNIQUE_VIOLATION } from '../../core/database/errors.js';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { tenants } from '../../core/tenancy/tenancy.tables.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { withTenant } from '../../core/tenancy/tenant-job.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { HostTenants } from '../../iam/auth/host-tenant.js';
import type { Principal } from '../../iam/auth/principal.js';
import type { PlatformEnv } from '../platform.env.js';
import {
  tenantDomainRoutes,
  tenantDomains,
} from './branding-domains.tables.js';
import {
  CUSTOM_DOMAINS,
  CUSTOM_DOMAINS_TXT_RESOLVER,
  type CustomDomainJob,
  type TxtResolver,
} from './branding-domains.queue.js';
import type { PublicBrand } from './branding.schemas.js';
import { BrandingService } from './branding.service.js';
import { type HostnameRefusal, normalizeHostname } from './hostname.js';

/** Where the TXT record goes, under the hostname. */
export const DOMAIN_VERIFICATION_RECORD = '_app-verification';
/** What its value starts with. */
const VALUE_PREFIX = 'app-verification=';

/** DNS answers that say the record is not there (not a lookup that failed). */
const GONE = new Set(['ENOTFOUND', 'ENODATA']);

/**
 * A hostname no tenant routes, remembered in Redis (shared by the replicas)
 * for 30 s: a flood of requests or TLS asks for the same unknown name reads
 * the database once. Only the absence is cached: a removed domain still
 * stops at once, and verifying one deletes its entry.
 */
const UNKNOWN_HOST_SECONDS = 30;
const unknownHostKey = (hostname: string) =>
  `custom-domains:unknown:${hostname}`;

const REFUSALS: Record<HostnameRefusal, string> = {
  not_a_hostname: 'Not a hostname: a domain name such as app.example.com.',
  ip_address: 'An IP address, not a domain name.',
  port: 'A hostname takes no port.',
  reserved:
    'Under a top-level name that is not public (.local, .internal, .test…).',
  app_domain: "The app's own domain, or one under it.",
};

type Domain = typeof tenantDomains.$inferSelect;

/**
 * A tenant's custom domains (docs/branding.md, "Custom domains"): a
 * hostname the tenant's people reach the app on, proved by a TXT record
 * `_app-verification.<hostname>` holding the value the tenant was given.
 * Verified only while the record resolves: the check runs on the queue
 * when asked, and every night (BrandingDomainsJob), and a record gone
 * stops the routing at once. A verified hostname routes to its tenant
 * (`tenant_domain_routes`): the brand before sign-in, the session's tenant
 * on that host (SessionAuth, through HOST_TENANTS) and the edge's TLS
 * check (Caddy's on-demand `ask`). Off unless CUSTOM_DOMAINS=on.
 */
@Injectable()
export class BrandingDomainsService implements HostTenants {
  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly audit: AuditService,
    private readonly branding: BrandingService,
    private readonly tenancy: Tenancy,
    private readonly config: ConfigService<PlatformEnv & CoreEnv, true>,
    @Inject(CUSTOM_DOMAINS_TXT_RESOLVER) private readonly dns: TxtResolver,
    @InjectQueue(CUSTOM_DOMAINS) private readonly queue: Queue<CustomDomainJob>,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  private get db() {
    return database(this.txHost);
  }

  get enabled() {
    return this.config.get('CUSTOM_DOMAINS', { infer: true });
  }

  /** The deployment's own hosts (APP_URL's, WEB_URL's): never a custom domain. */
  private appHosts() {
    const urls = [
      this.config.get('APP_URL', { infer: true }),
      this.config.get('WEB_URL', { infer: true }),
    ];
    return urls
      .filter((url): url is string => !!url)
      .map((url) => new URL(url).hostname);
  }

  async list() {
    const rows = await this.db
      .select()
      .from(tenantDomains)
      .orderBy(asc(tenantDomains.hostname));
    return { enabled: this.enabled, domains: rows.map(view) };
  }

  /** Adds a hostname to verify: the record to publish, then POST …/verify. */
  async create(actor: Principal, input: string, ip?: string) {
    this.assertEnabled();
    await this.branding.assertEditable(actor);
    const checked = normalizeHostname(input, this.appHosts());
    if ('refused' in checked) {
      throw new BadRequestException({
        code: 'invalid_hostname',
        message: REFUSALS[checked.refused],
        errors: [{ path: 'hostname', message: REFUSALS[checked.refused] }],
      });
    }
    const { hostname } = checked;
    const row = await inTransaction(this.txHost, async (tx) => {
      const [created] = await tx
        .insert(tenantDomains)
        .values({
          hostname,
          verificationToken: `${VALUE_PREFIX}${randomBytes(24).toString('base64url')}`,
        })
        .returning()
        .catch((error: unknown) => {
          throw pgErrorCode(error) === UNIQUE_VIOLATION
            ? new ConflictException({
                code: 'domain_exists',
                message: `${hostname} is listed already.`,
                errors: [{ path: 'hostname', message: 'Listed already.' }],
              })
            : error;
        });
      await this.audit.record(
        actor,
        {
          action: 'branding.domain-added',
          targetType: 'tenant-domain',
          targetId: created.id,
          details: { hostname },
          ip,
        },
        tx,
      );
      return created;
    });
    return view(row);
  }

  /**
   * Removes a domain and its route in one transaction: from the commit on,
   * the host has no tenant (no brand, no session pinned to it, no
   * certificate from the edge's `ask`). Allowed while the branding is
   * locked: taking a hostname away only ever narrows what is served.
   */
  async remove(actor: Principal, id: string, ip?: string) {
    await inTransaction(this.txHost, async (tx) => {
      const [row] = await tx
        .delete(tenantDomains)
        .where(eq(tenantDomains.id, id))
        .returning();
      if (!row) {
        throw notFound(id);
      }
      // Global: filtered by the tenant here (no row-level security).
      await tx
        .delete(tenantDomainRoutes)
        .where(
          and(
            eq(tenantDomainRoutes.hostname, row.hostname),
            eq(tenantDomainRoutes.tenantId, row.tenantId),
          ),
        );
      await this.audit.record(
        actor,
        {
          action: 'branding.domain-removed',
          targetType: 'tenant-domain',
          targetId: id,
          details: { hostname: row.hostname },
          ip,
        },
        tx,
      );
    });
  }

  /** Queues the DNS check (202). */
  async requestVerification(actor: Principal, id: string) {
    this.assertEnabled();
    await this.branding.assertEditable(actor);
    await this.find(id);
    await this.queue.add(
      'domain-verification',
      withTenant({ kind: 'domain-verification' as const, domainId: id }),
    );
  }

  /**
   * The job's work: looks the TXT record up and records the outcome. Found:
   * verified, and routed unless another tenant routes the hostname already
   * (the first to prove it keeps it until its own record goes). Gone (the
   * name or the value no longer there): no longer verified, the route goes.
   * A lookup that failed (a timeout, a server failure) changes nothing but
   * the error: a DNS outage doesn't take a tenant's domain away.
   */
  async verify(actor: Principal, id: string) {
    const [row] = await this.db
      .select()
      .from(tenantDomains)
      .where(eq(tenantDomains.id, id));
    if (!row) {
      return;
    }
    let outcome: 'found' | 'gone' | 'failed';
    let error: string | null = null;
    try {
      const records = await this.dns.resolveTxt(
        `${DOMAIN_VERIFICATION_RECORD}.${row.hostname}`,
      );
      outcome = records.some(
        (chunks) => chunks.join('') === row.verificationToken,
      )
        ? 'found'
        : 'gone';
      if (outcome === 'gone') {
        error = 'The TXT record was not found or holds another value.';
      }
    } catch (failure) {
      const code = (failure as { code?: string }).code;
      outcome = code && GONE.has(code) ? 'gone' : 'failed';
      error = `DNS lookup failed: ${code ?? (failure as Error).message}`;
    }
    const now = new Date();
    const routed = await inTransaction(this.txHost, async (tx) => {
      // Locked, and read again: a domain removed while the lookup ran
      // (remove() deletes it with its route) must not get a route back.
      const [current] = await tx
        .select({ verifiedAt: tenantDomains.verifiedAt })
        .from(tenantDomains)
        .where(eq(tenantDomains.id, id))
        .for('update');
      if (!current) {
        return false;
      }
      let verified = current.verifiedAt !== null;
      if (outcome === 'found') {
        // The hostname's one tenant: the first to verify it.
        await tx
          .insert(tenantDomainRoutes)
          .values({ hostname: row.hostname, tenantId: row.tenantId })
          .onConflictDoNothing();
        const [route] = await tx
          .select({ tenantId: tenantDomainRoutes.tenantId })
          .from(tenantDomainRoutes)
          .where(eq(tenantDomainRoutes.hostname, row.hostname));
        verified = route?.tenantId === row.tenantId;
        if (!verified) {
          error = 'Another tenant uses this domain.';
        }
      } else if (outcome === 'gone') {
        verified = false;
        await tx
          .delete(tenantDomainRoutes)
          .where(
            and(
              eq(tenantDomainRoutes.hostname, row.hostname),
              eq(tenantDomainRoutes.tenantId, row.tenantId),
            ),
          );
      }
      await tx
        .update(tenantDomains)
        .set({
          lastCheckedAt: now,
          lastError: error,
          verifiedAt: verified ? (current.verifiedAt ?? now) : null,
        })
        .where(eq(tenantDomains.id, id));
      const was = current.verifiedAt !== null;
      if (verified !== was) {
        await this.audit.record(
          actor,
          {
            action: verified
              ? 'branding.domain-verified'
              : 'branding.domain-suspended',
            targetType: 'tenant-domain',
            targetId: id,
            details: { hostname: row.hostname },
          },
          tx,
        );
      }
      return verified;
    });
    if (routed) {
      await this.redis.del(unknownHostKey(row.hostname));
    }
  }

  /** The verified domains of the current tenant: what the nightly check looks up again. */
  async verifiedIds() {
    const rows = await this.db
      .select({ id: tenantDomains.id })
      .from(tenantDomains)
      .where(isNotNull(tenantDomains.verifiedAt));
    return rows.map((row) => row.id);
  }

  /** The tenants that route a hostname (global): whose domains the nightly check walks. */
  async routedTenants() {
    const rows = await this.db
      .selectDistinct({ tenantId: tenantDomainRoutes.tenantId })
      .from(tenantDomainRoutes);
    return rows.map((row) => row.tenantId);
  }

  /**
   * The active tenant whose verified domain `hostname` is (HOST_TENANTS),
   * or null: CUSTOM_DOMAINS off, the app's own host, a name that could
   * never be a custom domain (an IP, `localhost`) or one nobody verified.
   * Read at every request on such a host; only a hostname nobody routes is
   * cached (UNKNOWN_HOST_SECONDS), so a removed domain stops at once, on
   * every replica. Redis unreachable: the database answers.
   */
  async tenantOfHost(hostname: string): Promise<string | null> {
    if (!this.enabled) {
      return null;
    }
    const checked = normalizeHostname(hostname, this.appHosts());
    if ('refused' in checked) {
      return null;
    }
    const key = unknownHostKey(checked.hostname);
    if (await this.redis.exists(key).catch(() => 0)) {
      return null;
    }
    const [route] = await this.db
      .select({ tenantId: tenantDomainRoutes.tenantId })
      .from(tenantDomainRoutes)
      .innerJoin(tenants, eq(tenants.id, tenantDomainRoutes.tenantId))
      .where(
        and(
          eq(tenantDomainRoutes.hostname, checked.hostname),
          eq(tenants.active, true),
        ),
      );
    if (!route) {
      await this.redis
        .set(key, '1', 'EX', UNKNOWN_HOST_SECONDS)
        .catch(() => undefined);
      return null;
    }
    return route.tenantId;
  }

  /**
   * The brand of the tenant whose verified domain the request came to, for
   * the sign-in page; any other host (the app's own, an unknown one) gets
   * the generic brand: the same shape, all null, and never a tenant.
   */
  async brandOfHost(hostname: string | undefined): Promise<PublicBrand> {
    const tenantId = hostname ? await this.tenantOfHost(hostname) : null;
    if (!tenantId) {
      return GENERIC_BRAND;
    }
    return this.tenancy.run(tenantId, () => this.branding.brand(tenantId));
  }

  private assertEnabled() {
    if (!this.enabled) {
      throw new NotFoundException({
        code: 'custom_domains_off',
        message: 'Custom domains are off in this deployment (CUSTOM_DOMAINS).',
      });
    }
  }

  private async find(id: string) {
    const [row] = await this.db
      .select()
      .from(tenantDomains)
      .where(eq(tenantDomains.id, id));
    if (!row) {
      throw notFound(id);
    }
    return row;
  }
}

const GENERIC_BRAND: PublicBrand = {
  primaryColor: null,
  darkPrimaryColor: null,
  mailFromName: null,
  logoUrl: null,
  darkLogoUrl: null,
};

function view(row: Domain) {
  return {
    id: row.id,
    hostname: row.hostname,
    verified: row.verifiedAt !== null,
    verifiedAt: row.verifiedAt,
    lastCheckedAt: row.lastCheckedAt,
    lastError: row.lastError,
    record: {
      type: 'TXT' as const,
      name: `${DOMAIN_VERIFICATION_RECORD}.${row.hostname}`,
      value: row.verificationToken,
    },
    createdAt: row.createdAt,
  };
}

const notFound = (id: string) =>
  new NotFoundException(`Domain ${id} not found.`);
