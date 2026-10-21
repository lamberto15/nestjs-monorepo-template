import { AsyncLocalStorage } from 'node:async_hooks';
import { MailTemplateEngine } from '@nestjs/mail';
import type {
  MailTemplateOutput,
  MailTemplateRenderOptions,
} from '@nestjs/mail';

/**
 * What a tenant's mail looks like (docs/branding.md): the name it is sent
 * under and signed with, the accent colour, and where the logo is served.
 * Every field is checked where it is stored (platform/branding), and
 * `color` is always a `#rrggbb`: templates put it in a style attribute.
 */
export interface MailBrand {
  /** The sender's display name and the signature; null: the deployment's own. */
  name: string | null;
  /** `#rrggbb`. */
  color: string;
  /** An absolute https URL of the logo, or null. */
  logoUrl: string | null;
}

/** What mail looks like when no tenant brands it. */
export const DEFAULT_MAIL_BRAND: MailBrand = {
  name: null,
  color: '#1f2328',
  logoUrl: null,
};

/**
 * The branding of the tenant in scope, as the mail queue asks it (core
 * can't import the platform, which keeps the settings and the logo: the
 * platform provides this token, `MailQueue` injects it optionally and
 * sends unbranded mail when nothing provides it).
 */
export interface MailBranding {
  /** The current tenant's brand, or null outside any tenant. */
  current(): Promise<MailBrand | null>;
}
export const MAIL_BRANDING = Symbol('MAIL_BRANDING');

const scope = new AsyncLocalStorage<MailBrand>();

/** Renders with `brand` available to the templates as `{{ brand.* }}`. */
export const withMailBrand = <T>(brand: MailBrand, work: () => Promise<T>) =>
  scope.run(brand, work);

/**
 * The template engine of the mails: the file engine's, with `brand` added
 * to the context of every template and its layout (`withMailBrand()` says
 * which; the default when none). A template's own `brand` would win, so
 * none should set one.
 */
export class BrandedTemplateEngine extends MailTemplateEngine {
  constructor(private readonly inner: MailTemplateEngine) {
    super();
  }

  render(
    name: string,
    context: object,
    options: MailTemplateRenderOptions,
  ): MailTemplateOutput | Promise<MailTemplateOutput> {
    return this.inner.render(
      name,
      { brand: scope.getStore() ?? DEFAULT_MAIL_BRAND, ...context },
      options,
    );
  }
}
