import {
  generateSenderSecret,
  SenderSecretCipher,
} from './incoming-sender-secrets.js';

const KEY_A = 'a'.repeat(40);
const KEY_B = 'b'.repeat(40);

describe('incoming senders’ secrets at rest', () => {
  it('seals with the first key, opens with any, and binds a secret to its sender', () => {
    const secret = generateSenderSecret();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);

    const old = new SenderSecretCipher([KEY_A]);
    const sealed = old.seal('sender-1', secret);
    expect(sealed).toMatch(/^sealed\.v1\./);
    expect(sealed).not.toContain(secret);
    expect(old.open('sender-1', sealed)).toBe(secret);

    // Rotated keys: the new one seals, the old one still opens.
    const rotated = new SenderSecretCipher([KEY_B, KEY_A]);
    expect(rotated.open('sender-1', sealed)).toBe(secret);
    expect(rotated.seal('sender-1', secret).split('.')[2]).not.toBe(
      sealed.split('.')[2],
    );

    // Copied to another sender's row, or opened without its key: nothing.
    expect(old.open('sender-2', sealed)).toBeUndefined();
    expect(
      new SenderSecretCipher([KEY_B]).open('sender-1', sealed),
    ).toBeUndefined();
    expect(new SenderSecretCipher().open('sender-1', sealed)).toBeUndefined();
    // A tampered tag: its first character changed (a fixed suffix could
    // equal the real one, or differ only in base64's unused bits).
    const parts = sealed.split('.');
    const tag = parts.at(-1)!;
    parts[parts.length - 1] = `${tag[0] === 'A' ? 'B' : 'A'}${tag.slice(1)}`;
    expect(old.open('sender-1', parts.join('.'))).toBeUndefined();
  });

  it('stores as it is without keys, as the outgoing endpoints do, and opens a plaintext value after keys are set', () => {
    const plain = new SenderSecretCipher();
    expect(plain.seal('s', 'whsec_x')).toBe('whsec_x');
    expect(plain.open('s', 'whsec_x')).toBe('whsec_x');
    expect(new SenderSecretCipher([KEY_A]).open('s', 'whsec_x')).toBe(
      'whsec_x',
    );
  });

  it('refuses a key that is too short', () => {
    expect(() => new SenderSecretCipher(['short'])).toThrow(/at least 32/);
  });
});
