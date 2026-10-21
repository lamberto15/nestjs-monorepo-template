import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generate } from 'selfsigned';
import { parseIdpMetadata } from './saml-metadata.js';
import { SamlMetadataImport } from './saml-metadata.service.js';

const body = (cert: string) =>
  cert.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');

const metadata = (
  certs: string[],
  {
    entity = 'https://idp.acme.test/saml',
    binding = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect',
    extra = '',
    use = ' use="signing"',
  } = {},
) =>
  `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${entity}"${extra}>` +
  `<md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">` +
  certs
    .map(
      (cert) =>
        `<md:KeyDescriptor${use}><ds:KeyInfo><ds:X509Data><ds:X509Certificate>\n${body(cert)}\n</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>`,
    )
    .join('') +
  `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.acme.test/post"/>` +
  `<md:SingleSignOnService Binding="${binding}" Location="https://idp.acme.test/sso"/>` +
  `</md:IDPSSODescriptor></md:EntityDescriptor>`;

/** A certificate made now (never a committed one), valid for about two years. */
const makeCert = async () => {
  const now = Date.now();
  const pems = await generate(
    [{ name: 'commonName', value: 'idp.acme.test' }],
    {
      keySize: 2048,
      algorithm: 'sha256',
      notBeforeDate: new Date(now - 2 * 86_400_000),
      notAfterDate: new Date(now + 2 * 365 * 86_400_000),
    },
  );
  return pems.cert;
};

const config = (loopback: boolean) => ({ get: () => loopback }) as never;

describe('parseIdpMetadata', () => {
  it('reads the entity id, the HTTP-Redirect URL and the signing certificates', async () => {
    const result = parseIdpMetadata(metadata([await makeCert()]));
    expect(result).toMatchObject({
      ok: true,
      metadata: {
        idpEntityId: 'https://idp.acme.test/saml',
        idpSsoUrl: 'https://idp.acme.test/sso',
      },
    });
    expect(result.ok && result.metadata.idpCertificates).toHaveLength(1);
    expect(result.ok && result.metadata.idpCertificates[0]).toContain(
      '-----BEGIN CERTIFICATE-----',
    );
  });

  it('takes a key without `use`, skips encryption keys and an expired certificate', async () => {
    const cert = await makeCert();
    expect(parseIdpMetadata(metadata([cert], { use: '' })).ok).toBe(true);
    expect(
      parseIdpMetadata(metadata([cert], { use: ' use="encryption"' })),
    ).toEqual({ ok: false, reason: 'no_signing_certificate' });
    expect(
      parseIdpMetadata(
        metadata([cert]),
        new Date(Date.now() + 5 * 365 * 86_400_000),
      ),
    ).toEqual({ ok: false, reason: 'no_signing_certificate' });
  });

  it('refuses what a connection cannot use', async () => {
    const [a, b, c] = [await makeCert(), await makeCert(), await makeCert()];
    const reason = (xml: string) => {
      const result = parseIdpMetadata(xml);
      return result.ok ? 'ok' : result.reason;
    };
    expect(reason(metadata([a, b, c]))).toBe('too_many_certificates');
    expect(reason(metadata([a], { binding: 'urn:other' }))).toBe(
      'no_redirect_sso_service',
    );
    expect(
      reason(metadata([a], { extra: ' validUntil="2020-01-01T00:00:00Z"' })),
    ).toBe('metadata_expired');
    expect(reason(metadata(['bm90IGEgY2VydA==']))).toBe('invalid_certificate');
    expect(reason('<html/>')).toBe('no_entity_descriptor');
    expect(reason('<md:EntityDescriptor')).toBe('not_xml');
    expect(reason(`<!DOCTYPE x [<!ENTITY e "boom">]>${metadata([a])}`)).toBe(
      'doctype_not_allowed',
    );
  });

  it('does not pick one of several IdPs', async () => {
    const one = metadata([await makeCert()]);
    const wrapped = `<md:EntitiesDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata">${one}${one}</md:EntitiesDescriptor>`;
    expect(parseIdpMetadata(wrapped)).toEqual({
      ok: false,
      reason: 'several_entities',
    });
  });
});

describe('SamlMetadataImport (SSRF guard)', () => {
  it('refuses http, private and metadata addresses, credentials and a name resolving to loopback', async () => {
    const service = new SamlMetadataImport(config(false));
    for (const url of [
      'http://idp.acme.test/metadata',
      'https://127.0.0.1/metadata',
      'https://[::1]/metadata',
      'https://10.0.0.5/metadata',
      'https://169.254.169.254/latest/meta-data',
      'https://user:pass@idp.acme.test/metadata',
      'https://localhost/metadata',
    ]) {
      await expect(service.import(url), url).rejects.toMatchObject({
        response: { code: 'saml_metadata_url_refused' },
      });
    }
  });

  describe('against a server on loopback (SSO_ALLOW_LOOPBACK)', () => {
    const served = { status: 200, body: '', location: '' };
    let url = '';
    let close = () => Promise.resolve();

    beforeAll(async () => {
      const server = createServer((_request, response) => {
        response.writeHead(
          served.status,
          served.location ? { location: served.location } : {},
        );
        response.end(served.body);
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/m`;
      close = () => new Promise((resolve) => server.close(() => resolve()));
    });
    afterAll(() => close());

    it('imports valid metadata', async () => {
      Object.assign(served, {
        status: 200,
        body: metadata([await makeCert()]),
      });
      await expect(
        new SamlMetadataImport(config(true)).import(url),
      ).resolves.toMatchObject({ idpEntityId: 'https://idp.acme.test/saml' });
    });

    it('does not follow a redirect, and refuses an error status, an oversized or an invalid body', async () => {
      const service = new SamlMetadataImport(config(true));
      Object.assign(served, {
        status: 302,
        location: 'http://169.254.169.254/',
        body: '',
      });
      await expect(service.import(url)).rejects.toMatchObject({
        response: { code: 'saml_metadata_unreachable' },
      });
      Object.assign(served, { status: 500, location: '' });
      await expect(service.import(url)).rejects.toMatchObject({
        response: { code: 'saml_metadata_unreachable' },
      });
      Object.assign(served, { status: 200, body: 'x'.repeat(600 * 1024) });
      await expect(service.import(url)).rejects.toMatchObject({
        response: { code: 'saml_metadata_too_large' },
      });
      served.body = '<nope/>';
      await expect(service.import(url)).rejects.toMatchObject({
        response: { code: 'saml_metadata_invalid' },
      });
    });
  });
});
