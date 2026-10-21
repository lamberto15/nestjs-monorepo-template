import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageDisk } from '@nestjs/storage';
import type { CoreEnv } from '../../core/config/core.env.js';
import {
  DEFAULT_MAIL_BRAND,
  type MailBranding,
  type MailBrand,
} from '../../core/mail/mail-branding.js';
import { currentTenantId } from '../../core/tenancy/tenant-scope.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { Principal } from '../../iam/auth/principal.js';
import { SettingsService } from '../settings/settings.service.js';
import { tenantFileKey } from '../storage/storage.config.js';
import type { Branding, UpdateBranding } from './branding.schemas.js';
import {
  BRANDING_LOCKED,
  BRANDING_MAIL_FROM_NAME,
  BRANDING_PRIMARY_COLOR,
} from './branding.settings.js';

/** What a logo may be: recognized by its bytes (the first ones), never by the name or the type the client says. */
export const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
/** SVG is left out on purpose: it runs scripts when opened. */
export const LOGO_MAX_BYTES = 512 * 1024;

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
  ) {
    // The settings API is a way in too: the lock holds there as on /v1/branding.
    for (const declaration of [
      BRANDING_PRIMARY_COLOR,
      BRANDING_MAIL_FROM_NAME,
    ]) {
      settings.guardWrite(declaration, async (write) =>
        write.scope !== 'platform' && (await settings.enabled(BRANDING_LOCKED))
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
  static logoKey(tenantId: string) {
    return tenantFileKey(tenantId, 'branding/logo');
  }

  /** What the caller sees: the tenant's branding, and whether they may change it. */
  async view(principal: Principal): Promise<Branding> {
    const tenantId = this.tenantId();
    const [primaryColor, mailFromName, locked, logo] = await Promise.all([
      this.settings.get(BRANDING_PRIMARY_COLOR),
      this.settings.get(BRANDING_MAIL_FROM_NAME),
      this.settings.enabled(BRANDING_LOCKED),
      this.logo(tenantId),
    ]);
    return {
      primaryColor,
      mailFromName,
      logoUrl: logo ? this.logoPath(tenantId) : null,
      locked,
      canEdit: !locked && (await this.settings.canEdit(principal)),
    };
  }

  /** A 409 `branding_locked` while the operators have it locked. */
  async assertEditable() {
    if (await this.settings.enabled(BRANDING_LOCKED)) {
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
    await this.assertEditable();
    for (const [declaration, value] of [
      [BRANDING_PRIMARY_COLOR, changes.primaryColor],
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
   * by the new at the same key.
   */
  async logoUploaded(
    actor: Principal,
    file: { contentType: string; size: number },
    ip?: string,
  ): Promise<Branding> {
    const tenantId = this.tenantId();
    this.logos.delete(tenantId);
    await this.audit.record(actor, {
      action: 'branding.logo-changed',
      targetType: 'tenant',
      targetId: tenantId,
      details: { contentType: file.contentType, size: file.size },
      ip,
    });
    return this.view(actor);
  }

  async removeLogo(actor: Principal, ip?: string): Promise<void> {
    await this.assertEditable();
    const tenantId = this.tenantId();
    if (!(await this.logo(tenantId, true))) {
      throw new NotFoundException('There is no logo.');
    }
    await this.disk.delete(BrandingService.logoKey(tenantId));
    this.logos.delete(tenantId);
    await this.audit.record(actor, {
      action: 'branding.logo-removed',
      targetType: 'tenant',
      targetId: tenantId,
      ip,
    });
  }

  /**
   * A short-lived signed link to a tenant's logo, for the public route
   * (a logo is not a secret: mail and the sign-in page show it), or null.
   */
  async logoLink(tenantId: string): Promise<string | null> {
    if (!(await this.logo(tenantId))) {
      return null;
    }
    return this.disk.signedUrl(BrandingService.logoKey(tenantId), {
      expiresIn: '5m',
    });
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
      this.logo(tenantId),
    ]);
    return {
      name,
      color: color ?? DEFAULT_MAIL_BRAND.color,
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
      this.logo(tenantId),
    ]);
    let data: string | null = null;
    if (logo) {
      const bytes = await this.disk.getBuffer(
        BrandingService.logoKey(tenantId),
      );
      data = `data:${logo.contentType};base64,${bytes.toString('base64')}`;
    }
    return { name, color: color ?? none.color, logo: data };
  }

  private logoPath(tenantId: string) {
    return `/v1/branding/${tenantId}/logo`;
  }

  private tenantId() {
    const id = currentTenantId();
    if (!id) {
      throw new Error('Branding needs a tenant.');
    }
    return id;
  }

  private async logo(
    tenantId: string,
    fresh = false,
  ): Promise<LogoInfo | null> {
    const cached = this.logos.get(tenantId);
    if (!fresh && cached && Date.now() - cached.at < LOGO_CACHE_MS) {
      return cached.info;
    }
    const key = BrandingService.logoKey(tenantId);
    let info: LogoInfo | null = null;
    if (await this.disk.exists(key)) {
      const { contentType, size } = await this.disk.stat(key);
      // What the upload recognized; anything else on the key is not served.
      info = (LOGO_TYPES as readonly string[]).includes(contentType)
        ? { contentType, size }
        : null;
    }
    this.logos.set(tenantId, { at: Date.now(), info });
    return info;
  }
}
