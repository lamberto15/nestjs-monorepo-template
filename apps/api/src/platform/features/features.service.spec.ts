import type { ConfigService } from '@nestjs/config';
import type { PdfRenderer } from '../documents/pdf-renderer.js';
import type { AiProvider } from '../ai/ai-provider.js';
import type { ModeService } from '../mode/mode.service.js';
import { FeaturesService } from './features.service.js';

const SWITCHES = ['REALTIME', 'WEBHOOKS', 'REPORTS', 'USAGE'] as const;

/** A service over `env` (what ConfigService returns) and a renderer that is `documents` or not. */
function service(
  env: Record<string, unknown> = {},
  documents = false,
  ai = false,
) {
  const values: Record<string, unknown> = {
    IMPERSONATION: false,
    AUTH_MFA: true,
    API_CLIENTS: true,
    PASSKEYS: true,
    AUTH_SIGN_UP: false,
    AUTH_MAGIC_LINK: true,
    EXCHANGE_RATES_FETCH: true,
    STORAGE_DRIVER: 'local',
    TENANCY: 'multi',
    LOCALES: ['en', 'de'],
    ...env,
  };
  const config = {
    get: (key: string) => values[key],
  } as unknown as ConfigService<never, true>;
  return new FeaturesService(
    config,
    {
      enabled: documents,
    } as unknown as PdfRenderer,
    { enabled: ai } as unknown as AiProvider,
    { current: () => 'normal' } as unknown as ModeService,
  );
}

describe('FeaturesService', () => {
  const saved = Object.fromEntries(SWITCHES.map((n) => [n, process.env[n]]));
  afterEach(() => {
    for (const name of SWITCHES) {
      if (saved[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved[name];
      }
    }
  });

  it('reports the defaults: platform switches on, the IAM ones as configured', () => {
    for (const name of SWITCHES) {
      delete process.env[name];
    }
    expect(service().current()).toEqual({
      realtime: true,
      webhooks: true,
      reports: true,
      usage: true,
      impersonation: false,
      mfa: true,
      apiClients: true,
      passkeys: true,
      signUp: false,
      magicLink: true,
      documents: false,
      presignedUploads: false,
      ai: false,
      exchangeRates: true,
      mode: 'normal',
      tenancy: 'multi',
      locales: ['en', 'de'],
    });
  });

  it.each([
    ['REALTIME', 'realtime'],
    ['WEBHOOKS', 'webhooks'],
    ['REPORTS', 'reports'],
    ['USAGE', 'usage'],
  ] as const)('reads %s=off the way the module does', (name, key) => {
    process.env[name] = 'off';
    expect(service().current()[key]).toBe(false);
    process.env[name] = 'OFF';
    expect(service().current()[key]).toBe(false);
    process.env[name] = 'on';
    expect(service().current()[key]).toBe(true);
  });

  it('follows the validated IAM configuration', () => {
    expect(
      service({
        IMPERSONATION: true,
        AUTH_MFA: false,
        API_CLIENTS: false,
        PASSKEYS: false,
        AUTH_SIGN_UP: true,
        AUTH_MAGIC_LINK: false,
        TENANCY: 'single',
        LOCALES: ['ar'],
      }).current(),
    ).toMatchObject({
      impersonation: true,
      mfa: false,
      apiClients: false,
      passkeys: false,
      signUp: true,
      magicLink: false,
      tenancy: 'single',
      locales: ['ar'],
    });
  });

  it('says documents are on while the PDF renderer is (GOTENBERG_URL is set)', () => {
    expect(service({}, true).current().documents).toBe(true);
    expect(service({}, false).current().documents).toBe(false);
  });

  it('says ai is on while the AI provider is (ANTHROPIC_API_KEY is set)', () => {
    expect(service({}, false, true).current().ai).toBe(true);
    expect(service({}, false, false).current().ai).toBe(false);
  });

  it('says presignedUploads are on with the S3 driver only (the routes refuse the others)', () => {
    expect(service({ STORAGE_DRIVER: 's3' }).current().presignedUploads).toBe(
      true,
    );
    for (const driver of ['local', 'memory']) {
      expect(
        service({ STORAGE_DRIVER: driver }).current().presignedUploads,
      ).toBe(false);
    }
  });
});
