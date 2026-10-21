import { X509Certificate } from 'node:crypto';
import { parse } from './saml-algorithms.js';

const MD = 'urn:oasis:names:tc:SAML:2.0:metadata';
const DSIG = 'http://www.w3.org/2000/09/xmldsig#';
const REDIRECT = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';

/** What a connection takes from an IdP's metadata (the schema's `saml` fields). */
export interface IdpMetadata {
  idpEntityId: string;
  idpSsoUrl: string;
  /** PEM, signing certificates only, at most two (a connection holds two). */
  idpCertificates: string[];
}

export type IdpMetadataResult =
  { ok: true; metadata: IdpMetadata } | { ok: false; reason: string };

const fail = (reason: string): IdpMetadataResult => ({ ok: false, reason });

const children = (parent: Element, ns: string, name: string) =>
  Array.from(parent.childNodes).filter(
    (node): node is Element =>
      node.nodeType === 1 &&
      (node as Element).namespaceURI === ns &&
      (node as Element).localName === name,
  );

const pem = (base64: string) =>
  `-----BEGIN CERTIFICATE-----\n${base64.match(/.{1,64}/g)?.join('\n') ?? ''}\n-----END CERTIFICATE-----\n`;

/**
 * Reads a SAML 2.0 IdP's metadata (docs/auth.md, "Importing an IdP's
 * metadata"): the entity id, the HTTP-Redirect single sign-on URL and the
 * signing certificates. Pure: no network.
 *
 * Custom: @node-saml/node-saml only *generates* service provider metadata
 * (`generateServiceProviderMetadata`) and has no parser for an IdP's, so
 * this reads it with the namespace-aware, strict xmldom parser
 * `saml-algorithms.ts` already uses (no pattern matching on XML text).
 * Refused: a DOCTYPE (entity expansion), metadata past its `validUntil`,
 * several entities (which one?), no HTTP-Redirect sign-on service, an
 * expired or unparsable certificate, more than two signing certificates.
 * The metadata's own signature is not checked: its trust is the https
 * origin the administrator named, as for the certificates typed by hand;
 * the connection's signed assertions are still verified against them.
 */
export function parseIdpMetadata(
  xml: string,
  now: Date = new Date(),
): IdpMetadataResult {
  if (/<!DOCTYPE/i.test(xml)) {
    return fail('doctype_not_allowed');
  }
  let root: Element;
  try {
    root = parse(xml).documentElement as unknown as Element;
  } catch {
    return fail('not_xml');
  }
  let entity: Element | undefined;
  if (root?.namespaceURI === MD && root.localName === 'EntityDescriptor') {
    entity = root;
  } else if (
    root?.namespaceURI === MD &&
    root.localName === 'EntitiesDescriptor'
  ) {
    const all = Array.from(root.getElementsByTagNameNS(MD, 'EntityDescriptor'));
    const idps = all.filter(
      (item) => children(item, MD, 'IDPSSODescriptor').length > 0,
    );
    if (idps.length > 1) {
      return fail('several_entities');
    }
    entity = idps[0];
  }
  if (!entity) {
    return fail('no_entity_descriptor');
  }
  for (const element of [root, entity]) {
    const until = element.getAttribute('validUntil');
    if (until && !(Date.parse(until) > now.getTime())) {
      return fail('metadata_expired');
    }
  }
  const idpEntityId = entity.getAttribute('entityID')?.trim();
  if (!idpEntityId || idpEntityId.length > 2048) {
    return fail('no_entity_id');
  }
  const [idp] = children(entity, MD, 'IDPSSODescriptor');
  if (!idp) {
    return fail('no_idp_descriptor');
  }
  const idpSsoUrl = children(idp, MD, 'SingleSignOnService')
    .find((service) => service.getAttribute('Binding') === REDIRECT)
    ?.getAttribute('Location')
    ?.trim();
  if (!idpSsoUrl) {
    return fail('no_redirect_sso_service');
  }
  const certificates = new Map<string, string>();
  for (const key of children(idp, MD, 'KeyDescriptor')) {
    const use = key.getAttribute('use');
    if (use && use !== 'signing') {
      continue;
    }
    for (const body of Array.from(
      key.getElementsByTagNameNS(DSIG, 'X509Certificate'),
    )) {
      const base64 = (body.textContent ?? '').replace(/\s+/g, '');
      let certificate: X509Certificate;
      try {
        certificate = new X509Certificate(pem(base64));
      } catch {
        return fail('invalid_certificate');
      }
      if (Date.parse(certificate.validTo) <= now.getTime()) {
        continue;
      }
      certificates.set(certificate.fingerprint256, pem(base64));
    }
  }
  if (certificates.size === 0) {
    return fail('no_signing_certificate');
  }
  if (certificates.size > 2) {
    return fail('too_many_certificates');
  }
  return {
    ok: true,
    metadata: {
      idpEntityId,
      idpSsoUrl,
      idpCertificates: [...certificates.values()],
    },
  };
}
