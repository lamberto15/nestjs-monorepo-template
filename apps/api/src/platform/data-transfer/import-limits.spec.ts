import type { ConfigService } from '@nestjs/config';
import type { CoreEnv } from '../../core/config/core.env.js';
import type { Principal } from '../../iam/auth/principal.js';
import type { SettingsService } from '../settings/settings.service.js';
import { importLimits } from './import-limits.js';

const principal = {
  kind: 'client',
  id: 'client-1',
  tenantId: '00000000-0000-4000-8000-000000000001',
} as Principal;

describe('importLimits', () => {
  const defaults = {
    maxMiB: 50,
    maxRows: 1_000_000,
  };

  function resolveSettings(
    size: { value: number; source: string } = {
      value: defaults.maxMiB,
      source: 'default',
    },
    rows: { value: number; source: string } = {
      value: defaults.maxRows,
      source: 'default',
    },
  ) {
    return {
      resolve: vi.fn().mockResolvedValueOnce(size).mockResolvedValueOnce(rows),
    } as unknown as SettingsService;
  }

  const config = (bytes = 50 * 1024 * 1024, rows = 1_000_000) =>
    ({
      get: (key: string) => (key === 'IMPORT_MAX_BYTES' ? bytes : rows),
    }) as unknown as ConfigService<CoreEnv, true>;

  it('uses environment defaults while settings still resolve to their code defaults', async () => {
    await expect(
      importLimits(
        resolveSettings(),
        config(75 * 1024 * 1024, 2_000_000),
        principal,
      ),
    ).resolves.toEqual({ maxBytes: 75 * 1024 * 1024, maxRows: 2_000_000 });
  });

  it('uses tenant and platform values as runtime settings, including above environment defaults', async () => {
    await expect(
      importLimits(
        resolveSettings(
          { value: 120, source: 'tenant' },
          { value: 3_000_000, source: 'platform' },
        ),
        config(),
        principal,
      ),
    ).resolves.toEqual({ maxBytes: 120 * 1024 * 1024, maxRows: 3_000_000 });
  });
});
