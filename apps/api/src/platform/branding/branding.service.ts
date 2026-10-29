import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Readable } from 'node:stream';
import { TransactionHost } from '@nestjs-cls/transactional';
import {
  detectContentType,
  StorageDisk,
  StorageFileNotFoundError,
} from '@nestjs/storage';
import { and, eq } from 'drizzle-orm';
import type { CoreEnv } from '../../core/config/core.env.js';
import {
  DEFAULT_MAIL_BRAND,
  type MailBranding,
  type MailBrand,
} from '../../core/mail/mail-branding.js';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import { tenants } from '../../core/tenancy/tenancy.tables.js';
import {
  currentTenantId,
  requireTenantId,
} from '../../core/tenancy/tenant-scope.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { Principal } from '../../iam/auth/principal.js';
import { SettingsService } from '../settings/settings.service.js';
import { tenantFileKey } from '../storage/storage.config.js';
import type { Branding, UpdateBranding } from './branding.schemas.js';
import {
  BRANDING_DARK_PRIMARY_COLOR,
  BRANDING_LOCKED,
  BRANDING_MAIL_FROM_NAME,
  BRANDING_PRIMARY_COLOR,
  DISPLAY_NAME,
  HEX_COLOR,
} from './branding.settings.js';

/** What a logo may be: recognized by its bytes (the first ones), never by the name or the type the client says. */
export const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
/** SVG is left out on purpose: it runs scripts when opened. */
export const LOGO_MAX_BYTES = 512 * 1024;

/** The two logos of a tenant: the one everywhere, and an optional one for the web app's dark theme. */
export type LogoVariant = 'light' | 'dark';

interface LogoInfo {
  contentType: string;
  size: number;
}

/** How long an instance remembers whether a tenant has a logo (a mail asks every time). */
const LOGO_CACHE_MS = 30_000;

/** The branding of a document: what the PDF templates show (`brand`). */
export interface DocumentBrand {
  name: string | null;
  color: string;
  /** A `data:` URL: the document's page loads nothing else. */
  logo: string | null;
}

/**
 * A stored colour or name, checked again where it is used. The settings'
 * schemas already refuse anything else, at every write; this is the second
 * wall for what reaches a style attribute or a mail header (an enforced
 * platform value, a row written by hand): anything unexpected is dropped,
 * never escaped into place.
 */
export const safeColor = (value: string | null) =>
  value !== null && HEX_COLOR.test(value) ? value : null;
export const safeName = (value: string | null) =>
  value !== null && value.length <= 60 && DISPLAY_NAME.test(value)
    ? value
    : null;

/**
 * A tenant's branding (docs/branding.md): the colour and the mail sender's
 * name are settings (`branding.*`, tenant scope, audited by the settings
 * service), the logo a file on the private disk at a key of the tenant's
 * own (`tenants/<id>/branding/logo`, one per tenant: a new one replaces
 * it). The operators lock all of it with `branding.locked`.
 *
 * Also the core's mail queue's `MAIL_BRANDING`, and the PDF templates'
 * `brand`.
 */
@Injectable()
export class BrandingService implements MailBranding {
  private readonly logos = new Map<
    string,
    { at: number; info: LogoInfo | null }
  >();

  constructor(
    private readonly settings: SettingsService,
    private readonly disk: StorageDisk,
    private readonly audit: AuditService,
    private readonly config: ConfigService<CoreEnv, true>,
    private readonly txHost: TransactionHost<DrizzleTransactions>,
  ) {
    // The settings API is a way in too: the lock holds there as on /v1/branding.
    for (const declaration of [
      BRANDING_PRIMARY_COLOR,
      BRANDING_DARK_PRIMARY_COLOR,
      BRANDING_MAIL_FROM_NAME,
    ]) {
      settings.guardWrite(declaration, async (write) =>
        write.scope !== 'platform' &&
        (await settings.enabled(BRANDING_LOCKED, write.actor))
          ? {
              code: 'branding_locked',
              message:
                'The branding of this tenant is locked by the operators.',
            }
          : undefined,
      );
    }
  }

  /** The disk key of a tenant's logo. */
  static logoKey(
    tenantId: string,
    version = 'current',
    variant: LogoVariant = 'light',
  ) {
    const name = variant === 'dark' ? 'logo-dark' : 'logo';
    return tenantFileKey(
      tenantId,
      `branding/${version === 'current' ? name : `${name}-${version}`}`,
    );
  }

  /** What the caller sees: the tenant's branding, and whether they may change it. */
  async view(principal: Principal): Promise<Branding> {
    const tenantId = currentTenantId();
    if (!tenantId) {
      // A signed-in caller with no tenant (no membership, a session whose
      // tenant was left) is still routed into the web app, which asks for
      // the theme: nothing is branded, and nothing is theirs to change
      // (the settings read the same: defaults).
      return {
        primaryColor: null,
        darkPrimaryColor: null,
        mailFromName: null,
        logoUrl: null,
        darkLogoUrl: null,
        locked: false,
        canEdit: false,
      };
    }
    const [primaryColor, darkColor, mailFromName, locked, logo, darkLogo] =
      await Promise.all([
        this.settings.get(BRANDING_PRIMARY_COLOR),
        this.settings.get(BRANDING_DARK_PRIMARY_COLOR),
        this.settings.get(BRANDING_MAIL_FROM_NAME),
        this.settings.enabled(BRANDING_LOCKED, principal),
        this.logo(tenantId, 'light'),
        this.logo(tenantId, 'dark'),
      ]);
    return {
      primaryColor: safeColor(primaryColor),
      darkPrimaryColor: safeColor(darkColor),
      mailFromName: safeName(mailFromName),
      logoUrl: logo ? this.logoPath(tenantId) : null,
      darkLogoUrl: darkLogo ? this.logoPath(tenantId, 'dark') : null,
      locked,
      canEdit: !locked && (await this.settings.canEdit(principal)),
    };
  }

  /**
   * A 409 `branding_locked` while the operators have it locked. Asked for
   * the writer: the operators' platform rules (by tenant slug) match a
   * principal, never the nobody of a job.
   */
  async assertEditable(actor: Principal) {
    if (await this.settings.enabled(BRANDING_LOCKED, actor)) {
      throw new ConflictException({
        code: 'branding_locked',
        message: 'The branding of this tenant is locked by the operators.',
      });
    }
  }

  /**
   * Sets or removes the colour and the sender name (`null` removes, an
   * absent key stays), through the settings service: the same schemas, the
   * same audit entries (`setting.updated`, `setting.reset`).
   */
  async update(
    actor: Principal,
    changes: UpdateBranding,
    ip?: string,
  ): Promise<Branding> {
    await this.assertEditable(actor);
    for (const [declaration, value] of [
      [BRANDING_PRIMARY_COLOR, changes.primaryColor],
      [BRANDING_DARK_PRIMARY_COLOR, changes.darkPrimaryColor],
      [BRANDING_MAIL_FROM_NAME, changes.mailFromName],
    ] as const) {
      if (value === undefined) {
        continue;
      }
      if (value === null) {
        await this.settings.unset(
          actor,
          declaration.key,
          'tenant',
          undefined,
          ip,
        );
      } else {
        await this.settings.set(
          actor,
          declaration.key,
          { scope: 'tenant', value },
          ip,
        );
      }
    }
    return this.view(actor);
  }

  /**
   * The upload is already on the disk (BrandingLogoUpload, which checked
   * the lock and recognized the bytes). Audited; the old one is replaced
   * by the new immutable key recorded on the tenant row.
   */
  async logoUploaded(
    actor: Principal,
    file: { contentType: string; size: number; key: string },
    ip?: string,
    variant: LogoVariant = 'light',
  ): Promise<Branding> {
    const tenantId = this.tenantId();
    await database(this.txHost)
      .update(tenants)
      .set(
        variant === 'dark' ? { darkLogoKey: file.key } : { logoKey: file.key },
      )
      .where(eq(tenants.id, tenantId));
    this.logos.delete(this.cacheKey(tenantId, variant));
    await this.audit.record(actor, {
      action: 'branding.logo-changed',
      targetType: 'tenant',
      targetId: tenantId,
      details: { contentType: file.contentType, size: file.size, variant },
      ip,
    });
    return this.view(actor);
  }

  async removeLogo(
    actor: Principal,
    ip?: string,
    variant: LogoVariant = 'light',
  ): Promise<void> {
    await this.assertEditable(actor);
    const tenantId = this.tenantId();
    if (!(await this.logo(tenantId, variant, true))) {
      throw new NotFoundException('There is no logo.');
    }
    const key = await this.currentLogoKey(tenantId, variant);
    await this.disk.delete(key);
    await database(this.txHost)
      .update(tenants)
      .set(variant === 'dark' ? { darkLogoKey: null } : { logoKey: null })
      .where(eq(tenants.id, tenantId));
    this.logos.delete(this.cacheKey(tenantId, variant));
    await this.audit.record(actor, {
      action: 'branding.logo-removed',
      targetType: 'tenant',
      targetId: tenantId,
      details: { variant },
      ip,
    });
  }

  /**
   * The logo of an active tenant, for the public route (a logo is not a
   * secret: mail and the sign-in page show it), or null. The key is built
   * from the id the database answers, not from the one the request sent:
   * an id that is not a tenant's reaches the disk with nothing, and a
   * deactivated tenant's logo is not served. The type is the one the
   * bytes say, from the allowlist, never the stored metadata.
   */
  async logoFile(
    requestedId: string,
    variant: LogoVariant = 'light',
  ): Promise<{
    contentType: string;
    size: number;
    body: Readable;
  } | null> {
    const [tenant] = await database(this.txHost)
      .select({ id: tenants.id })
      .from(tenants)
      .where(and(eq(tenants.id, requestedId), eq(tenants.active, true)));
    const logo = tenant ? await this.logo(tenant.id, variant) : null;
    if (!tenant || !logo) {
      return null;
    }
    try {
      const file = await this.disk.get(
        await this.currentLogoKey(tenant.id, variant),
      );
      return {
        contentType: logo.contentType,
        size: file.size,
        body: file.body,
      };
    } catch (error) {
      // Removed through another instance, which cleared its own cache only.
      if (error instanceof StorageFileNotFoundError) {
        this.logos.delete(this.cacheKey(tenant.id, variant));
        return null;
      }
      throw error;
    }
  }

  /** The current tenant's brand for mail (the core's port). */
  async current(): Promise<MailBrand | null> {
    const tenantId = currentTenantId();
    if (!tenantId) {
      return null;
    }
    const [color, name, logo] = await Promise.all([
      this.settings.get(BRANDING_PRIMARY_COLOR),
      this.settings.get(BRANDING_MAIL_FROM_NAME),
      this.logo(tenantId, 'light'),
    ]);
    return {
      name: safeName(name),
      color: safeColor(color) ?? DEFAULT_MAIL_BRAND.color,
      logoUrl: logo
        ? `${this.config.get('APP_URL', { infer: true })}${this.logoPath(tenantId)}`
        : null,
    };
  }

  /** The current tenant's brand for a PDF: the logo inline, as a `data:` URL. */
  async forDocument(): Promise<DocumentBrand> {
    const tenantId = currentTenantId();
    const none = {
      name: null,
      color: DEFAULT_MAIL_BRAND.color,
      logo: null,
    };
    if (!tenantId) {
      return none;
    }
    const [color, name, logo] = await Promise.all([
      this.settings.get(BRANDING_PRIMARY_COLOR),
      this.settings.get(BRANDING_MAIL_FROM_NAME),
      this.logo(tenantId, 'light'),
    ]);
    let data: string | null = null;
    if (logo) {
      try {
        const bytes = await this.disk.getBuffer(
          await this.currentLogoKey(tenantId, 'light'),
        );
        // The type the bytes say (again: the file may have changed since it
        // was cached), from the allowlist, never the stored metadata.
        const type = detectContentType(bytes);
        if (type && (LOGO_TYPES as readonly string[]).includes(type)) {
          data = `data:${type};base64,${bytes.toString('base64')}`;
        }
      } catch (error) {
        // Removed through another instance, which cleared its own cache
        // only: a document without the logo, not a failed job.
        if (!(error instanceof StorageFileNotFoundError)) {
          throw error;
        }
        this.logos.delete(this.cacheKey(tenantId, 'light'));
      }
    }
    return {
      name: safeName(name),
      color: safeColor(color) ?? none.color,
      logo: data,
    };
  }

  private logoPath(tenantId: string, variant: LogoVariant = 'light') {
    return `/v1/branding/${tenantId}/logo${variant === 'dark' ? '/dark' : ''}`;
  }

  private cacheKey(tenantId: string, variant: LogoVariant) {
    return `${tenantId}:${variant}`;
  }

  /** The current tenant, or a TenantScopeMissingError (403 `tenant_required`). */
  private tenantId() {
    return requireTenantId('Branding');
  }

  private async logo(
    tenantId: string,
    variant: LogoVariant,
    fresh = false,
  ): Promise<LogoInfo | null> {
    const cached = this.logos.get(this.cacheKey(tenantId, variant));
    if (!fresh && cached && Date.now() - cached.at < LOGO_CACHE_MS) {
      return cached.info;
    }
    const key = await this.currentLogoKey(tenantId, variant);
    let info: LogoInfo | null = null;
    try {
      if (await this.disk.exists(key)) {
        // Adopt a logo from before keys became versioned so backups can see
        // its exact object key in the tenant snapshot.
        if (variant === 'light' && key === BrandingService.logoKey(tenantId)) {
          await database(this.txHost)
            .update(tenants)
            .set({ logoKey: key })
            .where(eq(tenants.id, tenantId));
        }
        const { size } = await this.disk.stat(key);
        // What the first bytes say, not what the file was stored as: only
        // the allowlist's images are served as the tenant's logo.
        const head = await this.disk.get(key, {
          range: { start: 0, end: 15 },
        });
        const chunks: Buffer[] = [];
        for await (const chunk of head.body) {
          chunks.push(Buffer.from(chunk as Uint8Array));
        }
        const contentType = detectContentType(Buffer.concat(chunks));
        info =
          contentType && (LOGO_TYPES as readonly string[]).includes(contentType)
            ? { contentType, size }
            : null;
      }
    } catch (error) {
      // Removed between the check and the read: no logo.
      if (!(error instanceof StorageFileNotFoundError)) {
        throw error;
      }
    }
    this.logos.set(this.cacheKey(tenantId, variant), { at: Date.now(), info });
    return info;
  }

  private async currentLogoKey(tenantId: string, variant: LogoVariant) {
    const [tenant] = await database(this.txHost)
      .select({ logoKey: tenants.logoKey, darkLogoKey: tenants.darkLogoKey })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    return (
      (variant === 'dark' ? tenant?.darkLogoKey : tenant?.logoKey) ??
      BrandingService.logoKey(tenantId, 'current', variant)
    );
  }
}
