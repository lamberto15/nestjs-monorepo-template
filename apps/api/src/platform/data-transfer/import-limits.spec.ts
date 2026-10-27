import type { ConfigService } from '@nestjs/config';
import type { CoreEnv } from '../../core/config/core.env.js';
import type { Principal } from '../../iam/auth/principal.js';
import type { SettingsService } from '../settings/settings.service.js';
import {
  DATA_TRANSFER_IMPORT_MAX_MIB,
  DATA_TRANSFER_IMPORT_MAX_ROWS,
} from './data-transfer.settings.js';
import { importLimits, restrictImportLimits } from './import-limits.js';

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

  it('uses tenant and platform values below the environment ceilings', async () => {
    await expect(
      importLimits(
        resolveSettings(
          { value: 20, source: 'tenant' },
          { value: 500_000, source: 'platform' },
        ),
        config(),
        principal,
      ),
    ).resolves.toEqual({ maxBytes: 20 * 1024 * 1024, maxRows: 500_000 });
  });

  it('caps stored values above the environment ceilings', async () => {
    await expect(
      importLimits(
        resolveSettings(
          { value: 1_000_000, source: 'tenant' },
          { value: 1e12, source: 'tenant' },
        ),
        config(),
        principal,
      ),
    ).resolves.toEqual({ maxBytes: 50 * 1024 * 1024, maxRows: 1_000_000 });
  });
});

describe('restrictImportLimits', () => {
  function restrictions() {
    const checks = new Map<string, (value: number) => string | undefined>();
    const settings = {
      restrict: (
        declaration: { key: string },
        check: (value: number) => string | undefined,
      ) => checks.set(declaration.key, check),
    } as unknown as SettingsService;
    restrictImportLimits(settings, {
      get: (key: string) =>
        key === 'IMPORT_MAX_BYTES' ? 50 * 1024 * 1024 : 1_000_000,
    } as unknown as ConfigService<CoreEnv, true>);
    return {
      size: checks.get(DATA_TRANSFER_IMPORT_MAX_MIB.key)!,
      rows: checks.get(DATA_TRANSFER_IMPORT_MAX_ROWS.key)!,
    };
  }

  it('allows values up to the environment ceilings', () => {
    const { size, rows } = restrictions();
    expect(size(50)).toBeUndefined();
    expect(rows(1_000_000)).toBeUndefined();
  });

  it('refuses values above the environment ceilings', () => {
    const { size, rows } = restrictions();
    expect(size(51)).toMatch(/IMPORT_MAX_BYTES/);
    expect(rows(1_000_001)).toMatch(/IMPORT_MAX_ROWS/);
  });
});
