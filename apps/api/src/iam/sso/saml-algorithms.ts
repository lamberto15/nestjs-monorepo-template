import { DOMParser } from '@xmldom/xmldom';

const DSIG = 'http://www.w3.org/2000/09/xmldsig#';
const XMLENC = 'http://www.w3.org/2001/04/xmlenc#';
const SAML_ASSERTION = 'urn:oasis:names:tc:SAML:2.0:assertion';

/** Signatures: RSA or ECDSA with SHA-2 (xml-crypto also takes RSA-SHA1, refused here). */
const SIGNATURE_ALGORITHMS = new Set([
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha384',
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha512',
  'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256',
  'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha384',
  'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha512',
]);

/** A signature's references' digests: SHA-2 only. */
const DIGEST_ALGORITHMS = new Set([
  'http://www.w3.org/2001/04/xmlenc#sha256',
  'http://www.w3.org/2001/04/xmldsig-more#sha384',
  'http://www.w3.org/2001/04/xmlenc#sha512',
]);

/**
 * Encryption: AES (CBC, as most IdPs still send, or GCM) for the data,
 * RSA-OAEP for its key. RSA PKCS#1 v1.5 and 3DES are refused. CBC is safe
 * here only because the Response's signature is checked before anything is
 * decrypted (`wantAuthnResponseSigned`): a tampered ciphertext never
 * reaches the decryption, so there is no padding oracle.
 */
const ENCRYPTION_ALGORITHMS = new Set([
  'http://www.w3.org/2001/04/xmlenc#aes128-cbc',
  'http://www.w3.org/2001/04/xmlenc#aes256-cbc',
  'http://www.w3.org/2009/xmlenc11#aes128-gcm',
  'http://www.w3.org/2009/xmlenc11#aes256-gcm',
  'http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p',
  'http://www.w3.org/2009/xmlenc11#rsa-oaep',
]);

export const parse = (xml: string) =>
  new DOMParser({
    // A document that doesn't parse cleanly is refused, never repaired:
    // xmldom reports an unclosed tag as a mere warning.
    errorHandler: {
      warning: (message) => {
        throw new Error(message);
      },
      error: (message) => {
        throw new Error(message);
      },
      fatalError: (message) => {
        throw new Error(message);
      },
    },
  }).parseFromString(xml, 'text/xml');

// xmldom's types are the DOM's (lib "dom", referenced by its typings).
const elements = (root: Document | Element, ns: string, name: string) =>
  Array.from(root.getElementsByTagNameNS(ns, name));

/**
 * Why a SAML document's cryptography falls short of what this app accepts,
 * or undefined when it doesn't (docs/auth.md, "What is checked"). Run on
 * what node-saml already verified, for what it lets through: SHA-1
 * signatures and digests (xml-crypto 6 still accepts them), and weak
 * encryption. Read with a namespace-aware parser (no pattern matching on
 * XML text); an algorithm not on the lists is refused, so anything
 * unexpected fails closed. `signed`: the document must carry a signature.
 *
 * Custom: node-saml and xml-crypto take no list of allowed algorithms for
 * verification (xml-crypto's own maps are global and include SHA-1).
 */
export function checkXmlAlgorithms(
  xml: string,
  { signed }: { signed: boolean },
): string | undefined {
  if (!xml) {
    return signed ? 'no_document' : undefined;
  }
  let document: Document;
  try {
    document = parse(xml);
  } catch {
    return 'unparsable';
  }
  const signatures = elements(document, DSIG, 'Signature');
  if (signed && signatures.length === 0) {
    return 'unsigned';
  }
  for (const signature of signatures) {
    for (const method of elements(signature, DSIG, 'SignatureMethod')) {
      const algorithm = method.getAttribute('Algorithm') ?? '';
      if (!SIGNATURE_ALGORITHMS.has(algorithm)) {
        return `signature:${algorithm}`;
      }
    }
    for (const reference of elements(signature, DSIG, 'Reference')) {
      for (const digest of elements(reference, DSIG, 'DigestMethod')) {
        const algorithm = digest.getAttribute('Algorithm') ?? '';
        if (!DIGEST_ALGORITHMS.has(algorithm)) {
          return `digest:${algorithm}`;
        }
      }
    }
  }
  // OAEP's own DigestMethod (inside an EncryptionMethod) may be SHA-1: it
  // is a mask function's hash there, not a signature's.
  for (const method of elements(document, XMLENC, 'EncryptionMethod')) {
    const algorithm = method.getAttribute('Algorithm') ?? '';
    if (!ENCRYPTION_ALGORITHMS.has(algorithm)) {
      return `encryption:${algorithm}`;
    }
  }
  return undefined;
}

/** Whether the Response carries its assertion encrypted (`EncryptedAssertion`). */
export function hasEncryptedAssertion(responseXml: string) {
  try {
    return (
      elements(parse(responseXml), SAML_ASSERTION, 'EncryptedAssertion')
        .length === 1
    );
  } catch {
    return false;
  }
}
