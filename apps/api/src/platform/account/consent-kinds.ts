import {
  BadRequestException,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { I18nService, t } from '@nestjs/i18n';
import { PLATFORM_OPTIONS, type PlatformOptions } from '../platform.options.js';

/**
 * A kind of consent the app asks for: what `POST /v1/account/consents`
 * accepts and `GET /v1/account/consent-kinds` lists. Its texts are in the
 * catalogs, `auth.consentKinds.<kind>.label` and `.description`
 * (`src/i18n/<locale>/auth.json`).
 */
export interface ConsentKindDeclaration {
  /** `terms`, `privacy`, `marketing`: lower camel case or kebab case. */
  kind: string;
  /**
   * The version in force (`2026-01`): the only one accepted. Publish a new
   * text, bump it, and clients ask again whoever accepted an older one.
   */
  version: string;
  /**
   * Needed to use the service: the terms, the privacy policy. These are a
   * contract's (GDPR Art. 6(1)(b)), not a consent one may withdraw and stay:
   * withdrawing one is refused (409 `consent_required`), deleting the
   * account ends it. Optional ones (marketing) are withdrawn at will.
   */
  required: boolean;
}

export const defineConsentKinds = <
  const T extends readonly ConsentKindDeclaration[],
>(
  kinds: T,
) => kinds;

/**
 * The template's: the terms and the privacy policy (required) and marketing
 * (optional), as the web app asks for them. Change them here (and their
 * texts in the catalogs) for the app's own; `app.module.ts` hands them to
 * the platform (`PlatformModule.forRoot({ consents })`).
 */
export const CONSENT_KINDS = defineConsentKinds([
  { kind: 'terms', version: '2026-01', required: true },
  { kind: 'privacy', version: '2026-01', required: true },
  { kind: 'marketing', version: '2026-01', required: false },
]);

/** A kind's name, as declared and as the routes take it. */
export const CONSENT_KIND_PATTERN = /^[a-z][a-zA-Z0-9-]{0,49}$/;

/**
 * The declared consent kinds (`PlatformModule.forRoot({ consents })`):
 * checked at start (a kind declared twice, a bad name or version, or one
 * the English catalog has no label or description for stops it), listed
 * with their texts, and the judge of what may be accepted.
 */
@Injectable()
export class ConsentKinds implements OnApplicationBootstrap {
  private readonly byKind = new Map<string, ConsentKindDeclaration>();

  constructor(
    @Inject(PLATFORM_OPTIONS) options: PlatformOptions,
    private readonly i18n: I18nService,
  ) {
    for (const declaration of options.consents ?? []) {
      if (!CONSENT_KIND_PATTERN.test(declaration.kind)) {
        throw new Error(
          `Consent kind "${declaration.kind}": a name such as terms, privacy, marketing.`,
        );
      }
      if (!declaration.version.trim() || declaration.version.length > 50) {
        throw new Error(
          `Consent kind "${declaration.kind}" needs a version of 1 to 50 characters.`,
        );
      }
      if (this.byKind.has(declaration.kind)) {
        throw new Error(
          `Consent kind "${declaration.kind}" is declared twice.`,
        );
      }
      this.byKind.set(declaration.kind, declaration);
    }
  }

  onApplicationBootstrap() {
    for (const { kind } of this.byKind.values()) {
      for (const part of ['label', 'description']) {
        const key = `auth.consentKinds.${kind}.${part}`;
        if (!this.i18n.exists(key, this.i18n.defaultLocale)) {
          throw new Error(
            `The ${this.i18n.defaultLocale} catalog has no ${key} (src/i18n/${this.i18n.defaultLocale}/auth.json).`,
          );
        }
      }
    }
  }

  /** A declared kind, or undefined. */
  get(kind: string) {
    return this.byKind.get(kind);
  }

  /** The declared kinds, in declaration order, with their texts in the request's language. */
  list() {
    return [...this.byKind.values()].map(({ kind, version, required }) => ({
      kind,
      version,
      required,
      label: this.i18n.translate(`auth.consentKinds.${kind}.label` as never),
      description: this.i18n.translate(
        `auth.consentKinds.${kind}.description` as never,
      ),
    }));
  }

  /**
   * The declaration a consent is accepted under: a declared kind, at its
   * current version. Anything else is a 400 `validation_failed` naming the
   * field and what is accepted.
   */
  assertAcceptable(kind: string, version: string) {
    const declared = this.byKind.get(kind);
    const refuse = (path: string, message: string) =>
      new BadRequestException({
        code: 'validation_failed',
        message: t('auth.consentRefused'),
        errors: [{ path, message }],
      });
    if (!declared) {
      throw refuse(
        'kind',
        t('auth.consentUnknownKind', {
          args: { kinds: [...this.byKind.keys()].join(', ') },
        }),
      );
    }
    if (declared.version !== version) {
      throw refuse(
        'version',
        t('auth.consentOtherVersion', {
          args: { version: declared.version },
        }),
      );
    }
    return declared;
  }
}
