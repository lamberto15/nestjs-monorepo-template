import { createHash, createHmac } from 'node:crypto';
import { scramSha256Verifier } from './roles.js';

/**
 * The verifier `CREATE ROLE … PASSWORD` receives (so the password never
 * reaches the server), checked against RFC 7677's example exchange: user
 * "user", password "pencil", the RFC's salt and 4096 iterations. Our
 * StoredKey must verify the RFC's ClientProof and our ServerKey must produce
 * its ServerSignature, which is what a PostgreSQL server does with the
 * stored verifier at every connection. The e2e suite then connects through
 * a scram server with verifiers made here (database-roles.e2e-spec.ts).
 */
describe('scramSha256Verifier', () => {
  const salt = Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64');
  const authMessage =
    'n=user,r=rOprNGfwEbeRWgbNEkqO,' +
    'r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,' +
    'c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0';
  const clientProof = Buffer.from(
    'dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=',
    'base64',
  );
  const serverSignature = '6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=';

  const parse = (verifier: string) => {
    const match =
      /^SCRAM-SHA-256\$(\d+):([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+)$/.exec(
        verifier,
      );
    if (!match) {
      throw new Error(`not a verifier: ${verifier}`);
    }
    return {
      iterations: Number(match[1]),
      salt: match[2],
      storedKey: Buffer.from(match[3], 'base64'),
      serverKey: Buffer.from(match[4], 'base64'),
    };
  };

  it("has PostgreSQL's format: SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>", () => {
    const {
      iterations,
      salt: encoded,
      storedKey,
      serverKey,
    } = parse(scramSha256Verifier('pencil', salt));
    expect(iterations).toBe(4096);
    expect(encoded).toBe('W22ZaJ0SNY7soEsUEjb6gQ==');
    expect(storedKey).toHaveLength(32);
    expect(serverKey).toHaveLength(32);
  });

  it("verifies RFC 7677's ClientProof with its StoredKey, as the server does", () => {
    const { storedKey } = parse(scramSha256Verifier('pencil', salt));
    const clientSignature = createHmac('sha256', storedKey)
      .update(authMessage)
      .digest();
    const clientKey = Buffer.from(
      clientProof.map((byte, index) => byte ^ clientSignature[index]),
    );
    expect(createHash('sha256').update(clientKey).digest()).toEqual(storedKey);
  });

  it("produces RFC 7677's ServerSignature with its ServerKey", () => {
    const { serverKey } = parse(scramSha256Verifier('pencil', salt));
    expect(
      createHmac('sha256', serverKey).update(authMessage).digest('base64'),
    ).toBe(serverSignature);
  });

  it('salts every call differently', () => {
    expect(scramSha256Verifier('pencil')).not.toBe(
      scramSha256Verifier('pencil'),
    );
  });
});
