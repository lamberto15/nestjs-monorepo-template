import { X509Certificate } from 'node:crypto';
import { generate } from 'selfsigned';

/** How long our SP certificate is valid: the IdP pins it, so long, but not forever. */
const SP_CERTIFICATE_YEARS = 5;

/**
 * Our key pair for one SAML connection (docs/auth.md, "What is checked"):
 * it signs the AuthnRequests and the IdP encrypts assertions to its
 * certificate. Made with `selfsigned` (WebCrypto underneath): SAML
 * metadata carries a bare certificate, which no CA needs to sign (the IdP
 * trusts what it imported). One per connection, so a leak or a rotation
 * touches one IdP. RSA, as every IdP supports it; 3072 bits (NIST SP
 * 800-57) for a certificate meant to outlive 2030.
 */
export async function newSpKeyPair(commonName: string) {
  const now = Date.now();
  const pems = await generate([{ name: 'commonName', value: commonName }], {
    keyType: 'rsa',
    keySize: 3072,
    algorithm: 'sha256',
    notBeforeDate: new Date(now - 60_000),
    notAfterDate: new Date(now + SP_CERTIFICATE_YEARS * 365 * 86_400_000),
  });
  return { privateKey: pems.private, certificate: pems.cert };
}

/** What an administrator sees of a certificate (never a key). */
export function describeCertificate(pem: string) {
  const certificate = new X509Certificate(pem);
  return {
    subject: certificate.subject,
    notAfter: new Date(certificate.validTo).toISOString(),
    fingerprint256: certificate.fingerprint256,
  };
}
