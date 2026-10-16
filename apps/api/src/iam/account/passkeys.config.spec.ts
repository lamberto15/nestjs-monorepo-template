import {
  androidOrigin,
  type PasskeyEnv,
  passkeyEnvIssues,
  passkeySettings,
} from './passkeys.config.js';

const FINGERPRINT = Array.from({ length: 32 }, () => 'AB').join(':');

const env = (overrides: Partial<PasskeyEnv> = {}): PasskeyEnv => ({
  NODE_ENV: 'production',
  APP_URL: 'https://api.example.com',
  WEB_URL: 'https://app.example.com',
  SERVICE_NAME: 'Example',
  PASSKEYS: true,
  PASSKEY_RP_ID: undefined,
  PASSKEY_RP_NAME: undefined,
  PASSKEY_ORIGINS: [],
  PASSKEY_CHALLENGE_TTL_SECONDS: 120,
  PASSKEY_ANDROID_APPS: [],
  PASSKEY_APPLE_APPS: [],
  ...overrides,
});

describe('passkey relying party', () => {
  it("defaults to the web app's host and origin", () => {
    expect(passkeySettings(env())).toMatchObject({
      rpId: 'app.example.com',
      rpName: 'Example',
      origins: ['https://app.example.com'],
    });
    expect(passkeySettings(env({ WEB_URL: undefined }))).toMatchObject({
      rpId: 'api.example.com',
      origins: ['https://api.example.com'],
    });
    expect(passkeyEnvIssues(env())).toEqual([]);
  });

  it('takes a parent domain as RP ID, with more origins under it', () => {
    const settings = passkeySettings(
      env({
        PASSKEY_RP_ID: 'Example.com',
        PASSKEY_ORIGINS: ['https://admin.example.com'],
      }),
    );
    expect(settings.rpId).toBe('example.com');
    expect(settings.origins).toEqual([
      'https://app.example.com',
      'https://admin.example.com',
    ]);
    expect(
      passkeyEnvIssues(
        env({
          PASSKEY_RP_ID: 'example.com',
          PASSKEY_ORIGINS: ['https://admin.example.com'],
        }),
      ),
    ).toEqual([]);
  });

  it("adds an Android app's origin from its certificate's fingerprint", () => {
    const settings = passkeySettings(
      env({
        PASSKEY_ANDROID_APPS: [`com.example.app:${FINGERPRINT.toLowerCase()}`],
      }),
    );
    expect(settings.androidApps).toEqual([
      { packageName: 'com.example.app', fingerprint: FINGERPRINT },
    ]);
    const origin = androidOrigin(FINGERPRINT);
    expect(origin).toBe(
      `android:apk-key-hash:${Buffer.alloc(32, 0xab).toString('base64url')}`,
    );
    expect(settings.origins).toContain(origin);
  });

  it('refuses an origin outside the RP ID, in every environment', () => {
    for (const NODE_ENV of ['production', 'development'] as const) {
      expect(
        passkeyEnvIssues(
          env({ NODE_ENV, PASSKEY_ORIGINS: ['https://example.org'] }),
        ).map(([variable]) => variable),
      ).toEqual(['PASSKEY_RP_ID']);
      // "evilapp.example.com" is not under "app.example.com".
      expect(
        passkeyEnvIssues(
          env({ NODE_ENV, PASSKEY_ORIGINS: ['https://evilapp.example.com'] }),
        ),
      ).toHaveLength(1);
    }
  });

  it('refuses origins that are not origins', () => {
    expect(
      passkeyEnvIssues(
        env({ PASSKEY_ORIGINS: ['https://app.example.com/login'] }),
      ),
    ).toEqual([['PASSKEY_ORIGINS', expect.stringContaining('not an origin')]]);
    expect(
      passkeyEnvIssues(env({ PASSKEY_ORIGINS: ['app.example.com'] })),
    ).toEqual([['PASSKEY_ORIGINS', expect.stringContaining('not a URL')]]);
  });

  it('refuses localhost, addresses and plain http in production only', () => {
    const local = env({
      APP_URL: 'http://localhost:3000',
      WEB_URL: 'http://localhost:5173',
    });
    expect(
      passkeyEnvIssues(local)
        .map(([variable]) => variable)
        .sort(),
    ).toEqual(['PASSKEY_ORIGINS', 'PASSKEY_RP_ID']);
    expect(passkeyEnvIssues({ ...local, NODE_ENV: 'development' })).toEqual([]);
    expect(
      passkeyEnvIssues(
        env({ WEB_URL: 'https://10.0.0.5', APP_URL: 'https://10.0.0.5' }),
      ).map(([variable]) => variable),
    ).toEqual(['PASSKEY_RP_ID']);
    expect(
      passkeyEnvIssues(env({ WEB_URL: 'https://[::1]' })).map(
        ([variable]) => variable,
      ),
    ).toContain('PASSKEY_RP_ID');
    // A host name made of hex letters is a host name, not an IPv6 address.
    expect(
      passkeyEnvIssues(env({ WEB_URL: 'https://cafe', PASSKEY_RP_ID: 'cafe' })),
    ).toEqual([]);
  });

  it('checks nothing when passkeys are off', () => {
    expect(
      passkeyEnvIssues(
        env({ PASSKEYS: false, PASSKEY_ORIGINS: ['https://example.org'] }),
      ),
    ).toEqual([]);
  });
});
