import {
  WebAuthnError,
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';

// The API answers @simplewebauthn/server's options JSON and takes the JSON
// responses @simplewebauthn/browser produces (docs/auth.md, "Passkeys"):
// `startAuthentication()` / `startRegistration()` run the browser's
// navigator.credentials ceremonies and do the base64url encoding.

export const passkeysSupported = () => browserSupportsWebAuthn();

/** An assertion for the request options the API made (sign-in, step-up). */
export async function getPasskeyAssertion(options: unknown) {
  const response = await startAuthentication({
    optionsJSON: options as PublicKeyCredentialRequestOptionsJSON,
  });
  // The library's JSON is the shape the API validates.
  return response as unknown as PasskeyAssertion;
}

/** A new credential for the creation options the API made. */
export async function createPasskey(options: unknown) {
  const response = await startRegistration({
    optionsJSON: options as PublicKeyCredentialCreationOptionsJSON,
  });
  return response as unknown as PasskeyAttestation;
}

/** The user closed the browser's prompt (or it timed out): not an error to show. */
export function isPasskeyCancelled(error: unknown): boolean {
  const cause = error instanceof WebAuthnError ? error.cause : error;
  return (
    (cause instanceof DOMException || cause instanceof Error) &&
    (cause.name === 'NotAllowedError' || cause.name === 'AbortError')
  );
}

export type PasskeyAssertion = {
  id: string;
  rawId: string;
  type: 'public-key';
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string;
  };
  clientExtensionResults?: Record<string, unknown>;
  authenticatorAttachment?: 'platform' | 'cross-platform';
};

export type PasskeyAttestation = {
  id: string;
  rawId: string;
  type: 'public-key';
  response: {
    clientDataJSON: string;
    attestationObject: string;
    transports?: string[];
    authenticatorData?: string;
    publicKey?: string;
    publicKeyAlgorithm?: number;
  };
  clientExtensionResults?: Record<string, unknown>;
  authenticatorAttachment?: 'platform' | 'cross-platform';
};
