import {
  checkXmlAlgorithms,
  hasEncryptedAssertion,
} from './saml-algorithms.js';

const signed = (signature: string, digest: string) =>
  `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_a">` +
  `<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:SignedInfo>` +
  `<ds:SignatureMethod Algorithm="${signature}"/>` +
  `<ds:Reference URI="#_a"><ds:DigestMethod Algorithm="${digest}"/></ds:Reference>` +
  `</ds:SignedInfo></ds:Signature></saml:Assertion>`;

const RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
const SHA256 = 'http://www.w3.org/2001/04/xmlenc#sha256';

describe('checkXmlAlgorithms (SAML allowlist)', () => {
  it('accepts RSA-SHA256 with SHA-256 digests', () => {
    expect(
      checkXmlAlgorithms(signed(RSA_SHA256, SHA256), { signed: true }),
    ).toBeUndefined();
  });

  it('refuses SHA-1 signatures and digests', () => {
    expect(
      checkXmlAlgorithms(
        signed('http://www.w3.org/2000/09/xmldsig#rsa-sha1', SHA256),
        { signed: true },
      ),
    ).toBe('signature:http://www.w3.org/2000/09/xmldsig#rsa-sha1');
    expect(
      checkXmlAlgorithms(
        signed(RSA_SHA256, 'http://www.w3.org/2000/09/xmldsig#sha1'),
        { signed: true },
      ),
    ).toBe('digest:http://www.w3.org/2000/09/xmldsig#sha1');
  });

  it('refuses what it does not know, an entity-encoded value included (fails closed)', () => {
    expect(
      checkXmlAlgorithms(
        signed('http://www.w3.org/2000/09/xmldsig&#x23;rsa-sha1', SHA256),
        { signed: true },
      ),
    ).toBe('signature:http://www.w3.org/2000/09/xmldsig#rsa-sha1');
    expect(
      checkXmlAlgorithms(signed('urn:made-up', SHA256), { signed: true }),
    ).toBe('signature:urn:made-up');
  });

  it('wants a signature when asked, and a document that parses', () => {
    expect(checkXmlAlgorithms('<Assertion ID="_a"/>', { signed: true })).toBe(
      'unsigned',
    );
    expect(checkXmlAlgorithms('', { signed: true })).toBe('no_document');
    expect(checkXmlAlgorithms('<a><b></a>', { signed: false })).toBe(
      'unparsable',
    );
  });

  it("refuses RSA v1.5 key transport but not OAEP's own SHA-1", () => {
    const encrypted = (keyTransport: string) =>
      `<saml:EncryptedAssertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">` +
      `<xenc:EncryptedData xmlns:xenc="http://www.w3.org/2001/04/xmlenc#">` +
      `<xenc:EncryptionMethod Algorithm="http://www.w3.org/2009/xmlenc11#aes256-gcm"/>` +
      `<ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><xenc:EncryptedKey>` +
      `<xenc:EncryptionMethod Algorithm="${keyTransport}"><ds:DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/></xenc:EncryptionMethod>` +
      `</xenc:EncryptedKey></ds:KeyInfo></xenc:EncryptedData></saml:EncryptedAssertion>`;
    expect(
      checkXmlAlgorithms(
        encrypted('http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p'),
        { signed: false },
      ),
    ).toBeUndefined();
    expect(
      checkXmlAlgorithms(
        encrypted('http://www.w3.org/2001/04/xmlenc#rsa-1_5'),
        {
          signed: false,
        },
      ),
    ).toBe('encryption:http://www.w3.org/2001/04/xmlenc#rsa-1_5');
    expect(
      hasEncryptedAssertion(
        `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol">${encrypted('x')}</samlp:Response>`,
      ),
    ).toBe(true);
    expect(hasEncryptedAssertion(signed(RSA_SHA256, SHA256))).toBe(false);
  });
});
