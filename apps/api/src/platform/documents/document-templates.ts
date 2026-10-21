import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileTemplateEngine } from '@nestjs/mail';
import type { CoreEnv } from '../../core/config/core.env.js';
import { BrandingService } from '../branding/branding.service.js';

/** The documents' templates: `layout.html` wraps each one (copied to dist by nest-cli.json). */
export const DOCUMENT_TEMPLATES_DIR = join(
  import.meta.dirname,
  '../../documents/templates',
);

/**
 * Languages written right to left. Custom: `Intl.Locale#getTextInfo()`
 * answers the same, but not in every runtime the template may run on (and
 * TypeScript's lib doesn't type it yet); the list is short and stable.
 */
const RTL_LANGUAGES = new Set([
  'ar',
  'arc',
  'ckb',
  'dv',
  'fa',
  'he',
  'ks',
  'ps',
  'sd',
  'ug',
  'ur',
  'yi',
]);

/** `rtl` for a language written right to left (`ar`, `ar-AE`), else `ltr`. */
export const textDirection = (locale: string): 'rtl' | 'ltr' =>
  RTL_LANGUAGES.has(locale.split(/[-_]/)[0]!.toLowerCase()) ? 'rtl' : 'ltr';

/**
 * Renders a document's HTML from its template, wrapped in `layout.html`
 * (the page, the fonts, `lang` and `dir`).
 *
 * The engine is @nestjs/mail's FileTemplateEngine, already the mails'
 * engine, used as it is rather than a template library added for this:
 * Handlebars' syntax, every `{{ value }}` HTML-escaped, a `{{ }}` anywhere
 * else in a tag (an unquoted attribute, between attributes) a compile
 * error, a template per language when one exists (`note.ar.html`), and no
 * helpers, so templates can't run code. `{{{ raw }}}` exists for the
 * layout's body only: templates.spec.ts refuses it anywhere else.
 *
 * The tenant's branding (`brand`: name, `#rrggbb` colour, logo as a
 * `data:` URL, BrandingService) is added to every context.
 *
 * Nothing remote: the layout's Content-Security-Policy allows inline
 * styles and `data:` images and fonts only, and Gotenberg's Chromium is
 * allowed `file:///tmp/` and nothing else (compose.prod.yaml), on a
 * network without egress.
 */
@Injectable()
export class DocumentTemplates {
  private readonly engine: FileTemplateEngine;

  constructor(
    config: ConfigService<CoreEnv, true>,
    private readonly branding: BrandingService,
  ) {
    this.engine = new FileTemplateEngine({
      dir: DOCUMENT_TEMPLATES_DIR,
      layout: 'layout',
      // Edits show without a restart in development.
      cache: config.get('NODE_ENV', { infer: true }) !== 'development',
    });
  }

  async render(
    template: string,
    context: Record<string, unknown>,
    { locale, title }: { locale: string; title: string },
  ): Promise<string> {
    const { html } = await this.engine.render(
      template,
      {
        ...context,
        // The tenant's name, colour and logo (a data: URL): the layout shows them.
        brand: await this.branding.forDocument(),
        lang: locale,
        dir: textDirection(locale),
        title,
      },
      { locale },
    );
    return html;
  }
}
