import { X509Certificate } from 'node:crypto';
import { z } from 'zod';

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
      'Where the IdP lists the groups: a SAML attribute or an ID token claim. `groups` when null.',
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

export const createConnectionSchema = z.discriminatedUnion('protocol', [
  z.object({ protocol: z.literal('oidc'), ...common, ...oidcFields }),
  z.object({ protocol: z.literal('saml'), ...common, ...samlFields }),
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
  ...roleFields,
});
export type UpdateConnection = z.infer<typeof updateConnectionSchema>;

export const connectionSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  protocol: z.enum(['oidc', 'saml']),
  enabled: z.boolean(),
  jitProvisioning: z.boolean(),
  groupsAttribute: z.string().nullable(),
  roleMappings: z.array(roleMapping),
  defaultRoleIds: z.array(z.uuid()),
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
      requireEncryptedAssertions: z.boolean(),
      spCertificate: z
        .object({
          pem: z.string(),
          subject: z.string(),
          notAfter: z.iso.datetime(),
          fingerprint256: z.string(),
        })
        .nullable()
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
