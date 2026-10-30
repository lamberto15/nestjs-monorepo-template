import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import {
  type CacheItem,
  type CacheProvider,
  type Profile,
  SAML,
  ValidateInResponseTo,
} from '@node-saml/node-saml';
import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import {
  type SsoConnection,
  SsoConnectionsService,
} from './sso-connections.service.js';
import { type SsoIdentity, SsoRefused } from './sso-accounts.service.js';
import {
  bindingHash,
  newBinding,
  SSO_HANDOFF_TTL_MS,
  SSO_REQUEST_TTL_MS,
} from './sso-browser.js';
import { ssoAssertions, ssoRequests } from './sso.tables.js';
import {
  checkXmlAlgorithms,
  hasEncryptedAssertion,
} from './saml-algorithms.js';

/** Clocks of the IdP and this app may differ this much (NotBefore, NotOnOrAfter). */
const CLOCK_SKEW_MS = 2 * 60_000;
/** An assertion is refused this long after it was issued, whatever its NotOnOrAfter says. */
const MAX_ASSERTION_AGE_MS = 10 * 60_000;

const TRANSIENT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient';
const EMAIL_FORMAT = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';

/** Where IdPs put the address and the name (Okta, Entra ID, Google, ADFS, LDAP OIDs). */
const EMAIL_ATTRIBUTES = [
  'email',
  'mail',
  'urn:oid:0.9.2342.19200300.100.1.3',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
];
/** Where IdPs list groups when the connection names no attribute (Entra ID's claim URI too). */
const GROUP_ATTRIBUTES = [
  'groups',
  'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups',
];
const NAME_ATTRIBUTES = [
  'displayName',
  'name',
  'urn:oid:2.16.840.1.113730.3.1.241',
  'http://schemas.microsoft.com/identity/claims/displayname',
];

type Assertion = {
  Assertion?: {
    $?: { ID?: string };
    Conditions?: { $?: { NotOnOrAfter?: string } }[];
    AuthnStatement?: { $?: { AuthnInstant?: string } }[];
  };
};

/**
 * SAML 2.0 sign-in through a tenant's IdP, with @node-saml/node-saml: the
 * AuthnRequest (HTTP-Redirect binding), and the response's checks
 * (XML signature of the assertion against the connection's one or two
 * certificates, audience, NotBefore/NotOnOrAfter with clock skew, the
 * assertion's age, `InResponseTo`). Around it, what the library leaves to
 * the app:
 *
 * - `InResponseTo` is checked against requests of this browser only: the
 *   cache provider answers for a request ID whose row carries the cookie's
 *   binding (SP-initiated, the default; required unless the connection
 *   allows IdP-initiated sign-ins).
 * - Replay: each assertion's ID is stored until it expires, and one seen
 *   before is refused.
 * - The `Issuer` must be the connection's IdP entity id.
 * - A transient NameID (another value at each sign-in) is refused: an
 *   identity is keyed by a stable subject.
 * - Strict signatures: the Response **and** its assertion must be signed
 *   (node-saml's `wantAuthnResponseSigned`, `wantAssertionsSigned`), so an
 *   encrypted assertion is authenticated before it is decrypted; then the
 *   algorithms of every signature, digest and encryption must be on an
 *   allowlist (saml-algorithms.ts): xml-crypto still accepts SHA-1.
 * - Our AuthnRequests are signed (HTTP-Redirect's `SigAlg`/`Signature`)
 *   with the connection's own key, which also decrypts assertions the IdP
 *   encrypts to its certificate (`requireEncryptedAssertions` refuses any
 *   other).
 *
 * The IdP's answer is a cross-site POST, where the session package refuses
 * to sign in (CSRF), so the ACS hands over: the checked result is stored
 * (one use, two minutes, bound to the browser) and the browser goes on to
 * `…/saml/complete` (a GET) which signs it in.
 */
@Injectable()
export class SamlSso {
  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly connections: SsoConnectionsService,
  ) {}

  private get db() {
    return database(this.txHost);
  }

  /** The IdP's URL for a new sign-in, and the binding for the browser's cookie. */
  async start(connection: SsoConnection, redirectTo: string | undefined) {
    const binding = newBinding();
    await this.db
      .delete(ssoRequests)
      .where(lt(ssoRequests.expiresAt, new Date()));
    const [request] = await this.db
      .insert(ssoRequests)
      .values({
        connectionId: connection.id,
        bindingHash: bindingHash(binding),
        redirectTo: redirectTo ?? null,
        expiresAt: new Date(Date.now() + SSO_REQUEST_TTL_MS),
      })
      .returning({ id: ssoRequests.id });
    // node-saml makes the AuthnRequest's ID and hands it to the cache
    // provider: it lands on this browser's request.
    const saml = await this.saml(connection, {
      saveAsync: async (key, value) => {
        await this.db
          .update(ssoRequests)
          .set({ samlRequestId: key })
          .where(eq(ssoRequests.id, request.id));
        return { value, createdAt: Date.now() } satisfies CacheItem;
      },
      getAsync: () => Promise.resolve(null),
      removeAsync: () => Promise.resolve(null),
    });
    const url = await saml.getAuthorizeUrlAsync('', undefined, {});
    return { url, binding };
  }

  /**
   * The IdP's POST: the response checked (library and the rules above),
   * then the identity it asserts and where the browser was going.
   * `binding`: this browser's cookie, absent for an IdP-initiated sign-in
   * on a browser that started none.
   */
  async consume(
    connection: SsoConnection,
    samlResponse: string,
    binding: string | undefined,
  ): Promise<{
    identity: SsoIdentity;
    requestId: string | null;
    redirectTo: string | null;
  }> {
    const hash = binding ? bindingHash(binding) : undefined;
    const now = new Date();
    const saml = await this.saml(connection, {
      saveAsync: () => Promise.resolve(null),
      // A request of this browser's, unused and unexpired.
      getAsync: async (key) => {
        if (!hash) {
          return null;
        }
        const [row] = await this.db
          .select({ createdAt: ssoRequests.createdAt })
          .from(ssoRequests)
          .where(
            and(
              eq(ssoRequests.connectionId, connection.id),
              eq(ssoRequests.samlRequestId, key),
              eq(ssoRequests.bindingHash, hash),
              isNull(ssoRequests.consumedAt),
              isNull(ssoRequests.userId),
              gt(ssoRequests.expiresAt, now),
            ),
          );
        return row ? row.createdAt.toISOString() : null;
      },
      // Taken below, once the whole response checked out.
      removeAsync: () => Promise.resolve(null),
    });
    let profile: Profile | null;
    try {
      ({ profile } = await saml.validatePostResponseAsync({
        SAMLResponse: samlResponse,
      }));
    } catch (error) {
      const message = (error as Error).message;
      // node-saml checks idpIssuer itself since 5.2; keep our reason for it.
      if (message.startsWith('Unknown SAML issuer')) {
        throw new SsoRefused('issuer_mismatch');
      }
      throw new SsoRefused(`response_invalid:${message.slice(0, 120)}`);
    }
    if (!profile) {
      throw new SsoRefused('no_assertion');
    }
    // What the library verified, read again for what it lets through.
    const responseXml = profile.getSamlResponseXml?.() ?? '';
    const assertionXml = profile.getAssertionXml?.() ?? '';
    const weak =
      checkXmlAlgorithms(responseXml, { signed: true }) ??
      checkXmlAlgorithms(assertionXml, { signed: true });
    if (weak) {
      throw new SsoRefused(`algorithm_refused:${weak.slice(0, 100)}`);
    }
    if (
      connection.requireEncryptedAssertions &&
      !hasEncryptedAssertion(responseXml)
    ) {
      throw new SsoRefused('assertion_not_encrypted');
    }
    if (profile.issuer !== connection.idpEntityId) {
      throw new SsoRefused('issuer_mismatch');
    }
    if (!profile.nameID || profile.nameIDFormat === TRANSIENT) {
      throw new SsoRefused('no_stable_subject');
    }
    const assertion = (profile.getAssertion?.() ?? {}) as Assertion;
    const assertionId = assertion.Assertion?.$?.ID;
    if (!assertionId) {
      throw new SsoRefused('no_assertion_id');
    }
    const notOnOrAfter = Date.parse(
      assertion.Assertion?.Conditions?.[0]?.$?.NotOnOrAfter ?? '',
    );
    const expiresAt = new Date(
      Math.max(
        Number.isFinite(notOnOrAfter) ? notOnOrAfter : 0,
        now.getTime() + MAX_ASSERTION_AGE_MS,
      ) + CLOCK_SKEW_MS,
    );
    await this.db.delete(ssoAssertions).where(lt(ssoAssertions.expiresAt, now));
    const [fresh] = await this.db
      .insert(ssoAssertions)
      .values({ connectionId: connection.id, assertionId, expiresAt })
      .onConflictDoNothing()
      .returning({ id: ssoAssertions.assertionId });
    if (!fresh) {
      throw new SsoRefused('assertion_replayed');
    }
    const inResponseTo =
      typeof profile.inResponseTo === 'string' ? profile.inResponseTo : null;
    if (!inResponseTo && !connection.allowIdpInitiated) {
      throw new SsoRefused('unsolicited_response');
    }
    let redirectTo: string | null = null;
    let requestId: string | null = null;
    if (inResponseTo) {
      // Already checked by the cache provider; read again for its row.
      const [request] = await this.db
        .select({ id: ssoRequests.id, redirectTo: ssoRequests.redirectTo })
        .from(ssoRequests)
        .where(
          and(
            eq(ssoRequests.connectionId, connection.id),
            eq(ssoRequests.samlRequestId, inResponseTo),
            eq(ssoRequests.bindingHash, hash ?? ''),
          ),
        );
      if (!request) {
        throw new SsoRefused('request_unknown');
      }
      requestId = request.id;
      redirectTo = request.redirectTo;
    }
    const authnInstant = Date.parse(
      assertion.Assertion?.AuthnStatement?.[0]?.$?.AuthnInstant ?? '',
    );
    const email =
      firstString(profile, EMAIL_ATTRIBUTES) ??
      (profile.nameIDFormat === EMAIL_FORMAT ? profile.nameID : undefined);
    return {
      identity: {
        subject: profile.nameID,
        email,
        // SAML has no such claim: the tenant's verified domain is the guarantee.
        emailVerified: true,
        name:
          firstString(profile, NAME_ATTRIBUTES) ??
          ([firstString(profile, ['givenName']), firstString(profile, ['sn'])]
            .filter(Boolean)
            .join(' ') ||
            undefined),
        authenticatedAt:
          Number.isFinite(authnInstant) && authnInstant <= now.getTime()
            ? new Date(authnInstant)
            : undefined,
        groups: allStrings(
          profile,
          connection.groupsAttribute
            ? [connection.groupsAttribute]
            : GROUP_ATTRIBUTES,
        ),
      },
      requestId,
      redirectTo,
    };
  }

  /**
   * Hands a checked sign-in over to `…/saml/complete`: the browser's own
   * request (SP-initiated) takes the account; an IdP-initiated sign-in gets
   * a new row and a new binding (returned, for the cookie). One use: a
   * request that already took one is refused.
   */
  async handOver(
    connection: SsoConnection,
    userId: string,
    authenticatedAt: Date | undefined,
    requestId: string | null,
    redirectTo: string | null,
  ): Promise<{ binding?: string }> {
    if (requestId) {
      const [taken] = await this.db
        .update(ssoRequests)
        .set({
          userId,
          authenticatedAt: authenticatedAt ?? null,
          expiresAt: new Date(Date.now() + SSO_HANDOFF_TTL_MS),
        })
        .where(
          and(
            eq(ssoRequests.id, requestId),
            isNull(ssoRequests.userId),
            isNull(ssoRequests.consumedAt),
          ),
        )
        .returning({ id: ssoRequests.id });
      if (!taken) {
        throw new SsoRefused('request_used');
      }
      return {};
    }
    const binding = newBinding();
    await this.db.insert(ssoRequests).values({
      connectionId: connection.id,
      bindingHash: bindingHash(binding),
      userId,
      authenticatedAt: authenticatedAt ?? null,
      redirectTo,
      expiresAt: new Date(Date.now() + SSO_HANDOFF_TTL_MS),
    });
    return { binding };
  }

  /** The handed-over sign-in this browser holds, taken once. */
  async takeHandOver(connection: SsoConnection, binding: string | undefined) {
    if (!binding) {
      throw new SsoRefused('no_binding');
    }
    const [request] = await this.db
      .update(ssoRequests)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(ssoRequests.connectionId, connection.id),
          eq(ssoRequests.bindingHash, bindingHash(binding)),
          isNull(ssoRequests.consumedAt),
          gt(ssoRequests.expiresAt, new Date()),
        ),
      )
      .returning();
    if (!request?.userId) {
      throw new SsoRefused('handover_unknown');
    }
    return {
      userId: request.userId,
      authenticatedAt: request.authenticatedAt,
      redirectTo: request.redirectTo,
    };
  }

  /**
   * Our SP metadata (XML) for the IdP: entity id, ACS URL, signed
   * assertions wanted, our requests signed, and our certificate for both
   * signing and encryption.
   */
  async metadata(connection: SsoConnection) {
    const { certificate } = await this.connections.samlKeys(connection);
    return (await this.saml(connection)).generateServiceProviderMetadata(
      certificate,
      certificate,
    );
  }

  private async saml(connection: SsoConnection, cacheProvider?: CacheProvider) {
    const urls = this.connections.urls(connection);
    const keys = await this.connections.samlKeys(connection);
    return new SAML({
      // Our entity id is the metadata's URL: unique per connection.
      issuer: urls.samlMetadata,
      audience: urls.samlMetadata,
      callbackUrl: urls.samlAcs,
      entryPoint: connection.idpSsoUrl ?? undefined,
      idpCert: connection.idpCertificates,
      // The library's own Issuer check (the Response's); the assertion's is checked in consume().
      idpIssuer: connection.idpEntityId ?? undefined,
      // Both signed: the assertion (whose content is what we trust), and the
      // Response around it, which covers an encrypted assertion before it is
      // decrypted (no decryption oracle) and the response's own attributes.
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: true,
      // Ours: signs the AuthnRequest, decrypts an encrypted assertion.
      privateKey: keys.privateKey,
      publicCert: keys.certificate,
      decryptionPvk: keys.privateKey,
      acceptedClockSkewMs: CLOCK_SKEW_MS,
      maxAssertionAgeMs: MAX_ASSERTION_AGE_MS,
      validateInResponseTo: connection.allowIdpInitiated
        ? ValidateInResponseTo.ifPresent
        : ValidateInResponseTo.always,
      requestIdExpirationPeriodMs: SSO_REQUEST_TTL_MS,
      cacheProvider,
      // Let the IdP choose the NameID format and how it authenticates (MFA, Kerberos).
      identifierFormat: null,
      disableRequestedAuthnContext: true,
      signatureAlgorithm: 'sha256',
      digestAlgorithm: 'sha256',
    });
  }
}

/** Every string value of the first of these attributes present (a group list). */
function allStrings(profile: Profile, names: string[]) {
  for (const name of names) {
    const value = profile[name];
    if (value === undefined || value === null) {
      continue;
    }
    return (Array.isArray(value) ? value : [value])
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function firstString(profile: Profile, names: string[]) {
  for (const name of names) {
    const value = profile[name];
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === 'string' && first.trim()) {
      return first.trim();
    }
  }
  return undefined;
}
