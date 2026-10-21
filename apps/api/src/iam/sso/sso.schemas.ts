import { X509Certificate } from 'node:crypto';
import { z } from 'zod';
import {
  OAUTH2_AUTH_METHODS,
  oauth2MappingSchema,
  oauth2PresetSchema,
} from './oauth2-mapping.js';

const name = z.string().trim().min(1).max(120);
const httpsUrl = z
  .url({ protocol: /^https?$/ })
  .max(2048)
  .describe(
    'An https:// URL (http:// only on loopback with SSO_ALLOW_LOOPBACK=on, for development).',
  );

/**
 * A PEM certificate, as the IdP's metadata gives it: with or without its
 * BEGIN/END lines. Parsed (node:crypto) and stored as PEM, so a wrong
 * paste is a 400, not a sign-in that never verifies.
 */
export const certificate = z
  .string()
  .trim()
  .min(1)
  .max(16_384)
  .transform((value, context) => {
    const body = value
      .replace(/-----(BEGIN|END) CERTIFICATE-----/g, '')
      .replace(/\s+/g, '');
    const pem = `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)?.join('\n') ?? ''}\n-----END CERTIFICATE-----\n`;
    try {
      new X509Certificate(pem);
      return pem;
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'Not an X.509 certificate (PEM or base64).',
      });
      return z.NEVER;
    }
  });

const roleMapping = z.object({
  group: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .describe(
      "The IdP's group (a value of `groupsAttribute`), compared exactly: a name, or the IdP's group id (Entra ID sends ids).",
    ),
  roleId: z.uuid(),
});

const roleFields = {
  groupsAttribute: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .nullable()
    .optional()
    .describe(
      'Where the IdP lists the groups: a SAML attribute or an ID token claim. `groups` when null. Not for an OAuth 2.0 connection: its `mapping.groups` says.',
    ),
  roleMappings: z
    .array(roleMapping)
    .max(100)
    .optional()
    .describe(
      'The roles a group gives: at each sign-in, the person gets the roles of the groups the IdP lists, and loses those a mapping gave that it no longer lists. Roles you give or take yourself stay yours. You must be able to grant each role.',
    ),
  defaultRoleIds: z
    .array(z.uuid())
    .max(20)
    .optional()
    .describe(
      'The roles a member provisioned just in time gets at their first sign-in (once). You must be able to grant each.',
    ),
};

const common = {
  name,
  ...roleFields,
  enabled: z
    .boolean()
    .optional()
    .describe('Off by default: the connection signs nobody in until on.'),
  jitProvisioning: z
    .boolean()
    .optional()
    .describe(
      'A person of a verified domain who is not a member yet becomes one at their first sign-in. Off by default.',
    ),
};

const oidcFields = {
  issuer: httpsUrl.describe(
    'The OpenID Connect issuer; its discovery document is fetched on the queue.',
  ),
  clientId: z.string().trim().min(1).max(512),
  clientSecret: z
    .string()
    .min(1)
    .max(4096)
    .describe('Stored encrypted, never returned.'),
};

/** An RFC 6749 scope token: printable ASCII, no space, quote or backslash. */
const scope = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[\x21\x23-\x5B\x5D-\x7E]+$/, 'A scope token (no spaces).');

const oauth2Fields = {
  preset: oauth2PresetSchema
    .optional()
    .describe(
      "A provider's defaults for the fields below (each field given overrides its default): `lark` fills Lark/Feishu v2's endpoints, `client_secret_post` and the mapping. Only when creating.",
    ),
  authorizationEndpoint: httpsUrl
    .optional()
    .describe(
      'Where the browser is sent to sign in. Required without a preset.',
    ),
  tokenEndpoint: httpsUrl
    .optional()
    .describe(
      'Where the code is exchanged (RFC 6749, PKCE). Required without a preset.',
    ),
  userinfoEndpoint: httpsUrl
    .optional()
    .describe(
      'Read once per sign-in with the access token; `mapping` reads its answer. Required without a preset.',
    ),
  clientId: oidcFields.clientId,
  clientSecret: oidcFields.clientSecret
    .optional()
    .describe(
      'Stored encrypted, never returned. Required unless `tokenEndpointAuthMethod` is `none`.',
    ),
  tokenEndpointAuthMethod: z
    .enum(OAUTH2_AUTH_METHODS)
    .optional()
    .describe(
      'How the client authenticates at the token endpoint: `client_secret_basic` by default (RFC 6749), `client_secret_post`, or `none` (a public client). PKCE is always on.',
    ),
  scopes: z
    .array(scope)
    .max(50)
    .optional()
    .describe('The scopes asked for (none by default).'),
  mapping: oauth2MappingSchema
    .optional()
    .describe(
      'Where the user-info answer holds the person. Required without a preset. Paths are dots between names (`data.open_id`), read in the user object at `root`; `errorCode` in the whole answer.',
    ),
};

const samlFields = {
  idpEntityId: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .describe("The IdP's entity id: what its assertions name as `Issuer`."),
  idpSsoUrl: httpsUrl.describe(
    "The IdP's single sign-on URL (HTTP-Redirect binding).",
  ),
  idpCertificates: z
    .array(certificate)
    .min(1)
    .max(2)
    .describe(
      "The IdP's signing certificates: one, or two while it rotates. Only signed assertions are accepted.",
    ),
  allowIdpInitiated: z
    .boolean()
    .optional()
    .describe(
      'Accept sign-ins the IdP starts (no request of ours): a login-CSRF vector, off by default.',
    ),
  requireEncryptedAssertions: z
    .boolean()
    .optional()
    .describe(
      'Refuse an assertion not encrypted to `saml.spCertificate`. Off by default: an encrypted one is decrypted, a plain one accepted (both must be signed).',
    ),
};

export const importSamlMetadataSchema = z.object({
  url: httpsUrl.describe("The IdP's SAML metadata URL."),
});

export const importedSamlMetadataSchema = z.object({
  idpEntityId: z.string(),
  idpSsoUrl: z.string(),
  idpCertificates: z
    .array(z.string())
    .describe('PEM, the signing certificates (one or two).'),
});

export const createConnectionSchema = z.discriminatedUnion('protocol', [
  z.object({ protocol: z.literal('oidc'), ...common, ...oidcFields }),
  z.object({ protocol: z.literal('saml'), ...common, ...samlFields }),
  z.object({ protocol: z.literal('oauth2'), ...common, ...oauth2Fields }),
]);
export type CreateConnection = z.infer<typeof createConnectionSchema>;

/** A change: any field of either protocol (one that isn't the connection's is a 400). */
export const updateConnectionSchema = z.object({
  name: name.optional(),
  enabled: z.boolean().optional(),
  jitProvisioning: z.boolean().optional(),
  issuer: oidcFields.issuer
    .optional()
    .describe('A new issuer: its discovery document is fetched again.'),
  clientId: oidcFields.clientId.optional(),
  clientSecret: oidcFields.clientSecret.optional(),
  idpEntityId: samlFields.idpEntityId.optional(),
  idpSsoUrl: samlFields.idpSsoUrl.optional(),
  idpCertificates: samlFields.idpCertificates.optional(),
  allowIdpInitiated: z.boolean().optional(),
  requireEncryptedAssertions: z.boolean().optional(),
  authorizationEndpoint: oauth2Fields.authorizationEndpoint,
  tokenEndpoint: oauth2Fields.tokenEndpoint,
  userinfoEndpoint: oauth2Fields.userinfoEndpoint,
  tokenEndpointAuthMethod: oauth2Fields.tokenEndpointAuthMethod,
  scopes: oauth2Fields.scopes,
  mapping: oauth2MappingSchema
    .optional()
    .describe('Replaces the whole mapping.'),
  ...roleFields,
});
export type UpdateConnection = z.infer<typeof updateConnectionSchema>;

export const connectionSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  protocol: z.enum(['oidc', 'saml', 'oauth2']),
  enabled: z.boolean(),
  jitProvisioning: z.boolean(),
  // Part 2's fields are always sent; optional in the schema only, so
  // frontends' fixtures typed before them (apps/web's) still compile.
  groupsAttribute: z.string().nullable().optional(),
  roleMappings: z.array(roleMapping).optional(),
  defaultRoleIds: z.array(z.uuid()).optional(),
  loginUrl: z
    .string()
    .describe(
      'Where the browser starts a sign-in (`?redirectTo=` a path of the web app).',
    ),
  oidc: z
    .object({
      issuer: z.string(),
      clientId: z.string(),
      redirectUri: z
        .string()
        .describe('The redirect URI to register at the IdP.'),
      metadataFetchedAt: z.iso.datetime().nullable(),
      metadataError: z.string().nullable(),
    })
    .nullable(),
  saml: z
    .object({
      idpEntityId: z.string(),
      idpSsoUrl: z.string(),
      idpCertificates: z.array(
        z.object({
          subject: z.string(),
          notAfter: z.iso.datetime(),
          fingerprint256: z.string(),
        }),
      ),
      allowIdpInitiated: z.boolean(),
      requireEncryptedAssertions: z.boolean().optional(),
      spCertificate: z
        .object({
          pem: z.string(),
          subject: z.string(),
          notAfter: z.iso.datetime(),
          fingerprint256: z.string(),
        })
        .nullable()
        .optional()
        .describe(
          'Ours: it signs our AuthnRequests and the IdP encrypts assertions to it (also in our metadata).',
        ),
      spEntityId: z
        .string()
        .describe(
          "Our entity id (the metadata's URL): the assertions' audience.",
        ),
      acsUrl: z
        .string()
        .describe('The assertion consumer service URL to register at the IdP.'),
      metadataUrl: z.string().describe('Our SP metadata (XML) for the IdP.'),
    })
    .nullable(),
  // Optional in the schema only (always sent), as Part 2's fields above.
  oauth2: z
    .object({
      authorizationEndpoint: z.string(),
      tokenEndpoint: z.string(),
      userinfoEndpoint: z.string(),
      clientId: z.string(),
      tokenEndpointAuthMethod: z.enum(OAUTH2_AUTH_METHODS),
      scopes: z.array(z.string()),
      mapping: oauth2MappingSchema,
      preset: oauth2PresetSchema
        .nullable()
        .describe('The preset that filled the fields at creation, if any.'),
      redirectUri: z
        .string()
        .describe('The redirect URI to register at the provider.'),
    })
    .nullable()
    .optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/** A domain name: letters, digits and hyphens in dot-separated labels, at least two. */
export const domainSchema = z.object({
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .max(253)
    .regex(
      /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/,
      'A domain name, such as example.com.',
    ),
});

export const domainViewSchema = z.object({
  id: z.uuid(),
  domain: z.string(),
  verified: z.boolean(),
  verifiedAt: z.iso.datetime().nullable(),
  lastCheckedAt: z.iso.datetime().nullable(),
  lastError: z.string().nullable(),
  record: z
    .object({
      type: z.literal('TXT'),
      name: z.string(),
      value: z.string(),
    })
    .describe('The DNS record that proves the domain is the tenant’s.'),
  createdAt: z.iso.datetime(),
});

export const policySchema = z.object({
  requireSso: z
    .boolean()
    .describe(
      'Members act in this tenant only through one of its connections: a password, passkey, link or Google sign-in, or an access token, gets 403 `sso_required` here (the exempted excepted).',
    ),
});

export const exemptionSchema = z.object({
  userId: z.uuid(),
  email: z.string(),
  name: z.string(),
  reason: z.string(),
  createdBy: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});

export const policyViewSchema = policySchema.extend({
  updatedAt: z.iso.datetime().nullable(),
  exemptions: z
    .array(exemptionSchema)
    .describe(
      'Break-glass members: their password and passkey still sign in here (each use audited, `sso.exemption-used`).',
    ),
});

export const exemptSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe('Why (an emergency administrator, the IdP outage plan).'),
});

export const acceptedSchema = z.object({ accepted: z.literal(true) });
