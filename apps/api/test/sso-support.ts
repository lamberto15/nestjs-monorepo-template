import {
  generateKeyPairSync,
  randomUUID,
  sign,
  type KeyObject,
} from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inflateRawSync } from 'node:zlib';
import { generate } from 'selfsigned';
import type request from 'supertest';
import { SignedXml } from 'xml-crypto';
import { SsoProcessor } from '../src/iam/sso/sso.processor.js';
import type { TxtResolver } from '../src/iam/sso/sso.queue.js';
import type { TestApp } from './support.js';

/**
 * Test doubles of a tenant's identity provider (docs/auth.md, "Enterprise
 * SSO"): no real IdP, no committed key. Keys and certificates are made at
 * run time; SAML responses are signed with xml-crypto as an IdP signs them;
 * the OpenID Connect provider is a server on loopback (SSO_ALLOW_LOOPBACK).
 */

/** A path of this app from one of its absolute URLs (APP_URL has no port). */
export const local = (url: string) => {
  const { pathname, search } = new URL(url);
  return pathname + search;
};

/** DNS as the tests set it: TXT records by name. */
export function fakeDns() {
  const records = new Map<string, string[][]>();
  const resolver: TxtResolver = {
    resolveTxt: (name) => {
      const found = records.get(name);
      return found
        ? Promise.resolve(found)
        : Promise.reject(
            Object.assign(new Error(`queryTxt ENOTFOUND ${name}`), {
              code: 'ENOTFOUND',
            }),
          );
    },
  };
  return { records, resolver };
}

/**
 * `domain` added and verified in the agent's tenant: its TXT record
 * published in the fake DNS, the check run as the worker runs it.
 */
export async function verifyDomain(
  node: TestApp,
  dns: ReturnType<typeof fakeDns>,
  agent: request.Agent,
  tenantId: string,
  domain: string,
) {
  const created = await agent
    .post('/v1/sso/domains')
    .send({ domain })
    .expect(201);
  dns.records.set(created.body.record.name, [[created.body.record.value]]);
  await agent.post(`/v1/sso/domains/${created.body.id}/verify`).expect(202);
  await node.app.get(SsoProcessor).run({
    kind: 'domain-verification',
    domainId: created.body.id,
    tenantId,
  });
  return created.body.id as string;
}

/** A SAML IdP: its signing key and certificate, made now. */
export async function samlIdp(entityId = 'https://idp.acme.test/saml') {
  const pems = await generate(
    [{ name: 'commonName', value: 'idp.acme.test' }],
    {
      keySize: 2048,
      algorithm: 'sha256',
    },
  );
  return { entityId, key: pems.private, cert: pems.cert };
}
export type SamlIdp = Awaited<ReturnType<typeof samlIdp>>;

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * A SAML response as an IdP posts it: the assertion signed (enveloped
 * signature, RSA-SHA256, exclusive c14n), in an unsigned Response.
 */
export function samlResponse(
  idp: SamlIdp,
  options: {
    audience: string;
    acs: string;
    nameId: string;
    email?: string;
    inResponseTo?: string;
    assertionId?: string;
    notOnOrAfter?: number;
    issuer?: string;
    signWith?: { key: string; cert: string };
    tamper?: (signedAssertion: string) => string;
  },
) {
  const now = Date.now();
  const issuer = options.issuer ?? idp.entityId;
  const notOnOrAfter = iso(options.notOnOrAfter ?? now + 5 * 60_000);
  const inResponseTo = options.inResponseTo
    ? ` InResponseTo="${options.inResponseTo}"`
    : '';
  const assertion =
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${options.assertionId ?? `_${randomUUID()}`}" Version="2.0" IssueInstant="${iso(now)}">` +
    `<saml:Issuer>${issuer}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">${options.nameId}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData${inResponseTo} NotOnOrAfter="${notOnOrAfter}" Recipient="${options.acs}"/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${iso(now - 60_000)}" NotOnOrAfter="${notOnOrAfter}"><saml:AudienceRestriction><saml:Audience>${options.audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${iso(now - 1000)}" SessionIndex="_${randomUUID()}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    (options.email
      ? `<saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>${options.email}</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>`
      : '') +
    `</saml:Assertion>`;
  const signer = options.signWith ?? idp;
  const signature = new SignedXml({
    privateKey: signer.key,
    publicCert: signer.cert,
    signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
  });
  signature.addReference({
    xpath: "//*[local-name(.)='Assertion']",
    transforms: [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      'http://www.w3.org/2001/10/xml-exc-c14n#',
    ],
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
  });
  signature.computeSignature(assertion, {
    location: { reference: "//*[local-name(.)='Issuer']", action: 'after' },
  });
  let signed = signature.getSignedXml();
  if (options.tamper) {
    signed = options.tamper(signed);
  }
  const response =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_${randomUUID()}" Version="2.0" IssueInstant="${iso(now)}" Destination="${options.acs}"${inResponseTo}>` +
    `<saml:Issuer>${issuer}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    signed +
    `</samlp:Response>`;
  return Buffer.from(response).toString('base64');
}

/** The AuthnRequest's ID in a redirect to the IdP (HTTP-Redirect binding: deflated, base64). */
export function authnRequestId(location: string) {
  const encoded = new URL(location).searchParams.get('SAMLRequest')!;
  const xml = inflateRawSync(Buffer.from(encoded, 'base64')).toString();
  return /\sID="([^"]+)"/.exec(xml)![1];
}

/**
 * An OpenID Connect provider on loopback: discovery, its JWKS, and a
 * token endpoint answering the codes a test plants (`issue()`), each with
 * the ID token's claims.
 */
export async function oidcIdp(clientId: string) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const codes = new Map<string, Record<string, unknown>>();
  const tokenRequests: URLSearchParams[] = [];
  let issuer = '';
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', issuer);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (url.pathname === '/jwks') {
      return json(200, {
        keys: [
          {
            ...publicKey.export({ format: 'jwk' }),
            kid: 'k1',
            alg: 'RS256',
            use: 'sig',
          },
        ],
      });
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        const form = new URLSearchParams(body);
        tokenRequests.push(form);
        const claims = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        if (!claims) {
          return json(400, { error: 'invalid_grant' });
        }
        json(200, {
          access_token: randomUUID(),
          token_type: 'Bearer',
          expires_in: 300,
          id_token: jwt(privateKey, claims),
        });
      });
      return;
    }
    json(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    get issuer() {
      return issuer;
    },
    tokenRequests,
    /** A code for the authorization request at `location`: its ID token carries these claims (and the request's nonce, unless given). */
    issue(location: string, claims: Record<string, unknown>) {
      const params = new URL(location).searchParams;
      const now = Math.floor(Date.now() / 1000);
      const code = randomUUID();
      codes.set(code, {
        iss: issuer,
        aud: clientId,
        iat: now,
        exp: now + 300,
        nonce: params.get('nonce'),
        ...claims,
      });
      return { code, state: params.get('state')! };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function jwt(key: KeyObject, claims: Record<string, unknown>) {
  const part = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${part({ alg: 'RS256', kid: 'k1', typ: 'JWT' })}.${part(claims)}`;
  return `${input}.${sign('sha256', Buffer.from(input), key).toString('base64url')}`;
}
