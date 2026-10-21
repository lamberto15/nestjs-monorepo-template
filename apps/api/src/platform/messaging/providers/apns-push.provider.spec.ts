import { createVerify, generateKeyPairSync } from 'node:crypto';
import {
  createServer,
  type Http2Server,
  type IncomingHttpHeaders,
} from 'node:http2';
import type { AddressInfo } from 'node:net';
import { ApnsPushProvider } from './apns-push.provider.js';
import { PushSendError } from './push-provider.js';

const { privateKey, publicKey } = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
});
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const TOKEN = 'ab'.repeat(32);
const payload = { id: 'n1', title: 'Hello', body: 'World', link: '/notes/1' };

/** A plaintext HTTP/2 stub of APNs: answers with `state` and records requests. */
async function stub() {
  const requests: { headers: IncomingHttpHeaders; body: string }[] = [];
  const state = { status: 200, reason: undefined as string | undefined };
  const server: Http2Server = createServer();
  server.on('stream', (stream, headers) => {
    let body = '';
    stream.on('data', (chunk) => (body += chunk));
    stream.on('end', () => {
      requests.push({ headers, body });
      stream.respond({ ':status': state.status });
      stream.end(state.reason ? JSON.stringify({ reason: state.reason }) : '');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { requests, state, url, server };
}

describe('ApnsPushProvider', () => {
  let apns: Awaited<ReturnType<typeof stub>>;
  let provider: ApnsPushProvider;
  beforeEach(async () => {
    apns = await stub();
    provider = new ApnsPushProvider({
      privateKey: pem,
      keyId: 'KEY123',
      teamId: 'TEAM456',
      bundleId: 'com.example.app',
      apiUrl: apns.url,
    });
  });
  afterEach(async () => {
    provider.close();
    await new Promise((resolve) => apns.server.close(resolve));
  });

  it('sends the alert with a verifiable ES256 provider token', async () => {
    expect(await provider.send(TOKEN, payload)).toBe('sent');
    const [request] = apns.requests;
    expect(request!.headers[':path']).toBe(`/3/device/${TOKEN}`);
    expect(request!.headers['apns-topic']).toBe('com.example.app');
    expect(request!.headers['apns-push-type']).toBe('alert');
    expect(JSON.parse(request!.body)).toEqual({
      aps: { alert: { title: 'Hello', body: 'World' }, sound: 'default' },
      id: 'n1',
      link: '/notes/1',
    });
    const jwt = String(request!.headers.authorization).replace('bearer ', '');
    const [header, claims, signature] = jwt.split('.') as [
      string,
      string,
      string,
    ];
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'ES256',
      kid: 'KEY123',
    });
    expect(
      JSON.parse(Buffer.from(claims, 'base64url').toString()),
    ).toMatchObject({ iss: 'TEAM456' });
    expect(
      createVerify('SHA256')
        .update(`${header}.${claims}`)
        .verify(
          { key: publicKey, dsaEncoding: 'ieee-p1363' },
          Buffer.from(signature, 'base64url'),
        ),
    ).toBe(true);
  });

  it('reuses the provider token', async () => {
    await provider.send(TOKEN, payload);
    await provider.send(TOKEN, payload);
    const [a, b] = apns.requests.map((r) => r.headers.authorization);
    expect(a).toBe(b);
  });

  it.each([
    [410, 'Unregistered'],
    [400, 'BadDeviceToken'],
    [400, 'DeviceTokenNotForTopic'],
  ])('reports %s %s as a dead token', async (status, reason) => {
    apns.state.status = status;
    apns.state.reason = reason;
    expect(await provider.send(TOKEN, payload)).toBe('gone');
  });

  it('does not call out for something that is not a device token', async () => {
    expect(await provider.send('../../x', payload)).toBe('gone');
    expect(apns.requests).toHaveLength(0);
  });

  it.each([
    [429, 'TooManyRequests', false],
    [503, 'ServiceUnavailable', false],
    [403, 'ExpiredProviderToken', false],
    [403, 'InvalidProviderToken', true],
    [400, 'BadTopic', true],
  ])('classifies %s %s (permanent: %s)', async (status, reason, permanent) => {
    apns.state.status = status;
    apns.state.reason = reason;
    const failure = provider.send(TOKEN, payload);
    await expect(failure).rejects.toBeInstanceOf(PushSendError);
    await expect(failure).rejects.toMatchObject({ permanent });
  });

  it('signs a new token after APNs says the old one expired', async () => {
    apns.state.status = 403;
    apns.state.reason = 'ExpiredProviderToken';
    await expect(provider.send(TOKEN, payload)).rejects.toBeInstanceOf(
      PushSendError,
    );
    apns.state.status = 200;
    apns.state.reason = undefined;
    await new Promise((resolve) => setTimeout(resolve, 1100)); // iat has second resolution
    await provider.send(TOKEN, payload);
    expect(apns.requests[0]!.headers.authorization).not.toBe(
      apns.requests[1]!.headers.authorization,
    );
  });

  it('is retried when APNs is unreachable', async () => {
    provider.close();
    await new Promise((resolve) => apns.server.close(resolve));
    await expect(provider.send(TOKEN, payload)).rejects.toMatchObject({
      permanent: false,
    });
    // so afterEach has something to close
    apns.server = createServer();
    await new Promise<void>((resolve) => apns.server.listen(0, resolve));
  });
});
