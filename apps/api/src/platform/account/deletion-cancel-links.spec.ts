import { randomBytes, randomUUID } from 'node:crypto';
import { JwtSigner, JwtVerifier } from '@nestjs/authentication';
import { DeletionCancelLinks } from './deletion-cancel-links.js';

const DAY = 86_400_000;
const ISSUER = 'https://api.example.com';

describe('DeletionCancelLinks', () => {
  const secret = randomBytes(32).toString('base64url');
  const deletion = (scheduledInDays = 14, at = Date.now()) => ({
    id: randomUUID(),
    userId: randomUUID(),
    scheduledFor: new Date(at + scheduledInDays * DAY),
  });

  it('names the request and its user, and nothing else', async () => {
    const links = new DeletionCancelLinks(secret, ISSUER);
    const request = deletion();
    expect(await links.verify(links.sign(request))).toEqual({
      userId: request.userId,
      deletionId: request.id,
    });
  });

  it('expires a day after the scheduled date (the job runs nightly)', async () => {
    let now = Date.now();
    const links = new DeletionCancelLinks(secret, ISSUER, () => now);
    const token = links.sign(deletion(14, now));
    now += 14 * DAY + DAY - 60_000;
    expect(await links.verify(token)).not.toBeNull();
    now += 2 * 60_000;
    expect(await links.verify(token)).toBeNull();
  });

  it('refuses a token signed with another secret, for another issuer, or altered', async () => {
    const request = deletion();
    const token = new DeletionCancelLinks(secret, ISSUER).sign(request);
    expect(
      await new DeletionCancelLinks(
        randomBytes(32).toString('base64url'),
        ISSUER,
      ).verify(token),
    ).toBeNull();
    expect(
      await new DeletionCancelLinks(secret, 'https://other.example.com').verify(
        token,
      ),
    ).toBeNull();
    const [header, payload, signature] = token.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const forged = Buffer.from(
      JSON.stringify({ ...claims, did: randomUUID() }),
    ).toString('base64url');
    const links = new DeletionCancelLinks(secret, ISSUER);
    expect(await links.verify(`${header}.${forged}.${signature}`)).toBeNull();
    for (const garbage of ['', 'not-a-jwt', `${header}.${payload}.`]) {
      expect(await links.verify(garbage)).toBeNull();
    }
  });

  it('is no access token, and takes none: another key, audience and type than JWT_SECRET signs them with', async () => {
    const request = deletion();
    const links = new DeletionCancelLinks(secret, ISSUER);
    // The access tokens' signer and verifier (IamModule: JWT_SECRET itself, APP_URL, SERVICE_NAME).
    const access = {
      key: secret,
      issuer: ISSUER,
      audience: 'nestjs-monorepo-template',
    };
    const accessToken = new JwtSigner(access).sign({
      sub: request.userId,
      did: request.id,
    });
    expect(await links.verify(accessToken)).toBeNull();
    await expect(
      new JwtVerifier({ ...access, audience: false }).verify(
        links.sign(request),
      ),
    ).rejects.toThrow();
  });
});
