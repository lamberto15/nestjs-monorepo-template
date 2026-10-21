import { createVerify, generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FcmPushProvider } from './fcm-push.provider.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const payload = { id: 'n1', title: 'Hello', body: 'World', link: '/notes/1' };

interface Seen {
  url: string;
  authorization?: string;
  body: string;
}

describe('FcmPushProvider', () => {
  let server: Server;
  let base: string;
  let seen: Seen[];
  let sendReply: { status: number; body: unknown };
  let tokenReply: { status: number; body: unknown };
  let provider: FcmPushProvider;

  beforeEach(async () => {
    seen = [];
    sendReply = { status: 200, body: { name: 'projects/p/messages/1' } };
    tokenReply = {
      status: 200,
      body: { access_token: 'access-1', expires_in: 3600 },
    };
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        seen.push({
          url: req.url!,
          authorization: req.headers.authorization,
          body,
        });
        const reply = req.url === '/token' ? tokenReply : sendReply;
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    provider = new FcmPushProvider({
      projectId: 'my-project',
      clientEmail: 'sa@my-project.iam.gserviceaccount.com',
      privateKey: pem,
      apiUrl: base,
      tokenUrl: `${base}/token`,
    });
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it('exchanges a signed assertion for a token, then sends with it', async () => {
    expect(await provider.send('device-token', payload)).toBe('sent');
    const [exchange, send] = seen;
    const form = new URLSearchParams(exchange!.body);
    expect(form.get('grant_type')).toBe(
      'urn:ietf:params:oauth:grant-type:jwt-bearer',
    );
    const [header, claims, signature] = form.get('assertion')!.split('.') as [
      string,
      string,
      string,
    ];
    expect(JSON.parse(Buffer.from(header, 'base64url').toString()).alg).toBe(
      'RS256',
    );
    expect(
      JSON.parse(Buffer.from(claims, 'base64url').toString()),
    ).toMatchObject({
      iss: 'sa@my-project.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: `${base}/token`,
    });
    expect(
      createVerify('RSA-SHA256')
        .update(`${header}.${claims}`)
        .verify(publicKey, Buffer.from(signature, 'base64url')),
    ).toBe(true);
    expect(send!.url).toBe('/v1/projects/my-project/messages:send');
    expect(send!.authorization).toBe('Bearer access-1');
    expect(JSON.parse(send!.body)).toEqual({
      message: {
        token: 'device-token',
        notification: { title: 'Hello', body: 'World' },
        data: { id: 'n1', link: '/notes/1' },
        android: { priority: 'HIGH' },
      },
    });
  });

  it('caches the access token', async () => {
    await provider.send('t', payload);
    await provider.send('t', payload);
    expect(seen.filter((r) => r.url === '/token')).toHaveLength(1);
  });

  it.each([
    [404, { error: { status: 'NOT_FOUND' } }],
    [404, { error: { status: 'UNREGISTERED' } }],
    [
      400,
      {
        error: {
          status: 'INVALID_ARGUMENT',
          message:
            'The registration token is not a valid FCM registration token',
        },
      },
    ],
  ])('reports %s as a dead token', async (status, body) => {
    sendReply = { status, body };
    expect(await provider.send('t', payload)).toBe('gone');
  });

  it.each([
    [429, false],
    [503, false],
    [401, false],
    [403, true],
    [400, true],
  ])('classifies %s (permanent: %s)', async (status, permanent) => {
    sendReply = { status, body: { error: { status: 'X', message: 'nope' } } };
    await expect(provider.send('t', payload)).rejects.toMatchObject({
      permanent,
    });
  });

  it('gets a new access token after a 401', async () => {
    sendReply = { status: 401, body: {} };
    await expect(provider.send('t', payload)).rejects.toBeTruthy();
    sendReply = { status: 200, body: {} };
    await provider.send('t', payload);
    expect(seen.filter((r) => r.url === '/token')).toHaveLength(2);
  });

  it('fails for good when Google refuses the service account', async () => {
    tokenReply = { status: 400, body: { error: 'invalid_grant' } };
    await expect(provider.send('t', payload)).rejects.toMatchObject({
      permanent: true,
    });
  });
});
