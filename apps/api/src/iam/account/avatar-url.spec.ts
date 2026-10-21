import { avatarUrl } from './avatar-url.js';

const ID = '0199a3f2-0000-7000-8000-000000000001';

describe('avatarUrl', () => {
  it('is null without a picture', () => {
    expect(avatarUrl(ID, null)).toBeNull();
  });

  it("is the person's avatar route, versioned by the file's name", () => {
    expect(avatarUrl(ID, `accounts/${ID}/avatar/9f1c.png`)).toBe(
      `/v1/people/${ID}/avatar?v=9f1c`,
    );
  });

  it('is a new address for a new file', () => {
    expect(avatarUrl(ID, `accounts/${ID}/avatar/aaa.png`)).not.toBe(
      avatarUrl(ID, `accounts/${ID}/avatar/bbb.png`),
    );
  });
});
