import { z } from 'zod';

/** Base64url, as WebAuthn's JSON serialization carries bytes. */
const base64url = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+$/, 'base64url');

/** A credential id: authenticators make 16 to 64 bytes; 1,023 bytes is the spec's limit. */
const credentialId = base64url(1364);
/** The attestation object of a `none` attestation is a few hundred bytes; a full one (not asked for) a few KB. */
const attestationObject = base64url(65_536);

const extensionResults = z
  .record(z.string(), z.unknown())
  .default({})
  .describe('`clientExtensionResults` of the credential, usually `{}`.');

/** What `navigator.credentials.create()` answers, serialized (`PublicKeyCredential.toJSON()`, @simplewebauthn/browser's `startRegistration()`). */
export const registrationResponseSchema = z.object({
  id: credentialId,
  rawId: credentialId,
  type: z.literal('public-key'),
  response: z.object({
    clientDataJSON: base64url(8192),
    attestationObject,
    transports: z.array(z.string().max(32)).max(10).optional(),
    authenticatorData: base64url(8192).optional(),
    publicKey: base64url(4096).optional(),
    publicKeyAlgorithm: z.number().int().optional(),
  }),
  clientExtensionResults: extensionResults,
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
});

/** What `navigator.credentials.get()` answers, serialized (`startAuthentication()`). */
export const authenticationResponseSchema = z.object({
  id: credentialId,
  rawId: credentialId,
  type: z.literal('public-key'),
  response: z.object({
    clientDataJSON: base64url(8192),
    authenticatorData: base64url(8192),
    signature: base64url(4096),
    userHandle: base64url(128).optional(),
  }),
  clientExtensionResults: extensionResults,
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
});

/** What the user calls the passkey ("MacBook", "YubiKey 5C"). */
export const passkeyName = z.string().trim().min(1).max(64);

export const passkeySchema = z.object({
  id: z.string(),
  name: passkeyName,
  deviceType: z
    .enum(['singleDevice', 'multiDevice'])
    .describe(
      '`multiDevice`: a synced passkey (iCloud Keychain, Google Password Manager…); `singleDevice`: bound to one authenticator (a security key).',
    ),
  backedUp: z.boolean().describe("Synced to the user's other devices now."),
  transports: z
    .array(z.string())
    .describe(
      'How the browser reaches it: `internal`, `hybrid`, `usb`, `nfc`, `ble`.',
    ),
  lastUsedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type PasskeyView = z.infer<typeof passkeySchema>;

const credentialDescriptor = z.object({
  id: z.string(),
  type: z.literal('public-key'),
  transports: z.array(z.string()).optional(),
});

/**
 * `PublicKeyCredentialCreationOptionsJSON` (WebAuthn Level 3): give it to
 * `navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options) })`,
 * or to @simplewebauthn/browser's `startRegistration({ optionsJSON })`.
 */
export const creationOptionsSchema = z
  .object({
    rp: z.object({ id: z.string().optional(), name: z.string() }),
    user: z.object({
      id: z.string(),
      name: z.string(),
      displayName: z.string(),
    }),
    challenge: z.string(),
    pubKeyCredParams: z.array(
      z.object({ type: z.literal('public-key'), alg: z.number() }),
    ),
    timeout: z.number().optional(),
    excludeCredentials: z.array(credentialDescriptor).optional(),
    authenticatorSelection: z
      .object({
        authenticatorAttachment: z.string().optional(),
        residentKey: z.string().optional(),
        requireResidentKey: z.boolean().optional(),
        userVerification: z.string().optional(),
      })
      .optional(),
    attestation: z.string().optional(),
    extensions: z.record(z.string(), z.unknown()).optional(),
    hints: z.array(z.string()).optional(),
  })
  .describe(
    'WebAuthn creation options (JSON): `PublicKeyCredential.parseCreationOptionsFromJSON()` or @simplewebauthn/browser `startRegistration({ optionsJSON })`. The challenge works once, for PASSKEY_CHALLENGE_TTL_SECONDS.',
  );

/**
 * `PublicKeyCredentialRequestOptionsJSON`: for
 * `navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options) })`
 * or `startAuthentication({ optionsJSON })`. Without `allowCredentials`,
 * the browser offers the discoverable credentials of this site (usernameless).
 */
export const requestOptionsSchema = z
  .object({
    challenge: z.string(),
    timeout: z.number().optional(),
    rpId: z.string().optional(),
    allowCredentials: z.array(credentialDescriptor).optional(),
    userVerification: z.string().optional(),
    extensions: z.record(z.string(), z.unknown()).optional(),
    hints: z.array(z.string()).optional(),
  })
  .describe(
    'WebAuthn request options (JSON): `PublicKeyCredential.parseRequestOptionsFromJSON()` or @simplewebauthn/browser `startAuthentication({ optionsJSON })`; with `useBrowserAutofill` for a sign-in field. The challenge works once, for PASSKEY_CHALLENGE_TTL_SECONDS.',
  );
